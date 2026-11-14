// Kairos live demo runtime — port of backend/demo/server.ts into a module singleton for Next
// route handlers. State, the SSE client set and the background feeds (Horizon trade stream +
// Binance poll) live on globalThis so they survive dev hot-reload and start exactly once.
//
// Real: live XLM/USDC mainnet SDEX candles + trade stream, Binance ticker, Gemini-driven role
// agents (decisionEngine / intentParser, unchanged). Simulated: paper fills at the live price
// with fixed slippage, and the yield-venue APYs.
import { Asset, Horizon } from '@stellar/stellar-sdk';
import type { AgentSpec, RiskLevel } from '@kairos/types';
import { buildMarketContext, decideBalancer, decideStrategic, decideYield } from './decisionEngine';
import { getCandlesWithSource, MAINNET_USDC_ISSUER } from './priceHistory';
import { describeProvider } from './llmProviders';
import type { AgentDecision, MarketContext } from './types';

// Demo defaults: real market data, Gemini first (read lazily by the engine modules).
process.env.MARKET_DATA_SOURCE ??= 'stellar-mainnet';
process.env.LLM_PROVIDER_ORDER ??= 'gemini';

export const PAIR = 'XLM/USDC';
const SLIPPAGE_PCT = 0.1;
export const MIN_CYCLE_GAP_MS = 20_000;

// ── Policy ── deterministic gate between the AI and execution.
export interface Policy {
  riskLevel: RiskLevel;
  minConfidence: number;
  maxTradePct: number;
  driftPct: number;
  targetXlmPct: number;
}

export const POLICIES: Record<RiskLevel, Policy> = {
  conservative: { riskLevel: 'conservative', minConfidence: 0.75, maxTradePct: 5, driftPct: 10, targetXlmPct: 30 },
  balanced: { riskLevel: 'balanced', minConfidence: 0.65, maxTradePct: 10, driftPct: 7.5, targetXlmPct: 50 },
  aggressive: { riskLevel: 'aggressive', minConfidence: 0.55, maxTradePct: 20, driftPct: 5, targetXlmPct: 70 },
};

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

export interface CycleRecord {
  id: number;
  at: number;
  price: number;
  source: string;
  regime: string;
  decisions: Record<'strategic' | 'yield' | 'balancer', AgentDecision & { model: string | null; latencyMs: number }>;
  gate: GateVerdict[];
  fill: Fill | null;
}

interface DemoState {
  initialized: boolean;
  usdc: number;
  xlm: number;
  startValueUsd: number;
  startPrice: number;
  policy: Policy;
  spec: AgentSpec | null;
  fills: Fill[];
  cycles: CycleRecord[];
  lastPrice: number;
  cycleRunning: boolean;
  lastCycleAt: number;
}

interface SseClient {
  write(chunk: string): void;
}

interface DemoGlobal {
  state: DemoState;
  clients: Set<SseClient>;
  fillSeq: number;
  cycleSeq: number;
  started: boolean;
  binanceTimer?: ReturnType<typeof setInterval>;
}

const g = globalThis as unknown as { __kairosDemo?: DemoGlobal };
const demo: DemoGlobal = (g.__kairosDemo ??= {
  state: {
    initialized: false,
    usdc: 0,
    xlm: 0,
    startValueUsd: 2000,
    startPrice: 0,
    policy: POLICIES.balanced,
    spec: null,
    fills: [],
    cycles: [],
    lastPrice: 0,
    cycleRunning: false,
    lastCycleAt: 0,
  },
  clients: new Set<SseClient>(),
  fillSeq: 0,
  cycleSeq: 0,
  started: false,
});

export const state = demo.state;
export const clients = demo.clients;

export function clampInterval(n: number): number {
  return [60, 300, 900, 3600].includes(n) ? n : 300;
}

export function initPortfolio(price: number): void {
  const xlmUsd = (state.startValueUsd * state.policy.targetXlmPct) / 100;
  state.xlm = xlmUsd / price;
  state.usdc = state.startValueUsd - xlmUsd;
  state.startPrice = price;
  state.initialized = true;
}

export function valuation(price: number) {
  const xlmUsd = state.xlm * price;
  const total = xlmUsd + state.usdc;
  const xlmPct = total > 0 ? (xlmUsd / total) * 100 : 0;
  const startXlm = (state.startValueUsd * state.policy.targetXlmPct) / 100 / (state.startPrice || price);
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
  const fill: Fill = { id: ++demo.fillSeq, at: Date.now(), side, agent, xlm, usdc, price: fillPrice, reason };
  state.fills.unshift(fill);
  state.fills = state.fills.slice(0, 50);
  return fill;
}

// ── SSE fan-out ──
export function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of [...clients]) {
    try {
      c.write(payload);
    } catch {
      clients.delete(c);
    }
  }
}

function startTradeStream(): void {
  const server = new Horizon.Server('https://horizon.stellar.org');
  const base = Asset.native();
  const counter = new Asset('USDC', MAINNET_USDC_ISSUER);
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
        if (t.base_asset_type !== 'native') [xlm, usdc] = [usdc, xlm];
        if (!(xlm > 0) || !(usdc > 0)) return;
        const price = usdc / xlm;
        if (state.lastPrice > 0 && Math.abs(price / state.lastPrice - 1) > 0.05) return;
        state.lastPrice = price;
        broadcast('trade', { id: t.id, at: Date.parse(t.ledger_close_time), price, xlm, usdc, side: t.base_is_seller ? 'sell' : 'buy' });
      },
      onerror: () => {
        /* the Horizon EventSource reconnects on its own */
      },
    });
}

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

/** Idempotently starts the background feeds (once per process, across hot reloads). */
export function ensureStarted(): void {
  if (demo.started) return;
  demo.started = true;
  if (!process.env.GEMINI_API_KEY) {
    console.warn('[demo] GEMINI_API_KEY is not set — agents will use the deterministic heuristic fallback.');
  }
  try {
    startTradeStream();
  } catch (err) {
    console.error('[demo] trade stream failed to start', err);
  }
  void pollBinance();
  demo.binanceTimer = setInterval(() => void pollBinance(), 5000);
}

// ── Decision cycle ──
async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t };
}

export function marketSummary(ctx: MarketContext, source: string) {
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

function modelLabel(d: AgentDecision): string | null {
  return d.llmModel ? describeProvider(d.llmModel) : null;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

export async function runCycle(intervalSeconds: number): Promise<CycleRecord> {
  const { source } = await getCandlesWithSource(PAIR, intervalSeconds, 200);
  const ctx = await buildMarketContext(PAIR, intervalSeconds);
  if (!ctx) throw new Error('Not enough live candles to build a market context (need ≥30).');
  if (!state.initialized) initPortfolio(ctx.price);
  state.lastPrice = state.lastPrice || ctx.price;

  const id = ++demo.cycleSeq;
  const policy = state.policy;
  broadcast('cycle', { id, phase: 'market', market: marketSummary(ctx, source) });

  // Sequential: free-tier Gemini quotas punish bursts.
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

export function resetPortfolio(): void {
  state.fills = [];
  state.cycles = [];
  if (state.lastPrice) initPortfolio(state.lastPrice);
}

export function errorResponse(err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[demo]', message);
  return Response.json({ error: message }, { status: 500 });
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const v = await req.json();
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
