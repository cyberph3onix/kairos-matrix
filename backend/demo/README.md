# Kairos live demo

A zero-infrastructure slice of the real Kairos decision stack: live market data, the production
decision engine running on Gemini, and a deterministic policy gate that fills a **paper** portfolio.

```bash
# backend/.env (gitignored)
GEMINI_API_KEY=...            # https://aistudio.google.com/apikey

pnpm install
pnpm demo:live                # from repo root (or backend/) → http://localhost:4100
```

| Piece | Source |
| --- | --- |
| Candles / indicators / regime | Stellar **mainnet** SDEX via Horizon `trade_aggregations` (Binance fallback), `src/priceHistory.ts` + `src/decisionEngine.ts` |
| Live tape | Horizon SSE stream of every pubnet XLM/USDC trade |
| Cross-check | Binance XLMUSDT 24h ticker, every 5s |
| Intent → agent spec | `src/intentParser.ts` on Gemini |
| Strategic / Yield / Balancer agents | `src/decisionEngine.ts` on Gemini (heuristic fallback if the LLM is unavailable) |
| Policy gate + fills | `demo/server.ts`, deterministic, paper portfolio in memory |

Simulated, and labelled as simulated in the UI: execution (paper fills at the live price with 0.1%
slippage) and yield-venue APYs. Nothing in the demo holds keys or submits transactions.

Optional env: `GEMINI_MODEL` (default `gemini-3.6-flash`; falls back to `gemini-3.5-flash-lite` on
503/404), `DEMO_PORT` (4100), `MARKET_DATA_SOURCE` (`stellar-mainnet` | `binance`).
