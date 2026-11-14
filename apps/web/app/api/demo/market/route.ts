import { buildMarketContext, currentYieldVenues } from '@/lib/engine/decisionEngine';
import { getCandlesWithSource } from '@/lib/engine/priceHistory';
import { PAIR, clampInterval, ensureStarted, errorResponse, initPortfolio, marketSummary, state } from '@/lib/engine/demoRuntime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  ensureStarted();
  try {
    const interval = clampInterval(Number(new URL(req.url).searchParams.get('interval')));
    const { candles, source } = await getCandlesWithSource(PAIR, interval, 200);
    const ctx = await buildMarketContext(PAIR, interval);
    if (ctx && !state.initialized) initPortfolio(ctx.price);
    if (ctx && !state.lastPrice) state.lastPrice = ctx.price;
    return Response.json({
      source,
      interval,
      candles,
      market: ctx ? marketSummary(ctx, source) : null,
      venues: ctx ? currentYieldVenues(ctx) : [],
    });
  } catch (err) {
    return errorResponse(err);
  }
}
