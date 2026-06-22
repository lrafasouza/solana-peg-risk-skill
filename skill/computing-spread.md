# Computing Spread — Intrinsic and Market by Asset Class

The spread is `discount = 1 - market/intrinsic`. You need two numbers per asset: what the issuer says it is worth (`intrinsic`) and what the deepest executable venue says it trades for (`market`). Never fuse or average them — each has a distinct role.

---

## Scope Tiers

**Tier 1 — Runnable adapters** (shipped in `reference/assess.ts`):
- `stable_fiat`, `stable_fx`: intrinsic = peg target (USD=1.0 or FX cross via Pyth Hermes); market = Jupiter `usdPrice` or quote route.
- Any class whose intrinsic comes from a Pyth feed (NAV / redemption-rate `.RR` / FX cross).
- `lst`: intrinsic via Sanctum public API or stake-pool account decode; market = Jupiter SOL-denominated quote.

**Tier 2 — Documented recipe** (taught here; integrator implements the adapter):
- `stable_cdp` (hyUSD) CR path via Hylo on-chain accounts.
- `synth_lev` (xSOL) NAV via Hylo collateral accounts.

For a Tier-2 asset, `assess.ts` prints "intrinsic source not bundled — see computing-spread.md" rather than fabricating a number.

---

## 2026 API Stack

### Pyth Hermes — intrinsic for fiat, FX, NAV feeds

```typescript
import { HermesClient } from '@pythnetwork/hermes-client'

const hermes = new HermesClient('https://hermes.pyth.network', {})
const updates = await hermes.getLatestPriceUpdates([feedId])
const p = updates.parsed[0].price
// value = Number(p.price) * 10**p.expo
// confidence = Number(p.conf) * 10**p.expo
// staleness = Date.now()/1000 - p.publish_time (seconds)
```

**Use feed IDs (`0x…`), not push price-account addresses (deprecated).**

Key feed IDs (verify at https://pyth.network/price-feeds before shipping):
```
USDC/USD:     0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a
USDT/USD:     0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b
SOL/USD:      0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d
USDY/RR:      <look up the redemption-rate feed at pyth.network/price-feeds — not all yield stables publish one; some expose NAV only via the issuer's own oracle>
```

Staleness check: if `Date.now()/1000 - publish_time > max_staleness_s`, emit UNKNOWN rather than use a stale price. Recommended max: 60s for spot feeds; up to 86400s (24h) for daily-updated NAV feeds — but document the lag and flag it.

---

### Jupiter — market price (keyless and keyed)

**Keyless** (rate-limited, suitable for ad-hoc checks):
```
GET https://lite-api.jup.ag/price/v3?ids=<mint>
```
Response field: `{ "<mint>": { "usdPrice": 0.9997, "blockId": 123, "decimals": 6, "liquidity": 4200000 } }`

Note: the field is `usdPrice`, not the v2 `.price`. Thin mints may return `null` for `usdPrice`.

**Keyed** (for production use, free tier available at dev.jup.ag):
```
GET https://api.jup.ag/price/v3?ids=<mint>
```

**Depth probe** (market stress check — use this, not just spot price):
```
GET https://lite-api.jup.ag/swap/v1/quote
  ?inputMint=<asset_mint>
  &outputMint=<usdc_mint>
  &amount=<size_in_base_units>
  &slippageBps=200
```
Response: `outAmount` (raw units) + `priceImpactPct`. Probe on the thin asset side, not on SOL→USDC. A high `priceImpactPct` at a normal liquidation size signals illiquidity even if the spot price looks fine.

**LST market price in SOL**: Query the LST→SOL route on Jupiter to get the SOL-denominated market price. This cancels the SOL/USD multiplier in the discount computation (both sides denominated in SOL, no oracle synchronization race). Verified live: jitoSOL ≈ 94.36 USD, ≈ 1.115 SOL.

---

### Helius DAS — market price fallback and token metadata

**User must supply their own `HELIUS_API_KEY`** — the kit's bundled MCP key returns 401.

```typescript
const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0', id: 1,
    method: 'getAsset',
    params: { id: mint, displayOptions: { showFungible: true } }
  })
})
const data = await res.json()
const price = data.result?.token_info?.price_info?.price_per_token
// Also: data.result?.token_info?.price_info?.currency (often "USDC")
```

`price_info` can be null for thin mints — fall back to Jupiter in that case. Live-verified prices: USDC ≈ 0.9997, jitoSOL ≈ 94.33.

---

### @solana/kit — direct on-chain account reads

```typescript
import { address, createSolanaRpc, mainnet } from '@solana/kit'
import { fetchMint } from '@solana-program/token'

const rpc = createSolanaRpc(mainnet('https://api.mainnet-beta.solana.com'))
// or: createSolanaRpc(mainnet(`https://mainnet.helius-rpc.com/?api-key=${key}`))

const supply = await rpc.getTokenSupply(address(mint)).send()
const mintAccount = await fetchMint(rpc, address(mint))
```

Every call ends `.send()`. No `Connection`, no `PublicKey` — those are `@solana/web3.js` v1 patterns.

---

## Per-Class Intrinsic Recipes

### stable_fiat, stable_dn

`intrinsic = 1.0` (the peg target is exactly $1).

`market` = Jupiter `usdPrice` for the mint, or a Pyth spot feed if available.

```typescript
// intrinsic
const intrinsic = 1.0

// market via Jupiter
const resp = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mint}`)
const data = await resp.json()
const market = data[mint]?.usdPrice ?? null
```

If `market` is null, emit UNKNOWN — no market quote means no spread can be computed.

---

### stable_fx

`intrinsic` = peg target converted via a Pyth FX cross feed (e.g., EUR/USD for EURC).

```typescript
const hermes = new HermesClient('https://hermes.pyth.network', {})
const updates = await hermes.getLatestPriceUpdates([EUR_USD_FEED_ID])
const p = updates.parsed[0].price
const eurUsd = Number(p.price) * 10**p.expo
const intrinsic = eurUsd  // EURC intrinsic = 1 EUR in USD
```

`market` = Jupiter `usdPrice` for the FX stable mint.

---

### stable_yield (USDY, sUSD, syrupUSDC, sUSDe)

`intrinsic` = NAV per share, published as a Pyth `.RR` (rate/redemption) feed by the issuer.

```typescript
// USDY RR feed (verify feed ID at pyth.network/price-feeds)
const updates = await hermes.getLatestPriceUpdates([USDY_RR_FEED_ID])
const p = updates.parsed[0].price
const nav = Number(p.price) * 10**p.expo  // per-share NAV in USD
const staleness = Date.now()/1000 - p.publish_time
if (staleness > 86400) {
  // NAV is stale — but for daily-updated feeds this may be expected;
  // document the known lag and flag it in the assessment
}
```

`market` = Jupiter `usdPrice` for the yield stable mint.

Note: `market > intrinsic` (premium) normalizes to PEGGED for this class (direction-sensitive). `market > intrinsic × 1.10` (premium > 1000 bps) → UNKNOWN (broken intrinsic — see FM-5).

**syrupUSDC special case**: Maple updates this NAV once per day. Expect up to 24h of staleness for a perfectly healthy asset. Factor the known lag into your staleness threshold parameter, and document it in your risk-params output.

---

### lst (jitoSOL, mSOL, dzSOL, vSOL, INF, bbSOL)

**Intrinsic — Tier 1: Sanctum public API**

Sanctum maintains a public endpoint that returns the current SOL exchange rate for all major LSTs:

```
GET https://sanctum-extra-api.ngrok.dev/v1/sol-value/current
  ?lst=<mint>
```

Verify the current public host in `resources.md` before shipping — the ngrok subdomain may change. The response gives `sol_value` (SOL per LST token). This is the redemption-rate intrinsic.

**Intrinsic — Tier 1 fallback: stake-pool account decode**

```typescript
import { address, createSolanaRpc, mainnet } from '@solana/kit'
// Read the SPL stake-pool account for the LST's pool
// poolAccount has: totalLamports (u64), poolTokenSupply (u64)
// exchangeRate = totalLamports / poolTokenSupply (in lamports per token)
// Convert: intrinsic_sol = exchangeRate / 1e9
```

**Market — SOL-denominated path** (preferred — cancels the SOL/USD multiplier):

```
GET https://lite-api.jup.ag/swap/v1/quote
  ?inputMint=<lst_mint>
  &outputMint=So11111111111111111111111111111111111111112
  &amount=<1_token_in_base_units>
  &slippageBps=50
```
`outAmount` (in lamports) / 1e9 = SOL received per token. This is `market_sol`.

Compute `discount = 1 - market_sol / intrinsic_sol`. No SOL/USD oracle needed; the multiplier cancels.

---

### stable_cdp (hyUSD) — Tier 2 Recipe

**Spread path**: `intrinsic = 1.0` (hyUSD targets $1); `market` = Jupiter `usdPrice`. Same as stable_fiat.

**CR path** (the load-bearing signal for CDP stables):

The collateral ratio is read from Hylo's on-chain program accounts. The formula is:
```
CR = collateral_value_usd / hyusd_supply_value_usd
   = (collateral_sol × sol_usd_price) / (hyusd_supply × hyusd_price)
```

To compute this:
1. Read the Hylo stability-pool account via `rpc.getAccountInfo(hylo_pool_address).send()`.
2. Decode the account layout (issuer-specific — not provided here to avoid brittle hardcoding; consult Hylo's public program IDL or documentation).
3. Extract `total_collateral_lamports` and `hyusd_supply`.
4. Get `sol_usd` from a Pyth SOL/USD feed.
5. Compute CR as above.

This adapter code is left to the integrator because the account layout is issuer-specific and can change on program upgrades. The method above is stable; the byte offsets are not.

Pass CR to `stateForCr(cr, crThresholds)` and then through `classifyCrWithHysteresis`. The spread-path and CR-path classifications are ANDed — the more severe of the two governs.

---

### synth_lev (xSOL) — Tier 2 Recipe

xSOL is a leveraged synthetic SOL token issued by Hylo. Its intrinsic value is:

```
xsol_intrinsic = (collateral_sol - hyusd_supply_in_sol) / xsol_supply
```

Where:
- `collateral_sol` = total SOL collateral in the Hylo protocol
- `hyusd_supply_in_sol` = hyUSD total supply converted to SOL at the current SOL/USD price
- `xsol_supply` = total xSOL token supply

This formula derives from Hylo's capital structure: xSOL holders own the residual equity (collateral minus the stable liability). When the collateral buffer is large, `xsol_intrinsic` is well above 1 SOL. When CR drops toward 1, `xsol_intrinsic` approaches 0 (which is also what triggers the F-12 audit finding — a near-zero intrinsic causes a division overflow in the discount computation; the guard is `checked_div`, returning None rather than panicking).

Reading the inputs: same Hylo on-chain accounts as the hyUSD CR path, plus the xSOL mint supply via `rpc.getTokenSupply(address(xsol_mint)).send()`.

`market` = Jupiter quote for xSOL→SOL.

This adapter is left to the integrator for the same reason as hyUSD: the Hylo account layout is issuer-specific. Do not hardcode byte offsets — parse via the public IDL.

---

## Staleness and UNKNOWN

If `intrinsic` is null, zero, or older than `oracle_max_staleness_s`, do not compute a spread. Emit UNKNOWN. This is not a safe state — it means you do not have the data needed to make a determination. See FM-3 and FM-5 in `failure-modes.md`.

Recommended `oracle_max_staleness_s` defaults:
- Pyth spot feeds (SOL/USD, USDC/USD, FX crosses): 60s
- Pyth NAV/RR feeds (USDY.RR, etc.): 86400s (documented lag) — but flag the lag
- Sanctum LST rates: 300s
- Hylo on-chain reads: treat slot age as staleness proxy; >30 slots (~12s) is stale
