# Peg States, Asset Classes, and Thresholds

Source: public MIT methodology — `github.com/lrafasouza/pegana-replay`, `crates/methodology/src/thresholds.rs`.

---

## 5 Peg States

| State | Strictness rank | Meaning |
|---|---|---|
| `PEGGED` | 0 | Spread within normal noise; asset mechanically sound |
| `DRIFT` | 1 | Spread exceeds baseline noise; warrants monitoring; not actionable alone |
| `DEPEG` | 2 | Material deviation; evaluate collateral haircuts or pause new positions |
| `CRITICAL` | 3 | Severe stress; refuse new collateral / routes; consider liquidation triggers |
| `BLACK_SWAN` | 4 | Extreme break (default ≥ 2× critical threshold); emergency liquidation |
| `UNKNOWN` | 0 (fail-safe) | Intrinsic missing, zero, or NAV-sanity violated; **UNKNOWN ≠ safe** |

Escalation happens immediately when the smoothed discount crosses a threshold. Relaxation (downgrade toward PEGGED) is gated by hysteresis — see constants below.

**UNKNOWN is not a safe default.** Missing or broken intrinsic data is not confirmation of a healthy peg. Treat UNKNOWN as a data-quality failure requiring manual review before accepting the asset.

---

## 8 Asset Classes

From `crates/common-verify/src/lib.rs` (`AssetClass` enum):

| Class | Anchor | Examples |
|---|---|---|
| `stable_fiat` | USD | USDC, USDT, PYUSD, USDS, USDS |
| `stable_cdp` | USD | hyUSD (Hylo) |
| `stable_rwa` | USD | Real-world-asset backed stables |
| `stable_dn` | USD | Delta-neutral stables |
| `stable_fx` | FX | EURC and other non-USD fiat stables |
| `lst` | SOL (redemption rate) | jitoSOL, mSOL, dzSOL, vSOL, INF, bbSOL |
| `synth_lev` | SOL (leveraged NAV) | xSOL (Hylo) |
| `stable_yield` | NAV (per-share) | USDY, sUSD, syrupUSDC, sUSDe |

---

## Per-Class Spread Thresholds (bps) — Defaults

These are starting-point defaults derived from production calibration. See "How to recalibrate" below.

| Class | DRIFT | DEPEG | CRITICAL | BLACK_SWAN (default) | Direction |
|---|---|---|---|---|---|
| `stable_fiat` | 15 | 50 | 200 | 400 | symmetric |
| `stable_cdp` | 10 | 30 | 100 | 200 | symmetric (also has CR path) |
| `stable_rwa` | 15 | 50 | 200 | 400 | symmetric |
| `stable_dn` | 15 | 50 | 200 | 400 | symmetric |
| `stable_fx` | 15 | 50 | 200 | 400 | symmetric |
| `lst` | 20 | 80 | 250 | 500 | **discount-only** |
| `synth_lev` | 100 | 300 | 1000 | 2000 | symmetric |
| `stable_yield` | — (discount-only) | 30 | 100 | 200 | **discount-only** |

`BLACK_SWAN` defaults to 2× critical when not explicitly set. It is overridable per asset.

**Direction-sensitive classes** (`lst`, `stable_yield`): a premium (market > intrinsic) normalizes to PEGGED — it is demand pressure or thin secondary liquidity, not redemption stress. Only the discount side classifies. The dangerous signal is `market < intrinsic` (cf. stETH −7% 2022, ezETH depeg).

---

## CR Path (CDP Stables — hyUSD)

`stable_cdp` assets like hyUSD use a collateral ratio path in addition to the spread path. The CR path thresholds are in percentage points; **lower CR = worse** (inverted from the spread path).

| State | CR threshold (%) | Direction |
|---|---|---|
| `PEGGED` | ≥ 150 | — |
| `DRIFT` | < 150 | CR dropped below routine buffer |
| `DEPEG` | < 130 | Material undercollateralization |
| `CRITICAL` | < 110 | Severe; liquidations imminent |
| `BLACK_SWAN` | < 100 | CR below par; total loss scenario |

CR deadband `CR_DEADBAND_PCT = 2`: escalate immediately when CR drops below a threshold; relax only once CR rises above `threshold × (1 + 2%)`. Example: DRIFT entry at CR < 150%; exit at CR > 153%. This collapsed hyUSD's boundary flapping from 52 transitions to ~10 transitions in the calibration window.

---

## Constants

```
DEADBAND_PCT         = 25   # spread Schmitt-trigger; exit = threshold × (1 - 0.25)
CR_DEADBAND_PCT      = 2    # CR Schmitt-trigger; exit = threshold × (1 + 0.02)
NAV_PREMIUM_SANITY_BPS = 1000  # >10% premium on direction-sensitive class = broken intrinsic → UNKNOWN
EWMA_ALPHA           = 0.4  # exponential smoothing weight on each new tick
```

EWMA note: `α = 0.4` means each new raw tick contributes 40% of the smoothed value. A single bad tick contaminates the next ~5–7 buckets at decaying weight. The plausibility filter (`|discount| < 1.0`) guards against $0 or 2× quotes entering the EWMA at all (see `failure-modes.md`).

---

## How to Recalibrate Per Asset

Thresholds are defaults, not gospel. Each boundary is where it is for a specific reason. Understanding the reason tells you how to move it.

**`stable_fiat` drift=15 bps**: USDC/USDT trade within 5–10 bps of $1 under normal conditions. 15 bps is above normal noise but below the first stress signals (~25–30 bps) seen during banking events. If your oracle reports USDC at 12 bps consistently, narrow drift to 10 bps. If you are on a thin venue with 20 bps of spread noise, widen to 25 bps but audit your market source first.

**`stable_cdp` drift=10 bps**: CDP stables have tighter operational bands than fiat stables. A 10 bps deviation in a CDP stable is not routine noise — it means the arbitrage path is stressed. Do not widen this unless the asset has a documented low-liquidity secondary market.

**`lst` drift=20 bps, depeg=80 bps**: LSTs accrue staking rewards daily. The SOL-denominated exchange rate changes in ~10–20 bps increments per epoch. A 20 bps drift threshold catches market price lagging the exchange rate update by one epoch; 80 bps depeg threshold catches illiquidity where market execution has meaningfully drifted from redemption value. INF showed a legitimate premium of ~162 bps — this stays below DRIFT on the premium side because LSTs are direction-sensitive (premium → PEGGED).

**`stable_yield` depeg=30 bps**: Yield stables have a daily-updated NAV (e.g., Maple syrupUSDC). 30 bps depeg catches a material intraday gap between NAV and executable market price. If the NAV is updated every 6–24 hours, widen slightly to account for the expected timing gap — but never widen beyond the point where a real redemption freeze would not trigger.

**`synth_lev` drift=100 bps, depeg=300 bps**: Leveraged synthetics carry high inherent volatility. The 100 bps drift threshold only flags structural deviations above normal leverage-induced noise. Recalibrate based on the leverage multiplier — higher leverage warrants wider thresholds, but also stricter monitoring frequency.

**CR path recalibration**: The 150/130/110/100% CR thresholds map to hyUSD's specific collateral structure (SOL-backed, single-liquidation-pool). For a different CDP stable, start from the issuer's documented liquidation trigger and work backward: the CRITICAL threshold should be set at or above the on-chain liquidation trigger so you receive a warning before the chain acts.

**General rule**: drift = 2× routine noise floor; depeg = point where arbitrage is visibly stressed; critical = point where protocol action (liquidation, redemption gate) is plausible; black_swan = point where partial loss has occurred or is imminent.
