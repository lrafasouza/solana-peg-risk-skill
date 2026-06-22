# reference/ — TS port of the public peg-risk methodology

Pure TypeScript implementation of the public MIT peg-risk methodology
(`github.com/lrafasouza/pegana-replay`), plus a live mainnet demo.

## Files

| File | Purpose |
|---|---|
| `classify.ts` | Pure functions (no network). The CI gate. |
| `assess.ts` | Live mainnet demo: pull intrinsic + market → classify → print verdict. |
| `package.json` | `type: module`; deps: `@solana/kit`, `@pythnetwork/hermes-client`. |

The unit tests live in `../tests/classify.test.ts` (deterministic, no network, the CI gate).

---

## Run offline classify tests (deterministic, no API keys needed)

```bash
cd reference
npm install
npm test
# or, to run vitest in watch mode:
npx vitest ../tests/classify.test.ts
```

The test suite covers ~25–30 cases: boundary conditions, hysteresis enter/hold/exit,
LST/yield-stable premium → PEGGED, CR path, plausibility rejection, premium-sanity
UNKNOWN, zero/null intrinsic → null, and the F-12 overflow guard.

---

## Run the live mainnet demo

```bash
cd reference
npm install

# USDC (stable_fiat)
npm run demo EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# jitoSOL (lst — SOL-denominated path via Sanctum)
npm run demo J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn

# USDY (stable_yield — Pyth redemption-rate feed)
npm run demo A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6

# Optional: Helius DAS cross-check (price_info)
HELIUS_API_KEY=<your-key> npm run demo <mint>
```

`HELIUS_API_KEY` is **optional**. Without it, the demo uses the keyless
`lite-api.jup.ag` for market prices and Pyth Hermes for intrinsic. With it,
Helius DAS `price_info` is shown as an independent cross-check.

The demo prints a verdict block and a **pasteable risk-params config** block:

```
════════════════════════════════════════════════════════════
  PEG RISK ASSESSMENT: USDC
════════════════════════════════════════════════════════════
  Mint:     EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
  Class:    stable_fiat
  State:    ✅ PEGGED
  Spread:   3 bps discount
  Reason:   spread within band: 3 bps discount

  ── Inputs ──────────────────────────────────────────────
  Intrinsic:  $1.000100  (Pyth USDC/USD)
  Market:     $0.999700  (Jupiter lite-api)
  Helius DAS: $0.999700  (delta vs Jupiter: 0.0 bps)
  Depth:      $10k sell → 0.001% impact (Jupiter quote)

  ── Risk Parameters (pasteable config) ──────────────────
  asset_class:      stable_fiat
  refuse_above_bps: 50   # refuse if spread > this
  drift_bps:        15
  depeg_bps:        50
  critical_bps:     200
  oracle_staleness: 30s
  direction_sensitive: false
════════════════════════════════════════════════════════════
```

---

## Tier-2 assets (recipe, not a live adapter)

`hyUSD` (stable_cdp) and `xSOL` (synth_lev) print a recipe note instead of a live
reading. The on-chain intrinsic for these requires reading issuer-specific Hylo program
accounts; the method is documented in `../skill/computing-spread.md`.

```bash
npm run demo HYUSAiER4bv6eXDL3oHMM9QKNrVKfSTjLuemDjWQHs1N  # hyUSD → recipe
npm run demo xLfYxeGZ3eTfe4WuoH45wRFQx2iRNsWiS3hKJJCnmqn   # xSOL  → recipe
```

---

## API cheat-sheet (2026 stack)

- **Pyth Hermes** (intrinsic): `new HermesClient('https://hermes.pyth.network', {})` →
  `getLatestPriceUpdates([feedId])` → `parsed[0].price = { price, conf, expo, publish_time }`;
  value = `Number(price) * 10**expo`. Use feed **IDs** (`0x…`), not push price-accounts.

- **Jupiter lite-api** (market, keyless): `GET lite-api.jup.ag/price/v3?ids=<mint>` →
  `{ "<mint>": { usdPrice, blockId, decimals } }`. Field is **`usdPrice`**, not v2 `.price`.

- **Helius DAS** (cross-check): `POST mainnet.helius-rpc.com/?api-key=KEY`, method
  `getAsset`, `displayOptions.showFungible: true` → `result.token_info.price_info.price_per_token`.
  `price_info` can be null for thin mints.

- **Sanctum** (LST intrinsic): `GET sanctum-extra-api.ngrok.dev/v1/sol-value/current?lst=SYMBOL`
  → sol value per LST. Verify current host at https://docs.sanctum.so.

- **@solana/kit** (NOT @solana/web3.js): `import { address, createSolanaRpc, mainnet } from '@solana/kit'`;
  every call ends `.send()`. No `Connection`/`PublicKey`.

---

## Credits

Methodology: MIT, `github.com/lrafasouza/pegana-replay`

Production scar tissue behind the guards:
- F-12 (audit 2026-06-19): micro-nonzero intrinsic → overflow panic → `checked_div` / null guard
- 2026-06-12: Jupiter `out_amount=0` → discount=1.0 exactly → poisoned EWMA → JupUSD CRITICAL 7.5 min
- 2026-06-04: hyUSD oscillated DRIFT↔PEGGED 52× in 2 days → Schmitt-trigger deadband (ADR-0023)
- sHYUSD incident: +30% premium on a thin NAV print → PEGGED (masked broken intrinsic) → NAV sanity UNKNOWN
