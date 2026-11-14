import { ensureStarted, resetPortfolio } from '@/lib/engine/demoRuntime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  ensureStarted();
  resetPortfolio();
  return Response.json({ ok: true });
}
