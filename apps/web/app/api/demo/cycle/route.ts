import { MIN_CYCLE_GAP_MS, broadcast, clampInterval, ensureStarted, errorResponse, readJson, runCycle, state, valuation } from '@/lib/engine/demoRuntime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  ensureStarted();
  if (state.cycleRunning) return Response.json({ error: 'A decision cycle is already running.' }, { status: 409 });
  const gap = Date.now() - state.lastCycleAt;
  if (gap < MIN_CYCLE_GAP_MS) {
    return Response.json(
      { error: `Cooling down — next cycle in ${Math.ceil((MIN_CYCLE_GAP_MS - gap) / 1000)}s (protects Gemini quota).` },
      { status: 429 },
    );
  }
  state.cycleRunning = true;
  state.lastCycleAt = Date.now();
  try {
    const body = await readJson(req);
    const record = await runCycle(clampInterval(Number(body.interval)));
    return Response.json({ record, portfolio: valuation(record.price) });
  } catch (err) {
    broadcast('cycle', { phase: 'error', error: err instanceof Error ? err.message : String(err) });
    return errorResponse(err);
  } finally {
    state.cycleRunning = false;
  }
}
