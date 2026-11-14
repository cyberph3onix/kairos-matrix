import { ensureStarted, state, valuation } from '@/lib/engine/demoRuntime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  ensureStarted();
  const price = state.lastPrice;
  return Response.json({
    initialized: state.initialized,
    price,
    policy: state.policy,
    spec: state.spec,
    valuation: state.initialized ? valuation(price) : null,
    fills: state.fills,
    cycles: state.cycles.slice(0, 10),
  });
}
