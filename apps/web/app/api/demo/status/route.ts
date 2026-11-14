import { getMarketDataSource } from '@/lib/engine/priceHistory';
import { listStrategyMeta } from '@/lib/engine/strategies/index';
import { ensureStarted, state } from '@/lib/engine/demoRuntime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  ensureStarted();
  return Response.json({
    marketDataSource: getMarketDataSource(),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    geminiModel: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
    providerOrder: process.env.LLM_PROVIDER_ORDER || 'default',
    strategies: listStrategyMeta().length,
    policy: state.policy,
    spec: state.spec,
  });
}
