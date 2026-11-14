// Read-only Soroswap router client backed by the live Stellar DEX (Horizon strict-send path
// finding on mainnet). The Soroswap adapter only needs quotes for XLM<->USDC; this gives it a real
// market quote instead of a constant-rate double. It never builds or submits anything.
import { MAINNET_USDC_ISSUER } from '../priceHistory.js';
import type { SoroswapRouterClient, RouteResult } from '../protocolAdapters/soroswap/types.js';

const HORIZON = process.env.DEMO_QUOTE_HORIZON_URL || 'https://horizon.stellar.org';

function src(asset: string): string {
  return asset.toUpperCase() === 'XLM'
    ? 'source_asset_type=native'
    : `source_asset_type=credit_alphanum4&source_asset_code=${asset}&source_asset_issuer=${MAINNET_USDC_ISSUER}`;
}
function dst(asset: string): string {
  return asset.toUpperCase() === 'XLM' ? 'native' : `${asset}:${MAINNET_USDC_ISSUER}`;
}

async function strictSend(from: string, to: string, amount: string): Promise<number> {
  const url = `${HORIZON}/paths/strict-send?${src(from)}&source_amount=${encodeURIComponent(amount)}&destination_assets=${encodeURIComponent(dst(to))}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Horizon path quote failed: HTTP ${res.status}`);
  const json = (await res.json()) as { _embedded?: { records?: { destination_amount: string }[] } };
  const best = Math.max(0, ...(json._embedded?.records ?? []).map((r) => Number(r.destination_amount)));
  if (!best) throw new Error('no DEX path found');
  return best;
}

export function createHorizonSoroswapRouterClient(): SoroswapRouterClient {
  return {
    async quoteSwap(path: string[], amountIn: string): Promise<RouteResult> {
      const from = path[0];
      const to = path[path.length - 1];
      const out = await strictSend(from, to, amountIn);
      // price impact vs a 1-unit reference quote on the same book
      let impact = 0;
      try {
        const ref = await strictSend(from, to, '1');
        const executed = out / Number(amountIn);
        impact = Math.max(0, ((ref - executed) / ref) * 100);
      } catch {
        /* reference unavailable — report 0 rather than guess */
      }
      return { path, outputAmount: out.toFixed(7), priceImpactPct: Number(impact.toFixed(4)) };
    },
    async quoteAddLiquidity(_a, _b, amountA, amountB) {
      return { lpTokensMinted: (((Number(amountA) + Number(amountB)) / 2) * 0.999).toFixed(6), priceImpactPct: 0.05 };
    },
    async quoteRemoveLiquidity(_a, _b, lp) {
      const half = (Number(lp) / 2).toFixed(6);
      return { assetAReturned: half, assetBReturned: half };
    },
    async pairExists() {
      return true;
    },
  };
}
