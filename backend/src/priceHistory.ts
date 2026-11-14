// Fetches OHLC candles for the XLM/USDC pair, with a small in-memory cache so the scheduler
// (which ticks far more often than any resolution bucket changes) doesn't hammer the upstream
// API on every pass.
//
// The candle source is selected by MARKET_DATA_SOURCE:
//  - `stellar-testnet` (default): Horizon testnet trade_aggregations. Matches the venue agents
//    actually execute on, but the testnet XLM/USDC book is synthetic — its price has no
//    relationship to the real market.
//  - `stellar-mainnet`: Horizon pubnet trade_aggregations for XLM / Circle USDC — the real SDEX
//    market, read-only. Falls back to Binance if pubnet errors or returns too few candles.
//  - `binance`: Binance public XLMUSDT klines (no API key needed).
// Agents still only ever *execute* on testnet; this switch only changes what they reason over.
import type { Candle } from './strategies/index.js';

const HORIZON_TESTNET_URL = 'https://horizon-testnet.stellar.org';
const HORIZON_MAINNET_URL = 'https://horizon.stellar.org';
const BINANCE_URLS = ['https://data-api.binance.vision', 'https://api.binance.com'];

/** Circle's official testnet USDC issuer (same one used client-side — see
 *  apps/web/app/lib/stellar.ts TESTNET_USDC_ISSUER). Duplicated here since the backend is a
 *  separate deployable service with no dependency on the web app. */
export const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

/** Circle's official mainnet USDC issuer (centre.io). Read-only use: price discovery only. */
export const MAINNET_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

export type MarketDataSource = 'stellar-testnet' | 'stellar-mainnet' | 'binance';

/** Minimum candles a source must return before mainnet stops falling back to Binance — matches
 *  decisionEngine.buildMarketContext's own floor, below which no decision is made at all. */
const MIN_USABLE_CANDLES = 30;

export function getMarketDataSource(): MarketDataSource {
  const raw = process.env.MARKET_DATA_SOURCE || 'stellar-testnet';
  if (raw !== 'stellar-testnet' && raw !== 'stellar-mainnet' && raw !== 'binance') {
    throw new Error(`Invalid MARKET_DATA_SOURCE: ${raw} (expected stellar-testnet | stellar-mainnet | binance)`);
  }
  return raw;
}

/** Horizon endpoint + USDC issuer for the configured Stellar source — shared with priceFeed.ts so
 *  the SSE trade stream watches the same order book the candles come from. Binance has no Horizon
 *  equivalent, so it maps to pubnet (the closest real-market stream). */
export function getHorizonMarket(): { horizonUrl: string; usdcIssuer: string } {
  return getMarketDataSource() === 'stellar-testnet'
    ? { horizonUrl: HORIZON_TESTNET_URL, usdcIssuer: TESTNET_USDC_ISSUER }
    : { horizonUrl: HORIZON_MAINNET_URL, usdcIssuer: MAINNET_USDC_ISSUER };
}

interface CacheEntry {
  fetchedAt: number;
  candles: Candle[];
  source: MarketDataSource;
}

const cache = new Map<string, CacheEntry>();

// Defensive cap to prevent unbounded growth if the system ever adds many distinct
// (pair, resolution, limit) tuples. The cache is self-cleaning on reads (stale entries
// are replaced, never served), so this sweep is purely a memory backstop — it fires
// at most once per sweep interval and evicts the oldest entries only when above the cap.
const MAX_CACHE_SIZE = 50;
let lastSweepAt = 0;
const SWEEP_INTERVAL_MS = 60_000;

function maybeSweep(): void {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  if (cache.size <= MAX_CACHE_SIZE) return;
  const sorted = [...cache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
  const toEvict = sorted.slice(0, sorted.length - MAX_CACHE_SIZE);
  for (const [key] of toEvict) cache.delete(key);
}

interface TradeAggregationRecord {
  timestamp: string;
  open: string;
  high: string;
  low: string;
  close: string;
  base_volume: string;
}

// Horizon requires resolution to be one of a fixed set of durations; Binance has its own named
// intervals. Both snap up to the nearest supported bucket so arbitrary intervalSeconds still work.
const BUCKETS: { ms: number; binance: string }[] = [
  { ms: 60_000, binance: '1m' },
  { ms: 300_000, binance: '5m' },
  { ms: 900_000, binance: '15m' },
  { ms: 3_600_000, binance: '1h' },
  { ms: 86_400_000, binance: '1d' },
  { ms: 604_800_000, binance: '1w' },
];

function snapBucket(resolutionSeconds: number): { ms: number; binance: string } {
  const resolutionMs = resolutionSeconds * 1000;
  return BUCKETS.find((b) => b.ms >= resolutionMs) ?? BUCKETS[BUCKETS.length - 1];
}

async function fetchHorizonCandles(horizonUrl: string, usdcIssuer: string, bucketMs: number, limit: number): Promise<Candle[]> {
  const endTime = Date.now();
  const startTime = endTime - bucketMs * limit;

  const url = new URL(`${horizonUrl}/trade_aggregations`);
  url.searchParams.set('base_asset_type', 'native');
  url.searchParams.set('counter_asset_type', 'credit_alphanum4');
  url.searchParams.set('counter_asset_code', 'USDC');
  url.searchParams.set('counter_asset_issuer', usdcIssuer);
  url.searchParams.set('resolution', String(bucketMs));
  url.searchParams.set('start_time', String(startTime));
  url.searchParams.set('end_time', String(endTime));
  url.searchParams.set('order', 'asc');
  url.searchParams.set('limit', String(Math.min(limit, 200)));

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`Horizon trade_aggregations request failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { _embedded?: { records?: TradeAggregationRecord[] } };
  const records = data._embedded?.records ?? [];

  return records.map((r) => ({
    time: Number(r.timestamp),
    open: parseFloat(r.open),
    high: parseFloat(r.high),
    low: parseFloat(r.low),
    close: parseFloat(r.close),
    volume: parseFloat(r.base_volume),
  }));
}

async function fetchBinanceCandles(interval: string, limit: number): Promise<Candle[]> {
  let lastError: unknown;
  for (const base of BINANCE_URLS) {
    try {
      const url = `${base}/api/v3/klines?symbol=XLMUSDT&interval=${interval}&limit=${Math.min(limit, 1000)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`Binance klines request failed: ${res.status} ${res.statusText}`);
      // [openTime, open, high, low, close, volume, closeTime, ...]
      const rows = (await res.json()) as [number, string, string, string, string, string, ...unknown[]][];
      return rows.map((k) => ({
        time: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }));
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Like getCandles but also reports which source actually served the candles (mainnet can fall
 *  back to Binance) — used by the live demo to label its data honestly. */
export async function getCandlesWithSource(
  pair: string,
  resolutionSeconds: number,
  limit: number
): Promise<{ candles: Candle[]; source: MarketDataSource }> {
  maybeSweep();

  const configured = getMarketDataSource();
  const cacheKey = `${configured}:${pair}:${resolutionSeconds}:${limit}`;
  const cached = cache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < resolutionSeconds * 1000) {
    return { candles: cached.candles, source: cached.source };
  }

  if (pair !== 'XLM/USDC') {
    throw new Error(`Unsupported pair: ${pair}`);
  }

  const bucket = snapBucket(resolutionSeconds);
  let candles: Candle[];
  let source: MarketDataSource = configured;

  if (configured === 'binance') {
    candles = await fetchBinanceCandles(bucket.binance, limit);
  } else if (configured === 'stellar-mainnet') {
    try {
      candles = await fetchHorizonCandles(HORIZON_MAINNET_URL, MAINNET_USDC_ISSUER, bucket.ms, limit);
      if (candles.length < MIN_USABLE_CANDLES) throw new Error(`only ${candles.length} pubnet candles`);
    } catch (err) {
      console.warn(`[priceHistory] stellar-mainnet unavailable (${err instanceof Error ? err.message : err}); falling back to binance`);
      candles = await fetchBinanceCandles(bucket.binance, limit);
      source = 'binance';
    }
  } else {
    candles = await fetchHorizonCandles(HORIZON_TESTNET_URL, TESTNET_USDC_ISSUER, bucket.ms, limit);
  }

  cache.set(cacheKey, { fetchedAt: now, candles, source });
  return { candles, source };
}

/**
 * Fetches up to `limit` OHLC candles at `resolutionSeconds` granularity for `pair` (currently
 * only 'XLM/USDC' is supported) from the configured MARKET_DATA_SOURCE. Results are cached
 * in-process; a cached response is reused until it's older than one resolution bucket, since
 * the upstream won't have a new completed bucket before then anyway.
 */
export async function getCandles(pair: string, resolutionSeconds: number, limit: number): Promise<Candle[]> {
  return (await getCandlesWithSource(pair, resolutionSeconds, limit)).candles;
}

/** Latest close price for a pair — used for unrealized P&L calculations. Falls back to the
 *  most recent cached/fetched candle set at a coarse 5-minute resolution. */
export async function getLatestPrice(pair: string): Promise<number | null> {
  const candles = await getCandles(pair, 300, 50);
  if (candles.length === 0) return null;
  return candles[candles.length - 1].close;
}
