// Kairos live demo server — a standalone, zero-infrastructure slice of the real decision stack.
//
// What is real:
//  - Market data: live XLM/USDC candles from the Stellar *mainnet* SDEX (Horizon pubnet
//    trade_aggregations, Binance fallback) via the production priceHistory.ts, plus a live SSE
//    stream of every pubnet XLM/USDC trade and a Binance XLMUSDT cross-check ticker.
//  - AI: the production decisionEngine.ts role agents (Strategic / Yield / Balancer) and
//    intentParser.ts, running through llmProviders.ts with Gemini first in the chain.
//  - Indicators / regime / strategy catalogue: the production code, unchanged.
//
// What is simulated (and labelled as such in the UI):
//  - Execution: a paper portfolio filled at the live price with a fixed slippage estimate. No
//    wallet, no keys, no transactions — nothing here can move funds.
//  - Yield venue APYs: decisionEngine's own simulated venue table (volatility-modulated).
//
// Needs only GEMINI_API_KEY (backend/.env). No Postgres, Turnkey, Freighter or JWT secret.
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { Asset, Horizon } from '@stellar/stellar-sdk';
import { buildMarketContext, decideBalancer, decideStrategic, decideYield, currentYieldVenues } from '../src/decisionEngine.js';
import { getCandlesWithSource, getMarketDataSource, MAINNET_USDC_ISSUER } from '../src/priceHistory.js';
import { parseIntent } from '../src/intentParser.js';
import { describeProvider } from '../src/llmProviders.js';
import { listStrategyMeta } from '../src/strategies/index.js';
import type { AgentDecision, MarketContext } from '../src/types.js';
import type { AgentSpec, RiskLevel } from '@kairos/types';

// Demo defaults: real market data, Gemini first. Both are read lazily (at call time) by the
// imported modules, so setting them here — after the hoisted imports — still takes effect.
process.env.MARKET_DATA_SOURCE ??= 'stellar-mainnet';
process.env.LLM_PROVIDER_ORDER ??= 'gemini';

const PAIR = 'XLM/USDC';
const PORT = Number(process.env.DEMO_PORT) || 4100;
const SLIPPAGE_PCT = 0.1;
const MIN_CYCLE_GAP_MS = 20_000;

// ── Policy ───────────────────────────────────────────────────────────────────────────────
// The policy gate is deterministic and sits between the AI and execution — the same contract as
// the real system ("AI proposes, the chain disposes"); here the gate stands in for the on-chain
// policy contract.
interface Policy {
  riskLevel: RiskLevel;
  minConfidence: number;
  maxTradePct: number; // max % of portfolio value moved per trade
  driftPct: number; // balancer drift threshold
  targetXlmPct: number;
}

const POLICIES: Record<RiskLevel, Policy> = {
  conservative: { riskLevel: 'conservative', minConfidence: 0.75, maxTradePct: 5, driftPct: 10, targetXlmPct: 30 },
  balanced: { riskLevel: 'balanced', minConfidence: 0.65, maxTradePct: 10, driftPct: 7.5, targetXlmPct: 50 },
  aggressive: { riskLevel: 'aggressive', minConfidence: 0.55, maxTradePct: 20, driftPct: 5, targetXlmPct: 70 },
};

// ── Paper portfolio ────────────────────────────────────────────────────────────────────────
interface Fill {
  id: number;
  at: number;
  side: 'buy' | 'sell';
  agent: 'strategic' | 'balancer';
  xlm: number;
  usdc: number;
  price: number;
  reason: string;
}

interface GateVerdict {
  agent: 'strategic' | 'yield' | 'balancer';
  approved: boolean;
  reason: string;
}

interface CycleRecord {
  id: number;
  at: number;
  price: number;
  source: string;
  regime: string;
  decisions: Record<'strategic' | 'yield' | 'balancer', AgentDecision & { model: string | null; latencyMs: number }>;
  gate: GateVerdict[];
  fill: Fill | null;
}

const state = {
  initialized: false,
  usdc: 0,
  xlm: 0,
  startValueUsd: 2000,
  startPrice: 0,
  policy: POLICIES.balanced,
  spec: null as AgentSpec | null,
  fills: [] as Fill[],
  cycles: [] as CycleRecord[],
  lastPrice: 0,
  cycleRunning: false,
  lastCycleAt: 0,
};

let fillSeq = 0;
let cycleSeq = 0;

function initPortfolio(price: number): void {
  // Start at the policy's target allocation.
  const xlmUsd = (state.startValueUsd * state.policy.targetXlmPct) / 100;
  state.xlm = xlmUsd / price;
  state.usdc = state.startValueUsd - xlmUsd;
  state.startPrice = price;
  state.initialized = true;
}

function valuation(price: number) {
  const xlmUsd = state.xlm * price;
  const total = xlmUsd + state.usdc;
  const xlmPct = total > 0 ? (xlmUsd / total) * 100 : 0;
  // Buy-and-hold benchmark: what the starting allocation would be worth now untouched.
  const startXlm = ((state.startValueUsd * state.policy.targetXlmPct) / 100) / (state.startPrice || price);
  const holdValue = startXlm * price + (state.startValueUsd - startXlm * (state.startPrice || price));
  return {
    xlm: state.xlm,
    usdc: state.usdc,
    xlmUsd,
    totalUsd: total,
    xlmPct,
    usdcPct: 100 - xlmPct,
    pnlUsd: total - state.startValueUsd,
    pnlPct: ((total - state.startValueUsd) / state.startValueUsd) * 100,
    vsHoldUsd: total - holdValue,
  };
}

function executePaper(side: 'buy' | 'sell', usdAmount: number, price: number, agent: Fill['agent'], reason: string): Fill | null {
  if (usdAmount < 1) return null;
  const slip = SLIPPAGE_PCT / 100;
  let xlm: number;
  let usdc: number;
  let fillPrice: number;
  if (side === 'buy') {
    usdc = Math.min(usdAmount, state.usdc);
    fillPrice = price * (1 + slip);
    xlm = usdc / fillPrice;
    state.usdc -= usdc;
    state.xlm += xlm;
  } else {
    fillPrice = price * (1 - slip);
    xlm = Math.min(usdAmount / price, state.xlm);
    usdc = xlm * fillPrice;
    state.xlm -= xlm;
    state.usdc += usdc;
  }
  if (usdc < 1) return null;
  const fill: Fill = { id: ++fillSeq, at: Date.now(), side, agent, xlm, usdc, price: fillPrice, reason };
  state.fills.unshift(fill);
  state.fills = state.fills.slice(0, 50);
  return fill;
}

// ── SSE fan-out ────────────────────────────────────────────────────────────────────────────
const clients = new Set<express.Response>();

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

// Live pubnet SDEX trade stream for XLM/USDC (Circle). Read-only.
function startTradeStream(): void {
  const server = new Horizon.Server('https://horizon.stellar.org');
  const base = Asset.native();
  const counter = new Asset('USDC', MAINNET_USDC_ISSUER);
  const open = () =>
    server
      .trades()
      .forAssetPair(base, counter)
      .cursor('now')
      .stream({
        onmessage: (record) => {
          const t = record as unknown as {
            id: string;
            ledger_close_time: string;
            base_amount: string;
            counter_amount: string;
            base_asset_type: string;
            base_is_seller: boolean;
          };
          let xlm = parseFloat(t.base_amount);
          let usdc = parseFloat(t.counter_amount);
          // Horizon reports trades in the pair's canonical orientation, which may be USDC/XLM.
          if (t.base_asset_type !== 'native') [xlm, usdc] = [usdc, xlm];
          if (!(xlm > 0) || !(usdc > 0)) return;
          const price = usdc / xlm;
          // Drop dust/outlier fills (tiny path-payment crosses) that would distort the ticker.
          if (state.lastPrice > 0 && Math.abs(price / state.lastPrice - 1) > 0.05) return;
          state.lastPrice = price;
          broadcast('trade', { id: t.id, at: Date.parse(t.ledger_close_time), price, xlm, usdc, side: t.base_is_seller ? 'sell' : 'buy' });
        },
        onerror: () => {
          /* EventSource reconnects on its own; a hard error is logged once below by the watchdog */
        },
      });
  open();
}

// Binance cross-check ticker (independent venue — shows the SDEX price is the real market).
async function pollBinance(): Promise<void> {
  try {
    const res = await fetch('https://data-api.binance.vision/api/v3/ticker/24hr?symbol=XLMUSDT', { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const t = (await res.json()) as { lastPrice: string; priceChangePercent: string; quoteVolume: string; highPrice: string; lowPrice: string };
    broadcast('ticker', {
      venue: 'binance',
      price: parseFloat(t.lastPrice),
      change24hPct: parseFloat(t.priceChangePercent),
      high24h: parseFloat(t.highPrice),
      low24h: parseFloat(t.lowPrice),
      quoteVolume24h: parseFloat(t.quoteVolume),
      at: Date.now(),
    });
  } catch {
    /* transient — next poll retries */
  }
}

// ── Decision cycle ────────────────────────────────────────────────────────────────────────
async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t };
}

function marketSummary(ctx: MarketContext, source: string) {
  return {
    pair: ctx.pair,
    price: ctx.price,
    changePct: ctx.change24h,
    volume: ctx.volume24h,
    indicators: ctx.indicators,
    regime: ctx.regime,
    source,
  };
}

async function runCycle(intervalSeconds: number): Promise<CycleRecord> {
  const { source } = await getCandlesWithSource(PAIR, intervalSeconds, 200);
  const ctx = await buildMarketContext(PAIR, intervalSeconds);
  if (!ctx) throw new Error('Not enough live candles to build a market context (need ≥30).');
  if (!state.initialized) initPortfolio(ctx.price);
  state.lastPrice = state.lastPrice || ctx.price;

  const id = ++cycleSeq;
  const policy = state.policy;
  broadcast('cycle', { id, phase: 'market', market: marketSummary(ctx, source) });

  // Sequential, not parallel: free-tier Gemini quotas punish bursts, and the UI streams each
  // agent's result as it lands anyway.
  broadcast('cycle', { id, phase: 'thinking', agent: 'strategic' });
  const strategic = await timed(() => decideStrategic(ctx));
  broadcast('cycle', { id, phase: 'decided', agent: 'strategic', decision: { ...strategic.value, model: modelLabel(strategic.value), latencyMs: strategic.ms } });

  const before = valuation(ctx.price);
  broadcast('cycle', { id, phase: 'thinking', agent: 'yield' });
  const yieldD = await timed(() => decideYield(ctx, before.usdc));
  broadcast('cycle', { id, phase: 'decided', agent: 'yield', decision: { ...yieldD.value, model: modelLabel(yieldD.value), latencyMs: yieldD.ms } });

  broadcast('cycle', { id, phase: 'thinking', agent: 'balancer' });
  const current = { xlmPct: before.xlmPct, usdcPct: before.usdcPct };
  const target = { xlmPct: policy.targetXlmPct, usdcPct: 100 - policy.targetXlmPct };
  const balancer = await timed(() => decideBalancer(ctx, current, target, policy.driftPct));
  broadcast('cycle', { id, phase: 'decided', agent: 'balancer', decision: { ...balancer.value, model: modelLabel(balancer.value), latencyMs: balancer.ms } });

  // ── Policy gate (deterministic) ──
  const gate: GateVerdict[] = [];
  let fill: Fill | null = null;
  const maxTradeUsd = (before.totalUsd * policy.maxTradePct) / 100;
  const s = strategic.value;

  if (s.action === 'buy' || s.action === 'sell') {
    if (s.confidence < policy.minConfidence) {
      gate.push({ agent: 'strategic', approved: false, reason: `confidence ${pct(s.confidence)} < policy minimum ${pct(policy.minConfidence)}` });
    } else if (s.action === 'buy' && before.usdc < 1) {
      gate.push({ agent: 'strategic', approved: false, reason: 'no USDC available to buy with' });
    } else if (s.action === 'sell' && before.xlm * ctx.price < 1) {
      gate.push({ agent: 'strategic', approved: false, reason: 'no XLM available to sell' });
    } else {
      fill = executePaper(s.action, maxTradeUsd, ctx.price, 'strategic', `${s.selectedStrategy ?? 'strategy'} → ${s.action}`);
      gate.push({ agent: 'strategic', approved: Boolean(fill), reason: fill ? `approved · sized to ${policy.maxTradePct}% cap ($${maxTradeUsd.toFixed(2)})` : 'trade below $1 minimum' });
    }
  } else {
    gate.push({ agent: 'strategic', approved: false, reason: 'hold — nothing to execute' });
  }

  // Balancer acts only when the strategic agent didn't trade this cycle (one fill per cycle).
  const b = balancer.value;
  if (b.action === 'rebalance' && !fill) {
    const drift = before.xlmPct - (b.targetAllocation?.xlmPct ?? target.xlmPct);
    if (b.confidence < policy.minConfidence) {
      gate.push({ agent: 'balancer', approved: false, reason: `confidence ${pct(b.confidence)} < policy minimum ${pct(policy.minConfidence)}` });
    } else if (Math.abs(drift) <= policy.driftPct) {
      gate.push({ agent: 'balancer', approved: false, reason: `drift ${Math.abs(drift).toFixed(1)}% within ${policy.driftPct}% band` });
    } else {
      const usd = Math.min((Math.abs(drift) / 100) * before.totalUsd, maxTradeUsd);
      fill = executePaper(drift > 0 ? 'sell' : 'buy', usd, ctx.price, 'balancer', `rebalance toward ${target.xlmPct}% XLM`);
      gate.push({ agent: 'balancer', approved: Boolean(fill), reason: fill ? `approved · $${usd.toFixed(2)} toward target` : 'trade below $1 minimum' });
    }
  } else if (b.action === 'rebalance') {
    gate.push({ agent: 'balancer', approved: false, reason: 'deferred — one fill per cycle (strategic traded)' });
  } else {
    gate.push({ agent: 'balancer', approved: false, reason: 'hold — allocation within tolerance' });
  }

  const y = yieldD.value;
  gate.push({
    agent: 'yield',
    approved: false,
    reason: y.action === 'reallocate' ? `advisory only — ${y.yieldVenue ?? 'venue'} (simulated APYs, not executed)` : 'hold',
  });

  const record: CycleRecord = {
    id,
    at: Date.now(),
    price: ctx.price,
    source,
    regime: ctx.regime.regime,
    decisions: {
      strategic: { ...s, model: modelLabel(s), latencyMs: strategic.ms },
      yield: { ...y, model: modelLabel(y), latencyMs: yieldD.ms },
      balancer: { ...b, model: modelLabel(b), latencyMs: balancer.ms },
    },
    gate,
    fill,
  };
  state.cycles.unshift(record);
  state.cycles = state.cycles.slice(0, 30);
  broadcast('cycle', { id, phase: 'done', record, portfolio: valuation(ctx.price) });
  return record;
}

function modelLabel(d: AgentDecision): string | null {
  return d.llmModel ? describeProvider(d.llmModel) : null;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

// ── HTTP ───────────────────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '32kb' }));

const here = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(here, 'public')));

app.get('/api/status', (_req, res) => {
  res.json({
    marketDataSource: getMarketDataSource(),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    geminiModel: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
    providerOrder: process.env.LLM_PROVIDER_ORDER || 'default',
    strategies: listStrategyMeta().length,
    policy: state.policy,
    spec: state.spec,
  });
});

app.get('/api/market', async (req, res, next) => {
  try {
    const interval = clampInterval(Number(req.query.interval));
    const { candles, source } = await getCandlesWithSource(PAIR, interval, 200);
    const ctx = await buildMarketContext(PAIR, interval);
    if (ctx && !state.initialized) initPortfolio(ctx.price);
    if (ctx && !state.lastPrice) state.lastPrice = ctx.price;
    res.json({
      source,
      interval,
      candles,
      market: ctx ? marketSummary(ctx, source) : null,
      venues: ctx ? currentYieldVenues(ctx) : [],
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/portfolio', (_req, res) => {
  const price = state.lastPrice;
  res.json({
    initialized: state.initialized,
    price,
    policy: state.policy,
    spec: state.spec,
    valuation: state.initialized ? valuation(price) : null,
    fills: state.fills,
    cycles: state.cycles.slice(0, 10),
  });
});

app.post('/api/intent', async (req, res, next) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.slice(0, 2000) : '';
    const result = await parseIntent(text);
    if (result.status === 'ok' && result.spec) {
      state.spec = result.spec;
      state.policy = POLICIES[result.spec.riskLevel];
      // Fresh agent → fresh paper portfolio at the new target allocation.
      state.fills = [];
      state.cycles = [];
      if (state.lastPrice) initPortfolio(state.lastPrice);
    }
    res.json({ ...result, policy: state.policy });
  } catch (err) {
    next(err);
  }
});

app.post('/api/cycle', async (req, res, next) => {
  if (state.cycleRunning) return res.status(409).json({ error: 'A decision cycle is already running.' });
  const gap = Date.now() - state.lastCycleAt;
  if (gap < MIN_CYCLE_GAP_MS) {
    return res.status(429).json({ error: `Cooling down — next cycle in ${Math.ceil((MIN_CYCLE_GAP_MS - gap) / 1000)}s (protects Gemini quota).` });
  }
  state.cycleRunning = true;
  state.lastCycleAt = Date.now();
  try {
    const record = await runCycle(clampInterval(Number(req.body?.interval)));
    res.json({ record, portfolio: valuation(record.price) });
  } catch (err) {
    broadcast('cycle', { phase: 'error', error: err instanceof Error ? err.message : String(err) });
    next(err);
  } finally {
    state.cycleRunning = false;
  }
});

app.post('/api/reset', (_req, res) => {
  state.fills = [];
  state.cycles = [];
  if (state.lastPrice) initPortfolio(state.lastPrice);
  res.json({ ok: true });
});

app.get('/api/stream', (req, res) => {
  res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`event: hello\ndata: {}\n\n`);
  clients.add(res);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[demo]', message);
  if (!res.headersSent) res.status(500).json({ error: message });
});

function clampInterval(n: number): number {
  return [60, 300, 900, 3600].includes(n) ? n : 300;
}

if (!process.env.GEMINI_API_KEY) {
  console.warn('[demo] GEMINI_API_KEY is not set — agents will use the deterministic heuristic fallback.');
}

app.listen(PORT, () => {
  console.log(`\n  Kairos live demo → http://localhost:${PORT}`);
  console.log(`  market data: ${getMarketDataSource()} · LLM order: ${process.env.LLM_PROVIDER_ORDER || 'default'} · gemini model: ${process.env.GEMINI_MODEL || 'gemini-3.6-flash'}\n`);
  startTradeStream();
  void pollBinance();
  setInterval(() => void pollBinance(), 5000);
});
