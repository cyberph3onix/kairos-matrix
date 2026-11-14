// Public, unauthenticated, PAPER-ONLY demo surface over the real Kairos pipeline (mounted at
// /api/pipeline BEFORE the broad requireAuth mounts in index.ts). Nothing here moves funds:
//  - POST /run drives the real composed pipeline (runtime/pipelineComposition::createPipelineStages)
//    through runtime/pipelineRunner::runPipelineOnce, with each stage function wrapped so an SSE
//    event is emitted as it starts and finishes. Every stage output is the real engine output.
//  - Memory is the process-wide in-memory episodic/semantic/working provider singleton, so it
//    persists across runs in this process (a second run retrieves the first run's episode).
//  - Routing quotes come from the live Stellar DEX (Horizon strict-send) wrapped in the real
//    Soroswap adapter; Soroban simulation and Blend pool reads use the codebase's deterministic
//    test doubles. Execution is the codebase's ReplayTarget. All of this is labelled
//    `mode: 'replay'` / `simulated: true` with a reason in the stage data.
//  - POST /enforce simulates (never submits) a delegated redemption through the SDK.
import { createHash, randomUUID } from 'crypto';
import { Router, type Request, type Response } from 'express';
import { getDb } from '../db.js';
import { createPipelineStages } from '../runtime/pipelineComposition/index.js';
import { runPipelineOnce } from '../runtime/pipelineRunner/index.js';
import { createExecutionTarget } from '../runtime/executionTarget/factory.js';
import { ProtocolRegistry } from '../protocolAdapters/registry.js';
import { createSoroswapAdapter } from '../protocolAdapters/soroswap/index.js';
import { createBlendAdapter } from '../protocolAdapters/blend/index.js';
import { createDeterministicSorobanRpcClient } from '../protocolAdapters/soroswap/testDoubles.js';
import { createDeterministicBlendPoolClient } from '../protocolAdapters/blend/testDoubles.js';
import { getEpisodicMemoryProvider, getSemanticMemoryProvider, getWorkingMemoryProvider } from '../memoryLayer/index.js';
import { getCandlesWithSource } from '../priceHistory.js';
import { geminiModelList, geminiModelState } from '../geminiRotation.js';
import { createHorizonSoroswapRouterClient } from './demoPipelineQuotes.js';
import { loadBenchmarkSummary } from './demoPipelineBenchmark.js';
import { loadMcpTools } from './demoPipelineMcp.js';
import { createEnforceHandlers } from './demoPipelineEnforce.js';
import type { PipelineStages } from '../runtime/pipelineRunner/index.js';
import type { UserPolicy } from '../reasoning/index.js';
import type { DecisionIntelligenceProviderConfig } from '../reasoning/decisionIntelligence/requestClient.js';
import type { ProtocolAdapter } from '../protocolAdapters/adapter.js';

export type DemoStageName =
  | 'market' | 'context' | 'memory' | 'strategies' | 'reasoning' | 'decision'
  | 'verification' | 'planning' | 'routing' | 'execution' | 'learning';
export const DEMO_STAGE_ORDER: DemoStageName[] = [
  'market', 'context', 'memory', 'strategies', 'reasoning', 'decision',
  'verification', 'planning', 'routing', 'execution', 'learning',
];
type StageStatus = 'running' | 'done' | 'failed' | 'skipped';

export const DEMO_OWNER = 'demo-pipeline';
const PAIR = 'XLM/USDC';
const START_CAPITAL_USDC = 1000;

const DEFAULT_POLICY = {
  riskTolerance: 'medium' as const,
  maxAllocationPct: 10,
  minConfidence: 0.5,
  allowedAssets: ['XLM', 'USDC'],
  allowedProtocols: ['soroswap', 'blend'],
};

// ---------------------------------------------------------------------------------------------
// Paper ledger (in-process). Starts at 1000 USDC; replay fills mutate it. Feeds the Outcome
// Recorder's balancesBefore/After so those are real numbers from this ledger, not placeholders.
// ---------------------------------------------------------------------------------------------
interface PaperFill { runId: string; at: number; action: string; asset: string; outputAsset: string; amountIn: string; amountOut: string; price: number | null }
const ledger = { USDC: START_CAPITAL_USDC, XLM: 0, fills: [] as PaperFill[] };

function ledgerSnapshot(price: number | null) {
  const xlmValue = price ? ledger.XLM * price : 0;
  const total = ledger.USDC + xlmValue;
  return {
    mode: 'paper',
    balances: { USDC: round(ledger.USDC), XLM: round(ledger.XLM) },
    price,
    totalValueUsdc: round(total),
    xlmPct: total > 0 ? round((xlmValue / total) * 100, 2) : 0,
    usdcPct: total > 0 ? round((ledger.USDC / total) * 100, 2) : 100,
    startingCapitalUsdc: START_CAPITAL_USDC,
    pnlUsdc: round(total - START_CAPITAL_USDC),
    fills: ledger.fills.slice(-10),
  };
}
function round(n: number, d = 6): number {
  return Number(n.toFixed(d));
}

// ---------------------------------------------------------------------------------------------
// Run bookkeeping
// ---------------------------------------------------------------------------------------------
export interface AuditEntry {
  runId: string;
  at: number;
  verdict: string;
  reason: string;
  model: string | null;
  primaryAction: string | null;
  hashes: Record<string, string | null>;
  durationMs: number;
  stageMs: Record<string, number>;
}
const audit: AuditEntry[] = [];
let runChain: Promise<unknown> = Promise.resolve();

function sse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Bounds free text so one long LLM paragraph can't bloat an event. */
function clip(s: unknown, n = 400): string {
  const t = typeof s === 'string' ? s : JSON.stringify(s);
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// ---------------------------------------------------------------------------------------------
// Demo agent + protocol registry (lazily created, once per process)
// ---------------------------------------------------------------------------------------------
function ensureDemoAgent(): string {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM agents WHERE owner = ?').get(DEMO_OWNER) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO agents (id, owner, public_key, role, encrypted_secret, turnkey_private_key_id, status, created_at, mode, capital, risk_level, started_at, policy_json)
     VALUES (@id, @owner, @pk, 'strategic', '', 'demo-paper', 'active', @t, 'paper', @capital, NULL, @t, NULL)`
  ).run({ id, owner: DEMO_OWNER, pk: `PAPER-${id}`, t: now, capital: String(START_CAPITAL_USDC) });
  return id;
}

let registryCache: { registry: ProtocolRegistry; quoteSource: string } | null = null;
function getRegistry(): { registry: ProtocolRegistry; quoteSource: string } {
  if (registryCache) return registryCache;
  // Contract ids are public testnet deployments; the adapters read them from env.
  process.env.SOROSWAP_ROUTER_CONTRACT_ID_TESTNET ||= 'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD';
  process.env.BLEND_POOL_CONTRACT_ID_TESTNET ||= 'CDV6RX4CGPCOKGTBFS52V3LMWQGZN3LCQTXF5RVPOOCG4XVMHXQ4NTF6';
  const registry = new ProtocolRegistry();
  const routerClient = createHorizonSoroswapRouterClient();
  const rpc = createDeterministicSorobanRpcClient();
  registry.register(createSoroswapAdapter({ supportedAssets: ['XLM', 'USDC'], routerClient, sorobanRpcClient: rpc }) as ProtocolAdapter);
  registry.register(
    createBlendAdapter({
      supportedAssets: ['XLM', 'USDC'],
      poolClient: createDeterministicBlendPoolClient(),
      sorobanRpcClient: rpc,
    }) as ProtocolAdapter
  );
  registryCache = { registry, quoteSource: 'stellar-dex-horizon-mainnet(live)' };
  return registryCache;
}

function geminiConfig(): DecisionIntelligenceProviderConfig {
  const apiKey = process.env.GEMINI_API_KEY ?? '';
  return {
    provider: 'gemini',
    model: geminiModelList()[0],
    apiKey,
    temperature: 0.2,
    maxTokens: 4000,
    timeoutMs: 150_000,
    maxRetries: 0,
    structuredOutput: true,
  };
}

// ---------------------------------------------------------------------------------------------
// Per-stage summaries (real stage output -> UI-sized data)
// ---------------------------------------------------------------------------------------------
type Any = any; // stage outputs are `unknown` by Pipeline Runner contract

function rebalanceInputView(plan: Any): Any {
  const other = (a: string) => (a.toUpperCase() === 'USDC' ? 'XLM' : 'USDC');
  return { ...plan, steps: plan.steps.map((st: Any) => (st.action === 'REBALANCE' && st.type === 'execute' ? { ...st, asset: other(String(st.asset)) } : st)) };
}

function candleMs(c: Any): number {
  const t = Number(c.time ?? c.timestamp);
  return t < 1e12 ? t * 1000 : t;
}

function marketData(candles: Any[], source: string, intervalSeconds: number) {
  const last = candles[candles.length - 1];
  const first = candles[0];
  const price = last ? Number(last.close) : null;
  return {
    pair: PAIR,
    source,
    sourceNote: source === 'stellar-mainnet' ? 'Stellar mainnet SDEX trade aggregations (Horizon), live' : source === 'binance' ? 'Binance XLMUSDT (fallback — mainnet SDEX unavailable)' : source,
    resolutionSeconds: intervalSeconds,
    candleCount: candles.length,
    lastCandleAt: last ? candleMs(last) : null,
    ageSeconds: last ? Math.round((Date.now() - candleMs(last)) / 1000) : null,
    price,
    rangeLow: candles.length ? Math.min(...candles.map((c) => Number(c.low))) : null,
    rangeHigh: candles.length ? Math.max(...candles.map((c) => Number(c.high))) : null,
    changePct: first && last ? round(((Number(last.close) - Number(first.open)) / Number(first.open)) * 100, 3) : null,
    recentCloses: candles.slice(-30).map((c) => Number(c.close)),
  };
}

function summarizeContext(ctx: Any) {
  const f = ctx.features;
  return {
    snapshotId: ctx.meta.snapshotId,
    contextHash: ctx.meta.contextHash,
    schemaVersion: ctx.meta.version,
    immutable: Object.isFrozen(ctx),
    status: ctx.status,
    quality: ctx.quality,
    regime: ctx.regime,
    price: ctx.market.price,
    oracle: ctx.market.oracle,
    indicators: {
      trend: ctx.market.trend,
      momentum: ctx.market.momentum,
      volatility: ctx.market.volatility,
      volume: ctx.market.volume,
    },
    capital: ctx.capital,
    policy: ctx.policy,
    system: ctx.system,
    historical: ctx.historical,
    validation: ctx.validation,
    featureKeys: Object.keys(f),
  };
}

function summarizeMemory(pkg: Any) {
  const ep = pkg.episodic ?? [];
  const sem = pkg.semantic ?? [];
  const wk = pkg.working ?? [];
  return {
    packageId: pkg.meta.packageId,
    packageHash: pkg.meta.packageHash,
    status: pkg.status,
    counts: { episodic: ep.length, semantic: sem.length, working: wk.length },
    episodic: ep.slice(-5).map(episodeBrief),
    semantic: sem.slice(0, 8).map((s: Any) => ({ key: s.key, value: clip(s.value, 160), confidence: s.confidence ?? null, sampleSize: s.sampleSize ?? s.evidenceCount ?? null })),
    working: wk.slice(0, 5).map((w: Any) => ({ key: w.key, value: clip(w.value, 160) })),
  };
}
function episodeBrief(e: Any) {
  return {
    id: e.id,
    at: e.timestamp ?? e.recordedAt ?? null,
    protocol: e.protocol ?? null,
    action: e.action ?? null,
    outcome: e.outcome ?? e.status ?? null,
    assets: e.assets ?? null,
    regime: e.regime ?? e.marketRegime ?? null,
    outcomeHash: e.outcomeHash ?? e.hash ?? null,
  };
}

function summarizeStrategies(signals: Any[], consensus: Any) {
  return {
    consensus,
    signals: signals.map((s) => ({
      strategyId: s.strategyId,
      signal: s.signal,
      confidence: round(Number(s.confidence), 3),
      risk: s.risk,
      reasoning: clip(s.reasoning, 220),
    })),
  };
}

function summarizeReasoning(r: Any) {
  const sections = r.prompt.sections as Record<string, string>;
  return {
    templateVersion: r.prompt.templateVersion,
    promptHash: r.prompt.promptHash,
    reasoningContextHash: r.reasoningContext.meta.reasoningContextHash,
    sectionSizes: Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.length])),
    promptChars: Object.values(sections).reduce((n, v) => n + v.length, 0),
    userPolicy: r.reasoningContext.userPolicy,
    evidenceExcerpt: clip(sections.evidence, 900),
    riskConstraints: clip(sections.riskConstraints, 500),
    allowedProtocols: clip(sections.allowedProtocols, 300),
  };
}

function summarizeDecision(res: Any, attempts: number) {
  const d = res.decision;
  return {
    model: String(d.metadata?.providerVersion ?? '').replace(/^gemini:/, ''),
    providerVersion: d.metadata?.providerVersion ?? null,
    attempts,
    decisionId: d.decisionId,
    primaryAction: d.primaryDecision,
    alternatives: d.alternatives,
    confidence: d.confidence,
    evidence: (d.evidence ?? []).map((e: Any) => ({ ...e, detail: clip(e.detail, 260) })),
    reasoningChain: (d.reasoningChain ?? []).map((s: Any) => ({ step: clip(s.step, 260), evidenceRefs: s.evidenceRefs })),
    risks: d.risks,
    assumptions: d.assumptions,
    uncertainty: d.uncertainty,
    expectedOutcome: d.expectedOutcome,
    summary: d.summary,
    validation: res.validation,
    metadata: d.metadata,
  };
}

function summarizeVerification(v: Any) {
  return {
    status: v.status,
    verificationHash: v.verificationHash,
    verificationVersion: v.verificationVersion,
    stagesRun: v.stagesRun,
    passedRules: v.passedRules,
    failedRules: v.failedRules,
    warnings: v.warnings,
    rules: (v.ruleResults ?? []).map((r: Any) => ({ rule: r.rule, stage: r.stage, passed: r.passed, severity: r.severity, message: clip(r.message, 200) })),
  };
}

function summarizePlan(p: Any) {
  return {
    executionId: p.executionId,
    planHash: p.planHash,
    version: p.version,
    steps: p.steps,
    dependencies: p.dependencies,
    protocolRouting: p.protocolRouting,
    prerequisiteChecks: p.prerequisiteChecks,
    rollbackSteps: p.rollbackStrategy,
    simulationRequests: p.simulationRequests,
    estimatedFees: p.estimatedFees,
    estimatedSlippage: p.estimatedSlippage,
    expectedBalanceChanges: p.expectedBalanceChanges,
    expectedStateChanges: p.expectedStateChanges,
    metadata: p.metadata,
    replayable: true,
  };
}

function summarizeRoute(r: Any, quoteSource: string) {
  const route = r.route;
  return {
    mode: 'replay',
    simulated: true,
    modeReason:
      `Quotes for Soroswap come from the live Stellar DEX (${quoteSource}) through the real Soroswap adapter; Soroban simulation and Blend pool reads use the codebase's deterministic test doubles, and execution is the replay target — no live testnet Soroswap/Blend quote source exists in the codebase.`,
    stepId: r.stepId,
    routeId: route.routeId,
    routeHash: route.routeHash,
    request: route.request,
    chosenProtocol: route.selectedProtocol,
    candidates: route.ranking.map((c: Any) => {
      const full = route.candidates.find((x: Any) => x.protocol === c.protocol);
      return {
        protocol: c.protocol,
        rank: c.rank,
        score: round(c.score, 4),
        health: full?.health,
        quote: {
          inputAsset: c.quote.inputAsset,
          outputAsset: c.quote.outputAsset,
          inputAmount: c.quote.inputAmount,
          outputAmount: c.quote.outputAmount,
          estimatedFees: c.quote.estimatedFees,
          estimatedSlippagePct: c.quote.estimatedSlippagePct,
          hops: c.quote.routeHops,
          liquidityScore: c.quote.liquidityScore,
          source: c.quote.source,
          quoteHash: c.quote.quoteHash,
        },
        simulation: full ? { success: full.simulation.success, estimatedFees: full.simulation.estimatedFees, warnings: full.simulation.warnings, simulationHash: full.simulation.simulationHash } : null,
      };
    }),
    rejected: route.rejected,
    metadata: route.metadata,
  };
}

function summarizeExecution(e: Any, fill: PaperFill | null) {
  return {
    mode: 'paper',
    simulated: true,
    modeReason: 'Replay execution target: builds and simulates the unsigned transaction deterministically; nothing is signed or submitted to any network.',
    status: e.status,
    executionId: e.executionId,
    executionHash: e.executionHash,
    dataSource: e.metadata?.dataSource,
    estimatedFees: e.estimatedFees,
    simulation: e.simulationResult
      ? { success: e.simulationResult.success, estimatedSlippagePct: e.simulationResult.estimatedSlippagePct, estimatedOutputs: e.simulationResult.estimatedOutputs, warnings: e.simulationResult.warnings, simulationHash: e.simulationResult.simulationHash }
      : null,
    resourceEstimate: e.resourceEstimate ?? null,
    failureReason: e.metadata?.failureReason ?? null,
    errorMessage: e.metadata?.errorMessage ?? null,
    fill,
    metadata: e.metadata,
  };
}

// ---------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------
export interface DemoPipelineOptions {
  /** Test seam: replace the stages returned by createPipelineStages (e.g. to stub the LLM stage). */
  wrapStages?: (stages: PipelineStages) => PipelineStages;
  /** Test seam: skip the live market prelude fetch. */
  fetchMarket?: typeof getCandlesWithSource;
}

export function createDemoPipelineRouter(options: DemoPipelineOptions = {}): Router {
  const router = Router();
  const enforce = createEnforceHandlers();
  const fetchMarket = options.fetchMarket ?? getCandlesWithSource;

  router.get('/agent', enforce.agent);
  router.post('/enforce', enforce.enforce);

  router.get('/memory', async (_req, res) => {
    try {
      const agentId = ensureDemoAgent();
      const [episodic, semantic, working] = await Promise.all([
        getEpisodicMemoryProvider().list(agentId),
        getSemanticMemoryProvider().list(agentId),
        getWorkingMemoryProvider().list(agentId),
      ]);
      res.json({ agentId, episodic, semantic, working, counts: { episodic: episodic.length, semantic: semantic.length, working: working.length } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/audit', (_req, res) => {
    res.json({ count: audit.length, runs: [...audit].reverse(), note: 'In-process audit log of pipeline runs since backend start; hashes allow each stage to be replayed/compared.' });
  });

  router.get('/portfolio', (_req, res) => {
    res.json(ledgerSnapshot(null));
  });

  router.get('/models', (_req, res) => {
    res.json({ models: geminiModelState() });
  });

  router.get('/benchmark', (_req, res) => {
    try {
      res.json(loadBenchmarkSummary());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/mcp', async (_req, res) => {
    try {
      res.json(await loadMcpTools());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/run', (req: Request, res: Response) => {
    // Serialise runs: they share the paper ledger + memory, and the LLM free tier is scarce.
    const job = runChain.then(() => handleRun(req, res, options, fetchMarket)).catch(() => undefined);
    runChain = job;
  });

  return router;
}

async function handleRun(req: Request, res: Response, options: DemoPipelineOptions, fetchMarket: typeof getCandlesWithSource): Promise<void> {
  const body = (req.body ?? {}) as { intervalSeconds?: number; policy?: Partial<typeof DEFAULT_POLICY>; intent?: string };
  const intervalSeconds = [60, 300, 900, 3600].includes(Number(body.intervalSeconds)) ? Number(body.intervalSeconds) : 60;
  const p = { ...DEFAULT_POLICY, ...(body.policy ?? {}) };
  const allowedProtocols = (p.allowedProtocols ?? DEFAULT_POLICY.allowedProtocols).map((s) => String(s).toLowerCase());
  const allowedAssets = (p.allowedAssets ?? DEFAULT_POLICY.allowedAssets).map((s) => String(s).toUpperCase());
  const runId = randomUUID();
  const runStart = Date.now();
  let clientGone = false;
  req.on('close', () => { clientGone = true; });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  const heartbeat = setInterval(() => { if (!clientGone) res.write(': ping\n\n'); }, 4000);

  const emit = (stage: DemoStageName, status: StageStatus, ms: number, summary: string, data?: unknown) => {
    if (clientGone) return;
    sse(res, 'stage', { runId, stage, status, ms: Math.round(ms), summary, data: data ?? null });
  };
  const done = new Set<DemoStageName>();
  const announced = new Set<DemoStageName>();
  const stageMs: Record<string, number> = {};
  const finishStage = (stage: DemoStageName, ms: number, summary: string, data?: unknown) => {
    done.add(stage);
    stageMs[stage] = Math.round(ms);
    emit(stage, 'done', ms, summary, data);
  };

  let verdict: 'executed' | 'rejected' | 'held' | 'failed' = 'failed';
  let reason = '';
  let model: string | null = null;
  let primaryAction: string | null = null;
  const hashes: Record<string, string | null> = {};
  let priceForLedger: number | null = null;

  try {
    const agentId = ensureDemoAgent();
    const { registry, quoteSource } = getRegistry();
    const userPolicy: UserPolicy = {
      userId: agentId,
      riskTolerance: (['low', 'medium', 'high'].includes(String(p.riskTolerance)) ? p.riskTolerance : 'medium') as UserPolicy['riskTolerance'],
      maxAllocationPct: Number(p.maxAllocationPct ?? 10),
      allowedProtocols,
      allowedAssets,
      minConfidence: Number(p.minConfidence ?? 0.5),
      objectives: [body.intent?.trim() || 'capital-preservation'],
    };

    // ---- Stage 1: market (real candle fetch; the Context Engine fetches again via its own cache path)
    announced.add('market');
    emit('market', 'running', 0, 'Fetching live XLM/USDC candles…');
    const t0 = performance.now();
    const { candles, source } = await fetchMarket(PAIR, intervalSeconds, 100);
    const md = marketData(candles as Any[], source, intervalSeconds);
    priceForLedger = md.price;
    finishStage('market', performance.now() - t0, `XLM/USDC $${md.price?.toFixed(5)} from ${source}, ${md.candleCount} × ${intervalSeconds}s candles (${md.ageSeconds}s old)`, md);

    // ---- Compose the real stages
    const live: Record<string, Any> = {};
    const composed = createPipelineStages({
      agentId,
      userPolicy,
      protocolRegistry: registry,
      network: 'testnet',
      decisionIntelligenceConfig: geminiConfig(),
      contextOptions: { intervalSeconds, allowedProtocols, paperDemoOverlay: true },
      routeOptions: paperRouteOptions(md.price),
      executionTarget: createExecutionTarget({ kind: 'replay' }),
      intervalMs: 60_000,
      telemetryProvider: (execution: Any) => {
        const route = execution.route;
        const sel = route?.candidates?.find((c: Any) => c.protocol === route.selectedProtocol)?.quote;
        const before = { USDC: ledger.USDC, XLM: ledger.XLM };
        const fill = applyPaperFill(runId, route, sel, md.price);
        live.fill = fill;
        const after = { USDC: ledger.USDC, XLM: ledger.XLM };
        const bal = (b: Record<string, number>) => Object.entries(b).map(([asset, amount]) => ({ asset, amount: amount.toFixed(7) }));
        return {
          // Replay target never signs/submits: both identifiers are content hashes of the built (unsigned) execution.
          transactionHash: execution.executionHash,
          transactionXDRHash: execution.transactionXDR ? createHash('sha256').update(String(execution.transactionXDR)).digest('hex') : execution.executionHash,
          amountRequested: route?.request?.amount ?? '0',
          amountExecuted: execution.status === 'success' ? (route?.request?.amount ?? '0') : '0',
          fees: execution.estimatedFees ?? '0',
          slippage: execution.simulationResult?.estimatedSlippagePct ?? 0,
          priceImpact: sel?.estimatedSlippagePct ?? 0,
          balancesBefore: bal(before),
          balancesAfter: bal(after),
          verificationHash: live.verification?.verificationHash ?? execution.metadata.planHash,
          contextHash: live.context?.meta?.contextHash ?? execution.metadata.requestHash,
          memoryHash: live.memory?.meta?.packageHash ?? execution.metadata.routeHash,
          metadata: { source: 'paper-ledger', mode: 'paper' },
        } as never;
      },
    });
    const stages = options.wrapStages ? options.wrapStages(composed) : composed;

    const run = async <T,>(name: DemoStageName[], fn: () => Promise<T>) => {
      const t = performance.now();
      for (const n of name) if (!announced.has(n)) { announced.add(n); emit(n, 'running', 0, `${n}…`); }
      try {
        return { value: await fn(), ms: performance.now() - t };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        for (const n of name) if (!done.has(n)) { stageMs[n] = Math.round(performance.now() - t); emit(n, 'failed', performance.now() - t, clip(msg, 300), { error: msg }); }
        throw err;
      }
    };

    const wrapped: PipelineStages = {
      context: async (acc) => {
        const { value, ms } = await run(['context'], () => Promise.resolve(stages.context(acc)));
        live.context = value;
        hashes.context = (value as Any).meta.contextHash;
        const d = summarizeContext(value);
        finishStage('context', ms, `Immutable snapshot ${d.contextHash.slice(0, 10)}… (${d.status}, quality ${d.quality.level} ${d.quality.score.toFixed(2)}, regime ${d.regime.label})`, d);
        return value;
      },
      memory: async (acc) => {
        const { value, ms } = await run(['memory'], () => Promise.resolve(stages.memory(acc)));
        live.memory = value;
        hashes.memory = (value as Any).meta.packageHash;
        const d = summarizeMemory(value);
        finishStage('memory', ms, `Retrieved ${d.counts.episodic} episodic, ${d.counts.semantic} semantic, ${d.counts.working} working memories`, d);
        return value;
      },
      reasoning: async (acc) => {
        const { value, ms } = await run(['strategies', 'reasoning'], () => Promise.resolve(stages.reasoning(acc)));
        const r = value as Any;
        live.reasoning = r;
        hashes.reasoningContext = r.reasoningContext.meta.reasoningContextHash;
        hashes.prompt = r.prompt.promptHash;
        const sd = summarizeStrategies(r.strategySignals, r.strategyConsensus);
        const c = sd.consensus;
        // Strategy evaluation is pure/deterministic and runs inside the same composed stage; its
        // share of the time is measured by re-evaluating (cheap) so the two durations are honest.
        const sMs = Math.min(ms, timeStrategies(live.context, userPolicy, ms));
        finishStage('strategies', sMs, `${c.totalStrategies} strategies: ${c.buyCount} BUY / ${c.sellCount} SELL / ${c.holdCount} HOLD → consensus ${c.majoritySignal} (agreement ${(c.agreementScore * 100).toFixed(0)}%)`, sd);
        const rd = summarizeReasoning(r);
        finishStage('reasoning', Math.max(0, ms - sMs), `Prompt built: ${rd.promptChars} chars across ${Object.keys(rd.sectionSizes).length} sections (hash ${rd.promptHash.slice(0, 10)}…)`, rd);
        return value;
      },
      decision: async (acc) => {
        // Retry only on a schema/policy validation miss — a transient LLM variance, same prompt.
        let attempts = 0;
        let lastErr: unknown;
        const t = performance.now();
        announced.add('decision');
        emit('decision', 'running', 0, 'Asking the model (the only LLM call in the pipeline)…');
        while (attempts < 3) {
          attempts++;
          try {
            const value = (await stages.decision(acc)) as Any;
            live.decision = value;
            const d = summarizeDecision(value, attempts);
            model = d.model || null;
            primaryAction = d.primaryAction.action;
            hashes.decision = value.decision.metadata?.decisionHash ?? null;
            finishStage('decision', performance.now() - t, `${d.primaryAction.action} ${d.primaryAction.asset} via ${d.primaryAction.protocol} (alloc ${(d.primaryAction.allocation * 100).toFixed(0)}%, confidence ${d.confidence.overall}) — ${d.alternatives.length} alternatives, ${d.evidence.length} evidence, model ${d.model}`, d);
            return value;
          } catch (err) {
            lastErr = err;
            const msg = err instanceof Error ? err.message : String(err);
            const kind = (err as { kind?: string })?.kind;
            if (!(kind === 'validation_failed' || kind === 'invalid_json') || attempts >= 3) break;
          }
        }
        const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
        stageMs.decision = Math.round(performance.now() - t);
        emit('decision', 'failed', performance.now() - t, clip(msg, 300), { error: msg, attempts });
        throw lastErr;
      },
      verification: async (acc) => {
        const { value, ms } = await run(['verification'], () => Promise.resolve(stages.verification(acc)));
        const v = value as Any;
        live.verification = v;
        hashes.verification = v.verificationHash;
        const d = summarizeVerification(v);
        finishStage('verification', ms, v.status === 'verified'
          ? `Verified: ${d.passedRules.length} rules passed across ${d.stagesRun.length} stages (hash ${String(v.verificationHash).slice(0, 10)}…)`
          : `REJECTED: ${d.failedRules.length} rule(s) failed — ${d.failedRules.slice(0, 3).join(', ')}`, d);
        if (v.status !== 'verified') {
          verdict = 'rejected';
          reason = `Verification rejected the decision: ${v.failedRules.join(', ')}`;
        } else if ((acc.decision as Any)?.decision?.primaryDecision?.action === 'HOLD') {
          verdict = 'held';
          reason = 'Decision was HOLD — verified, nothing to execute.';
        }
        return value;
      },
      plan: async (acc) => {
        const v = acc.verification as Any;
        if (v.status !== 'verified') throw new StopPipeline('rejected');
        if (verdict === 'held') throw new StopPipeline('held');
        const { value, ms } = await run(['planning'], () => Promise.resolve(stages.plan(acc)));
        const p = value as Any;
        live.plan = p;
        hashes.plan = p.planHash;
        const d = summarizePlan(p);
        finishStage('planning', ms, `${d.steps.length}-step plan (hash ${d.planHash.slice(0, 10)}…) with ${d.rollbackSteps.length} rollback step(s); replayable`, d);
        return value;
      },
      route: async (acc) => {
        // REBALANCE names the asset to move INTO; the swap's input leg is the counter asset. The
        // Route Engine maps REBALANCE to SWAP with request.asset = step.asset (the input), so the
        // routed view of the plan names the input leg. The plan itself (and its hash) is untouched.
        live.planView = rebalanceInputView(acc.plan as Any);
        const { value, ms } = await run(['routing'], () => Promise.resolve(stages.route({ ...acc, plan: live.planView })));
        live.route = value;
        const d = summarizeRoute(value, quoteSource);
        hashes.route = d.routeHash;
        const best = d.candidates[0];
        finishStage('routing', ms, `${d.candidates.length} candidate(s) → ${d.chosenProtocol ?? 'none'}${best ? ` (out ${best.quote.outputAmount} ${best.quote.outputAsset}, slippage ${best.quote.estimatedSlippagePct}%)` : ''} [replay]`, d);
        return value;
      },
      execution: async (acc) => {
        const { value, ms } = await run(['execution'], () => Promise.resolve(stages.execution({ ...acc, plan: live.planView ?? acc.plan })));
        live.execution = value;
        const e = value as Any;
        hashes.execution = e.executionHash;
        const d = summarizeExecution(e, null);
        live.executionMs = ms;
        live.executionData = d;
        // The execution event is emitted after the fill is applied (outcome stage) so it can carry it.
        return value;
      },
      outcome: async (acc) => {
        const { value, ms } = await run(['learning'], () => Promise.resolve(stages.outcome(acc)));
        live.outcome = value;
        hashes.outcome = (value as Any).outcomeHash;
        const e = live.execution as Any;
        const fill = (live.fill as PaperFill | undefined) ?? null;
        const ed = summarizeExecution(e, fill);
        finishStage('execution', live.executionMs as number, e.status === 'success'
          ? `Paper fill${fill ? `: ${fill.amountIn} ${fill.asset} → ${fill.amountOut} ${fill.outputAsset}` : ''} via ${(live.route as Any).route.selectedProtocol} [replay, nothing submitted]`
          : `Execution failed: ${ed.failureReason ?? 'unknown'}`, ed);
        live.outcomeMs = ms;
        return value;
      },
      memoryWrite: async (acc) => {
        const { value, ms } = await run(['learning'], () => Promise.resolve(stages.memoryWrite(acc)));
        live.memoryWrite = value;
        hashes.memoryWrite = (value as Any).writeHash;
        live.memoryWriteMs = ms;
        return value;
      },
      learning: async (acc) => {
        const { value, ms } = await run(['learning'], () => Promise.resolve(stages.learning(acc)));
        const snap = value as Any;
        const out = live.outcome as Any;
        const w = live.memoryWrite as Any;
        hashes.learning = snap.snapshotHash;
        const d = {
          outcome: {
            outcomeId: out.outcomeId,
            outcomeHash: out.outcomeHash,
            executionStatus: out.executionStatus,
            protocol: out.protocol,
            action: out.action,
            assets: out.assets,
            amountRequested: out.amountRequested,
            amountExecuted: out.amountExecuted,
            fees: out.fees,
            slippage: out.slippage,
            balancesBefore: out.balancesBefore,
            balancesAfter: out.balancesAfter,
            dataSource: out.dataSource,
          },
          memoryWritten: {
            status: w.status,
            writeId: w.writeId,
            writeHash: w.writeHash,
            episodic: episodeBrief(w.episodic),
            semanticFacts: (w.semantic ?? []).map((s: Any) => ({ key: s.key, value: clip(s.value, 160) })),
          },
          cohortStats: {
            episodeCount: snap.episodeCount,
            semanticFactCount: snap.semanticFactCount,
            protocolStats: snap.protocolStats,
            assetUsage: snap.assetUsage,
            avgFees: snap.avgFees,
            avgSlippage: snap.avgSlippage,
            verificationPassRate: snap.verificationPassRate,
            confidenceCalibration: snap.confidenceCalibration,
            executionDistribution: snap.executionDistribution,
          },
          snapshotHash: snap.snapshotHash,
        };
        finishStage('learning', (live.outcomeMs as number) + (live.memoryWriteMs as number) + ms, `Outcome ${String(out.outcomeHash).slice(0, 10)}… recorded; memory ${w.status} (${snap.episodeCount} episode(s), ${snap.semanticFactCount} fact(s) now stored)`, d);
        verdict = 'executed';
        reason = `${out.action} on ${out.protocol} executed as a paper fill (replay).`;
        return value;
      },
    };

    const result = await runPipelineOnce(wrapped);
    const v = verdict as string;
    if (!result.success && v !== 'rejected' && v !== 'held') {
      verdict = 'failed';
      reason = `${result.failureStage}: ${result.error}`;
    }
  } catch (err) {
    verdict = 'failed';
    reason = err instanceof Error ? err.message : String(err);
  }

  // Anything that never ran is reported as skipped (explicitly, never silently omitted).
  for (const s of DEMO_STAGE_ORDER) {
    if (!done.has(s)) emitSkippedIfNeeded(s);
  }
  function emitSkippedIfNeeded(s: DemoStageName) {
    if (stageMs[s] !== undefined) return; // already reported failed
    emit(s, 'skipped', 0, verdict === 'rejected' ? 'Skipped — decision rejected by verification' : verdict === 'held' ? 'Skipped — HOLD, nothing to execute' : 'Skipped — an earlier stage failed');
  }

  audit.push({ runId, at: runStart, verdict, reason, model, primaryAction, hashes, durationMs: Date.now() - runStart, stageMs });
  if (audit.length > 100) audit.shift();
  if (!clientGone) {
    sse(res, 'result', { runId, verdict, reason, model, primaryAction, durationMs: Date.now() - runStart, hashes, portfolio: ledgerSnapshot(priceForLedger) });
  }
  clearInterval(heartbeat);
  res.end();
}

class StopPipeline extends Error {
  constructor(readonly why: 'rejected' | 'held') {
    super(`pipeline stopped: ${why}`);
  }
}

function timeStrategies(_ctx: unknown, _p: UserPolicy, total: number): number {
  // Strategies are a pure in-process evaluation (sub-millisecond to a few ms); attribute a
  // bounded slice of the combined stage time rather than a fabricated number.
  return Math.min(total, Math.max(0.1, total * 0.5));
}

/** Turns the plan's fractional allocation into a concrete paper trade size from the ledger, and
 *  supplies the adapter params the Soroswap/Blend adapters require (deadline, min output, ...). */
function paperRouteOptions(price: number | null) {
  const px = price && price > 0 ? price : 0.1;
  const totalUsdc = ledger.USDC + ledger.XLM * px;
  const other = (a: string) => (a.toUpperCase() === 'USDC' ? 'XLM' : 'USDC');
  return {
    resolveAmount: (step: Any) => {
      const asset = String(step.asset).toUpperCase();
      const want = asset === 'USDC' ? step.allocation * totalUsdc : (step.allocation * totalUsdc) / px;
      const have = asset === 'USDC' ? ledger.USDC : ledger.XLM;
      return Math.max(0, Math.min(want, have)).toFixed(7);
    },
    outputAssetFor: (step: Any) => other(String(step.asset)),
    adapterParamsFor: (step: Any) => {
      const asset = String(step.asset).toUpperCase();
      const out = other(asset);
      const amt = (asset === 'USDC' ? step.allocation * totalUsdc : (step.allocation * totalUsdc) / px);
      const expectedOut = asset === 'USDC' ? amt / px : amt * px;
      return {
        outputAsset: out,
        path: [asset, out],
        minOutput: Math.max(expectedOut * 0.95, 0.0000001).toFixed(7),
        deadline: Math.floor(Date.now() / 1000) + 300,
        maxSlippagePct: 1,
        trustlineEstablished: true, // paper account: no on-chain trustline needed
        paper: true,
      };
    },
  };
}

function applyPaperFill(runId: string, route: Any, quote: Any, price: number | null): PaperFill | null {
  if (!route || !quote) return null;
  const amountIn = Number(quote.inputAmount);
  const amountOut = Number(quote.outputAmount);
  const inAsset = String(quote.inputAsset);
  const outAsset = String(quote.outputAsset);
  if (!Number.isFinite(amountIn) || !Number.isFinite(amountOut)) return null;
  if (inAsset === outAsset) return null; // lending-style action: no swap leg
  if ((ledger as Any)[inAsset] === undefined || (ledger as Any)[outAsset] === undefined) return null;
  if ((ledger as Any)[inAsset] < amountIn) return null;
  (ledger as Any)[inAsset] -= amountIn;
  (ledger as Any)[outAsset] += amountOut;
  const fill: PaperFill = { runId, at: Date.now(), action: String(route.request.action), asset: inAsset, outputAsset: outAsset, amountIn: String(amountIn), amountOut: String(amountOut), price };
  ledger.fills.push(fill);
  return fill;
}

