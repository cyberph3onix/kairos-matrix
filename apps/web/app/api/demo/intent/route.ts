import { parseIntent } from '@/lib/engine/intentParser';
import { POLICIES, ensureStarted, errorResponse, initPortfolio, readJson, state } from '@/lib/engine/demoRuntime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  ensureStarted();
  try {
    const body = await readJson(req);
    const text = typeof body.text === 'string' ? body.text.slice(0, 2000) : '';
    const result = await parseIntent(text);
    if (result.status === 'ok' && result.spec) {
      state.spec = result.spec;
      state.policy = POLICIES[result.spec.riskLevel];
      // Fresh agent -> fresh paper portfolio at the new target allocation.
      state.fills = [];
      state.cycles = [];
      if (state.lastPrice) initPortfolio(state.lastPrice);
    }
    return Response.json({ ...result, policy: state.policy });
  } catch (err) {
    return errorResponse(err);
  }
}
