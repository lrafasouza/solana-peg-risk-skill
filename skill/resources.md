# Resources

## Methodology Source (upstream)

- **Public repo**: https://github.com/lrafasouza/pegana-replay
- **Methodology document**: `tools/pegana-replay-public/METHODOLOGY.md` in the repo — full explanation of the math, state machine, EWMA, hysteresis, and verifiability.
- **Replay CLI**: `crates/pegana-replay-cli/` — verifies a published alert receipt against the methodology version that produced it (content-addressed, Solana SPL Memo anchored).
- **License**: MIT. Cite as "methodology: MIT, github.com/lrafasouza/pegana-replay".

---

## Oracle APIs

### Pyth Network (intrinsic: NAV, FX, spot)
- Docs: https://docs.pyth.network
- Hermes endpoint: `https://hermes.pyth.network`
- Feed catalog: https://pyth.network/price-feeds
- SDK: `@pythnetwork/hermes-client` — `getLatestPriceUpdates([feedId])`
- Feed IDs are `0x…` hex strings, not base-58 addresses. Never use push price-accounts (deprecated).

### Switchboard On-Demand (alternative oracle)
- Docs: https://docs.switchboard.xyz
- SDK: `@switchboard-xyz/on-demand`
- Use for feeds not available on Pyth, or as a second-opinion oracle. Read via `fetchLatestPriceResult` (quote/bundle approach). Staleness via slot delta.

---

## Market APIs

### Jupiter (market price + depth)
- Dev portal: https://dev.jup.ag
- Price v3 (keyless): `https://lite-api.jup.ag/price/v3?ids=<mint>` → `{ "usdPrice": ... }`
- Price v3 (keyed): `https://api.jup.ag/price/v3?ids=<mint>` (free key at dev.jup.ag)
- Quote / depth: `https://lite-api.jup.ag/swap/v1/quote?inputMint=&outputMint=&amount=&slippageBps=`
- Note: free (keyless) tier ends 2026-06-30. Obtain a key before that date for production use.

### Helius DAS (token metadata + price fallback)
- Docs: https://docs.helius.dev
- RPC endpoint: `https://mainnet.helius-rpc.com/?api-key=<YOUR_KEY>`
- Method: `getAsset` with `displayOptions.showFungible: true` → `token_info.price_info.price_per_token`
- **Supply your own `HELIUS_API_KEY`** — the kit's bundled MCP key returns 401.
- Free tier available at https://helius.dev

---

## LST Rates

### Sanctum (LST SOL exchange rates)
- Public API: `https://sanctum-extra-api.ngrok.dev/v1/sol-value/current?lst=<mint>`
- Returns the current SOL-per-token exchange rate for major LSTs.
- Verify the current public host before shipping — the ngrok subdomain may rotate.
- Sanctum stats / coverage: https://sanctum.so
- Alternative: decode the SPL stake-pool account directly via `@solana/kit` `getAccountInfo`.

---

## @solana/kit (2026 client SDK)

- Docs: https://github.com/anza-xyz/kit
- Import pattern: `import { address, createSolanaRpc, mainnet } from '@solana/kit'`
- Token program: `import { fetchMint } from '@solana-program/token'`
- Every RPC call ends `.send()`. No `Connection`, no `PublicKey` — those are `@solana/web3.js` v1.

---

## Running This Continuously (3-line pointer)

The gate in `assess.md` is a point-in-time check. To run it continuously:

1. **Helius webhook** (`heliusStreaming` MCP tool or REST POST to `/webhooks`): subscribe to account-change events on the asset's intrinsic oracle account. On each event, re-run Step 2–4 of the gate workflow.
2. **Cloudflare Durable Object alarm**: set a recurring alarm (re-arm in `alarm()` because DO alarms are single-shot) to poll Jupiter price and re-run the gate on a schedule. Workers cron minimum granularity is 1 minute.
3. **Emit to your protocol**: post the RISK-PARAMS state change to your lending protocol's risk-parameter update path or emit an on-chain instruction to update collateral factors.

For a full monitoring implementation, see the methodology source at `github.com/lrafasouza/pegana-replay` — the production engine that runs this methodology uses Redis for EWMA state, a TimescaleDB hypertable for alert history, and Helius Geyser webhooks for real-time indexing.
