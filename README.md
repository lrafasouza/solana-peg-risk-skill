# solana-peg-risk-skill

A Claude Code skill that teaches a coding agent to assess depeg risk of any Solana stablecoin or liquid-staking token before integrating, accepting it as collateral, routing through it, or listing it — and to emit pasteable risk parameters the integrator ships directly to config.

[![CI](https://img.shields.io/github/actions/workflow/status/OWNER/solana-peg-risk-skill/ci.yml?branch=main&label=tests)](https://github.com/OWNER/solana-peg-risk-skill/actions/workflows/ci.yml)

---

## The 5 Ways a Naive Depeg Check Lies

A naive check asks: "is the price within X bps of $1?" This fails in five distinct ways. Every failure has a real mainnet incident attached to it.

| # | Naive assumption | How it fails | Guard | Real incident |
|---|---|---|---|---|
| FM-1 | Price vs $1 | An LST like jitoSOL legitimately trades above 1 SOL (~1.118 SOL in mid-2026); a yield stable tracks NAV, not $1. Comparing to $1 fires constant false alarms on healthy assets. | `spread = market − intrinsic`, where intrinsic is the on-chain redemption rate or NAV oracle — not $1 | jitoSOL 11.8% above $1, not stress |
| FM-2 | Any deviation = bad | A premium on an LST or yield stable is demand, not stress. Holders can redeem at intrinsic; the premium is secondary-market bid pressure. Firing on premiums generates noise on every epoch boundary. | Direction-sensitive: for `lst` and `stable_yield`, premium normalizes to PEGGED; only the discount side classifies | stETH −7% 2022 and ezETH were discounts; INF legitimate premium ~162 bps |
| FM-3 | Trust the oracle | Issuer feeds lag execution. Maple syrupUSDC publishes NAV once per day; if liquidity disappears intraday, the NAV feed stays confidently at $1.00 while spot redemptions are being haircut. | Keep an independent executable market quote; never fuse/average sources — issuer oracle = intrinsic, Jupiter/Helius = market; watch the divergence | Maple/syrupUSDC daily NAV lags intraday freeze |
| FM-4 | One tick = depeg | A Jupiter route returning `out_amount = 0` made the discount exactly `1.0`, painting JupUSD CRITICAL for 7.5 min. hyUSD's CR oscillated near 130%, generating 52 DEPEG↔DRIFT flaps over 2 days. | Plausibility filter (`\|d\| < 1.0`, strict) + EWMA α=0.4 + Schmitt-trigger deadband (escalate at threshold; relax only below `threshold × 0.75`) | JupUSD false CRITICAL 2026-06-12; hyUSD 52 flaps/2d |
| FM-5 | Confident = correct | A broken intrinsic on a direction-sensitive class publishes confident PEGGED off garbage. sHYUSD: thin-liquidity Jupiter NAV printed ~30% below real NAV → the direction-sensitive guard (premium → PEGGED) silently accepted it. | NAV-sanity: premium > 1000 bps on direction-sensitive class → UNKNOWN (broken intrinsic). Zero/null intrinsic → UNKNOWN, never discount=0. | sHYUSD +30% over thin NAV → false PEGGED |

These guards are derived from `crates/methodology/src/discount.rs` and `thresholds.rs` in the public methodology. The table above is what makes this skill different from any price feed or token-safety scanner.

---

## The Safety-Gate Use Case

A DeFi lending protocol wants to accept hyUSD as collateral. Before adding it to the collateral registry, the integrating developer runs:

```
/peg-assess HUSDm9cvmSEMBbMHpFbJwsLGKBFnM6JNXR2NHHQ7kNFi
```

The skill classifies hyUSD as `stable_cdp`, pulls the Jupiter market price and the Hylo CR from on-chain (Tier-2 recipe), runs the guards, and emits:

```
VERDICT: DEPEG
Asset:   hyUSD (HUSDm9cvmSEMBbMHpFbJwsLGKBFnM6JNXR2NHHQ7kNFi)
Class:   stable_cdp
Discount: 87 bps (discount)
CR:      126% (DEPEG — below 130% threshold)
Intrinsic: $1.00
Market:    $0.9913 (Jupiter, blockId: 312941850)
Reason:  CR below depeg threshold (130%) AND market discount at 87 bps; both paths signal DEPEG.
```

Followed by a pasteable RISK-PARAMS block:

```yaml
# RISK-PARAMS — hyUSD (partial — CR path requires Hylo on-chain adapter)
# Assessment date: 2026-06-21
# Methodology: github.com/lrafasouza/pegana-replay (MIT)

asset_class:         stable_cdp
peg_anchor:          USD
direction_sensitive: false

warn_bps:            10
refuse_bps:          30
liquidate_bps:       100

cr_warn_pct:         150
cr_refuse_pct:       130
cr_liquidate_pct:    110

oracle_max_staleness_s: 60
intrinsic_source:    fixed-usd-1.0
market_source:       jupiter-usd-price

current_state:       DEPEG
current_discount_bps: 87
assessment_confidence: medium  # degraded: CR adapter not bundled (Tier 2)
```

The integrator drops the RISK-PARAMS block directly into their protocol config. The thresholds are defaults derived from production data — the block documents what to recalibrate and why.

A second example for a healthy LST:

```
VERDICT: PEGGED
Asset:   jitoSOL (J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn)
Class:   lst
Discount: −79 bps (premium → normalizes to PEGGED — direction-sensitive)
Intrinsic: 1.1095 SOL (Sanctum, staleness: 4s)
Market:    1.1183 SOL (Jupiter quote, 1000 jitoSOL probe)
Reason:  Market is 79 bps above the redemption rate; an LST premium is demand pressure, not stress, so direction-sensitivity normalizes it to PEGGED (a symmetric check would false-alarm DRIFT).
```

```yaml
# RISK-PARAMS — jitoSOL
# Assessment date: 2026-06-21
# Methodology: github.com/lrafasouza/pegana-replay (MIT)

asset_class:         lst
peg_anchor:          SOL
direction_sensitive: true

warn_bps:            20
refuse_bps:          80
liquidate_bps:       250

oracle_max_staleness_s: 300
intrinsic_source:    sanctum-sol-value
market_source:       jupiter-lst-to-sol-quote

current_state:       PEGGED
current_discount_bps: -79    # negative = market above intrinsic (premium)
assessment_confidence: high
```

---

## What's Inside

```
solana-peg-risk-skill/
├── skill/
│   ├── SKILL.md             # router, contrast table, command/agent index
│   ├── peg-states.md        # 8 asset classes, 5 states, per-class thresholds, recalibration
│   ├── failure-modes.md     # the 5 lies + 5 guards + real incidents (full detail)
│   ├── computing-spread.md  # intrinsic + market recipes per class; Tier 1 / Tier 2
│   ├── assess.md            # gate workflow → VERDICT + RISK-PARAMS
│   └── resources.md         # API links, methodology source, operationalization pointer
├── agents/
│   └── peg-risk-analyst.md  # model: opus; runs the gate end-to-end
├── commands/
│   └── peg-assess.md        # /peg-assess <mint> imperative runbook
├── rules/
│   └── onchain-reads.md     # read-only / never-sign / devnet / untrusted-data rules
├── reference/
│   ├── classify.ts          # TS port of the public Rust methodology (pure functions)
│   ├── assess.ts            # live mainnet demo: pull → classify → print verdict + params
│   ├── package.json         # @solana/kit, @pythnetwork/hermes-client, vitest, tsx
│   └── README.md            # how to run classify tests + the live demo
└── tests/
    ├── classify.test.ts     # deterministic offline unit tests (vitest) — the CI gate
    ├── run.ts               # Haiku trigger harness (does the description route?)
    └── package.json
```

---

## Install

Personal installation (available across all your projects):

```bash
./install.sh
```

Project-scoped installation (committed to the repo):

```bash
./install.sh --project
```

Custom path:

```bash
./install.sh --path /path/to/target
```

The installer validates that `skill/SKILL.md` exists, confirms before overwriting an existing installation, and copies the `skill/` directory to the target location.

---

## Asset Coverage

**Tier 1 — Runnable adapter (`assess.ts` supports end-to-end)**

| Class | Example assets | Intrinsic source | Market source |
|---|---|---|---|
| `stable_fiat` | USDC, USDT, PYUSD, USDS | $1.00 (peg target) | Jupiter `/price/v3` `usdPrice` |
| `stable_fx` | EURT, BEUR | Pyth FX cross feed | Jupiter `usdPrice` + FX rate |
| `lst` | jitoSOL, mSOL, INF, bbSOL | Sanctum `/v1/sol-value/current` | Jupiter SOL-denominated quote probe |
| `stable_yield` (Pyth NAV) | USDY, sUSD | Pyth Hermes NAV feed | Jupiter `usdPrice` |

**Tier 2 — Documented on-chain-read recipe (`computing-spread.md`, not a shipped adapter)**

| Class | Example assets | Why Tier 2 |
|---|---|---|
| `stable_cdp` | hyUSD (CR path) | Requires Hylo program account decode; layout is issuer-specific; formula documented, adapter left to integrator |
| `synth_lev` | xSOL | Requires Hylo collateral/supply account decode; `xsol_intrinsic = (collateral_sol − hyusd_supply_in_sol) / xsol_supply`; documented, not bundled |

`assess.ts` prints `"intrinsic source not bundled — see computing-spread.md"` for Tier-2 assets rather than fabricating a number.

---

## How It Works

**Spread** is the fundamental signal:

```
discount = 1 - market / intrinsic
```

Positive discount = market below intrinsic (stress). Negative discount = premium (demand for LSTs/yield stables, or broken intrinsic — FM-5).

**5 peg states** (strictness ascending): `PEGGED · DRIFT · DEPEG · CRITICAL · BLACK_SWAN` (+ `UNKNOWN` as the fail-safe).

**Per-class spread thresholds (bps) — defaults from the MIT methodology**:

| Class | drift | depeg | critical | notes |
|---|---|---|---|---|
| `stable_fiat` | 15 | 50 | 200 | symmetric |
| `stable_cdp` | 10 | 30 | 100 | + CR path (drift 150%, depeg 130%, critical 110%) |
| `lst` | 20 | 80 | 250 | discount-only |
| `stable_yield` | — | 30 | 100 | discount-only (no drift band) |
| `synth_lev` | 100 | 300 | 1000 | symmetric |

`black_swan` defaults to 2× critical. `DEADBAND_PCT = 25`. `CR_DEADBAND_PCT = 2`. `EWMA_ALPHA = 0.4`. `NAV_PREMIUM_SANITY_BPS = 1000`.

**The guards** run in order on every tick:
1. Plausibility filter — reject `|discount| >= 1.0`
2. EWMA smoothing — attenuate single-tick spikes
3. NAV-sanity — direction-sensitive premium > 1000 bps → UNKNOWN
4. Direction-aware classification — premium on LST/yield stable → PEGGED
5. Schmitt-trigger hysteresis — escalation immediate; relaxation gated by deadband

---

## Why This Is Not the Same as Adjacent Skills

| Other skills / tools | This skill |
|---|---|
| Pyth / Switchboard skills — give you a price | Judges whether that price has **broken peg** relative to intrinsic value |
| Token-intel / rug scanners — mint, honeypot, holder safety | Judges the asset's **peg mechanism** risk (market-vs-intrinsic spread, NAV/CR) |
| jupiter-lend / kamino — a borrower's LTV / liquidation health | Judges the **collateral asset's own** peg integrity before you accept it |

---

## Reference Implementation and Tests

`reference/classify.ts` is a pure-function TypeScript port of the public Rust methodology (`crates/methodology/src/{thresholds,discount,ewma,transition}.rs`). No network, no keys — deterministic on any input.

`tests/classify.test.ts` (vitest) covers ~25–30 cases including boundary assertions for every threshold band, LST and yield-stable direction sensitivity, hysteresis enter/hold/exit for both spread and CR paths, NAV-sanity boundary, zero-intrinsic null routing, and the `|d| >= 1.0` strict plausibility bound. **89 tests, CI-green, no network dependency.**

To run the offline tests:

```bash
cd tests
npm install
npx vitest run
```

To run the live mainnet demo (needs `HELIUS_API_KEY` optional):

```bash
cd reference
npm install
HELIUS_API_KEY=your_key npx tsx assess.ts EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v  # USDC
HELIUS_API_KEY=your_key npx tsx assess.ts J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn  # jitoSOL
```

---

## Credits

Methodology: MIT license — `github.com/lrafasouza/pegana-replay` (`METHODOLOGY.md`, `crates/methodology/src/`). The classifier logic, threshold constants, guard sequence, and all incident references in this skill are derived from that public source.

APIs used as inputs (this skill cites them, does not re-implement them): Pyth Hermes, Helius DAS, Jupiter Aggregator, Sanctum, Switchboard On-Demand.

---

## License

MIT — see [LICENSE](LICENSE).
