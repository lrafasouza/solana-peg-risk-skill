/**
 * classify.ts — Pure TypeScript port of the public MIT peg-risk methodology.
 *
 * Source: github.com/lrafasouza/pegana-replay
 * Files ported:
 *   crates/methodology/src/thresholds.rs
 *   crates/methodology/src/discount.rs
 *   crates/methodology/src/ewma.rs
 *   crates/common-verify/src/lib.rs
 *
 * All functions are PURE (no network, no I/O, no side effects).
 * Uses plain `number` — bps are integers, discounts are floats.
 *
 * License: MIT
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * The six possible peg states emitted by the methodology.
 * Strictness rank: PEGGED/UNKNOWN = 0, DRIFT = 1, DEPEG = 2,
 * CRITICAL = 3, BLACK_SWAN = 4.
 *
 * UNKNOWN is the fail-safe: missing/zero intrinsic, broken oracle anchor,
 * or a NAV sanity violation. UNKNOWN ≠ safe — it means "we cannot tell".
 */
export type PegState =
  | 'PEGGED'
  | 'DRIFT'
  | 'DEPEG'
  | 'CRITICAL'
  | 'BLACK_SWAN'
  | 'UNKNOWN';

/**
 * The eight asset classes tracked by the methodology.
 * Each maps to an anchor: USD | FX | NAV (see `anchor()`).
 *
 * From crates/common-verify/src/lib.rs AssetClass enum.
 */
export type AssetClass =
  | 'stable_fiat'   // USDC, USDT, PYUSD — reserve-backed, USD anchor
  | 'stable_cdp'    // hyUSD — collateral-debt-position, USD anchor + CR path
  | 'stable_rwa'    // RWA-backed $1 stables, USD anchor
  | 'stable_dn'     // JupUSD, USDe — delta-neutral, USD anchor
  | 'stable_fx'     // BRZ, EURC — FX-rate peg (non-USD)
  | 'lst'           // jitoSOL, mSOL, bSOL — NAV anchor, discount-only
  | 'synth_lev'     // xSOL — variable-leverage NAV, NAV anchor
  | 'stable_yield'; // USDY, sUSD, syrupUSDC — yield-bearing, NAV anchor, discount-only

/** BPS threshold map (drift, depeg, critical, optional black_swan). */
export type Thresholds = Record<string, number>;

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Schmitt-trigger magnitude deadband for the spread (bps) path.
 *
 * WHY: A discount oscillating near a threshold causes DRIFT↔PEGGED flapping.
 * Enter the stricter state at the normal threshold; only relax once the
 * smoothed discount falls below `threshold × (1 - DEADBAND_PCT%)`.
 * 25% → e.g. drift=60 bps enters at 60, exits at 45.
 * See ADR-0023 and the JupSOL flapping incident (52→~10 transitions).
 */
export const DEADBAND_PCT = 25;

/**
 * CR-side Schmitt-trigger deadband for CR-driven assets (hyUSD).
 *
 * WHY: For CR, LOWER ratio is WORSE, so the exit band sits ABOVE the entry
 * threshold: relax only once CR rises above `threshold × (1 + CR_DEADBAND_PCT%)`.
 * Smaller than DEADBAND_PCT because CR thresholds are large (~130) — 2% ≈ 2.6pp
 * band, which collapsed ~80% of hyUSD's boundary flapping in calibration window.
 * See ADR-0023.
 */
export const CR_DEADBAND_PCT = 2;

/**
 * Maximum plausible PREMIUM (negative discount) on a direction-sensitive class
 * before the intrinsic anchor is judged broken.
 *
 * WHY: LSTs and yield stables normalize any premium to PEGGED (demand pressure;
 * holders can always redeem at intrinsic). But this silently masks a BROKEN
 * INTRINSIC — if the NAV feed reads far too low, the asset publishes a
 * confident PEGGED off garbage (sHYUSD incident: market ≈ +30% over a thin
 * Jupiter NAV print). No real LST/yield premium approaches this: arbitrage caps
 * live premiums in the low hundreds of bps (INF ≈ 162 bps is the widest
 * observed). So a premium beyond 1000 bps (10%) means the anchor is broken →
 * emit UNKNOWN, not PEGGED.
 */
export const NAV_PREMIUM_SANITY_BPS = 1000;

/**
 * Default EWMA smoothing factor (α).
 * WHY: Smooths noisy oracle ticks. Seeds at raw when no prior state exists.
 * Balances responsiveness (higher α) vs. noise rejection (lower α).
 */
export const EWMA_ALPHA = 0.4;

// ─── Utility: strictness rank ─────────────────────────────────────────────────

/**
 * Strictness rank for hysteresis comparisons.
 * Higher = more severe. Mirrors the Rust `rank()` in thresholds.rs.
 */
export function rank(s: PegState): number {
  switch (s) {
    case 'PEGGED':
    case 'UNKNOWN':
      return 0;
    case 'DRIFT':
      return 1;
    case 'DEPEG':
      return 2;
    case 'CRITICAL':
      return 3;
    case 'BLACK_SWAN':
      return 4;
  }
}

// ─── anchor() ────────────────────────────────────────────────────────────────

/**
 * Map each asset class to its consumer-facing peg anchor.
 *
 * "USD" — fixed $1 target (fiat, cdp, rwa, dn).
 * "FX"  — fixed non-USD fiat peg (fx stables).
 * "NAV" — intrinsic redemption/net-asset value (lst, stable_yield, synth_lev).
 *
 * From common-verify/src/lib.rs AssetClass::anchor().
 */
export function anchor(cls: AssetClass): 'USD' | 'FX' | 'NAV' {
  switch (cls) {
    case 'stable_fiat':
    case 'stable_cdp':
    case 'stable_rwa':
    case 'stable_dn':
      return 'USD';
    case 'stable_fx':
      return 'FX';
    case 'lst':
    case 'stable_yield':
    case 'synth_lev':
      return 'NAV';
  }
}

// ─── computeDiscount ─────────────────────────────────────────────────────────

/**
 * Compute signed discount: `1 - market / intrinsic`.
 *
 * Positive = market below intrinsic (discount/stress).
 * Negative = market above intrinsic (premium).
 *
 * For `lst` class we prefer the SOL-denominated path when both SOL values are
 * provided. WHY: intrinsic_usd and market_usd are both `Pyth(SOL/USD) × …`,
 * and Sanctum vs Jupiter may have cached different SOL/USD snapshots. Computing
 * in SOL cancels the multiplier and avoids false divergence from SOL/USD race.
 *
 * Returns `null` when `intrinsic == 0` or division would overflow.
 * WHY: a zero/absent intrinsic MUST NOT be laundered to discount=0, which the
 * state machine would read as a confirmed healthy peg (hardening H8).
 *
 * WHY (overflow guard, audit F-12): a micro-but-nonzero intrinsic (e.g. an
 * xSOL NAV ≈ 1e-27 from a Hylo CR<1 rounding residual) makes
 * `market / intrinsic` overflow. In Rust, rust_decimal's `/` panics on
 * overflow; here we guard by checking for the blowup condition and returning
 * null. In production this would crash-loop the engine during exactly the
 * depeg event the product exists to catch. null routes to "no signal / skip".
 *
 * Ported from: crates/methodology/src/discount.rs compute_discount()
 */
export function computeDiscount(
  intrinsic: number,
  market: number,
  opts: {
    intrinsicSol?: number;
    marketSol?: number;
    class: AssetClass;
  },
): number | null {
  // Guard: zero intrinsic must never be laundered to discount=0.
  if (intrinsic === 0 || !Number.isFinite(intrinsic)) {
    return null;
  }

  // LST: prefer SOL-denominated path to cancel the SOL/USD multiplier.
  if (opts.class === 'lst') {
    const iSol = opts.intrinsicSol;
    const mSol = opts.marketSol;
    if (
      iSol !== undefined &&
      mSol !== undefined &&
      iSol !== 0 &&
      Number.isFinite(iSol) &&
      Number.isFinite(mSol)
    ) {
      // F-12 overflow guard: micro intrinsic → huge ratio. rust_decimal's `/`
      // overflows to None near Decimal::MAX; JS floats stay finite, so also
      // reject implausibly large quotients (a real asset has market/intrinsic
      // near 1; |q| > 1e6 means intrinsic ≈ 0). Mirrors checked_div → None.
      const q = mSol / iSol;
      if (!Number.isFinite(q) || Math.abs(q) > 1e6) return null;
      const d = 1 - q;
      if (!Number.isFinite(d)) return null;
      return d;
    }
  }

  // Standard USD path.
  // F-12 guard: a micro-but-nonzero intrinsic (e.g. an xSOL NAV ≈ 1e-27 from a
  // Hylo CR<1 rounding residual) makes market/intrinsic explode. rust_decimal
  // panics on overflow → None; JS yields a huge finite float, so reject |q|>1e6
  // too. Faithful to checked_div → None (audit F-12). Never throws.
  const q = market / intrinsic;
  if (!Number.isFinite(q) || Math.abs(q) > 1e6) return null;
  const d = 1 - q;
  if (!Number.isFinite(d)) return null;
  return d;
}

// ─── isPlausibleDiscountSample ────────────────────────────────────────────────

/**
 * Plausibility filter for raw discount samples.
 *
 * `|discount| >= 1.0` would mean market trades at $0 (total loss) or at 2×
 * intrinsic — economically impossible for any tracked class. A real depeg
 * always leaves the asset worth something (|discount| < 1.0), so it stays
 * plausible and keeps alerting through the normal bands.
 *
 * The bound is STRICT (`<`): the inclusive `<=` historically let a single
 * $0 tick paint JupUSD CRITICAL for ~7.5 min (2026-06-12 incident, where a
 * Jupiter route returned `out_amount = 0` → discount = exactly 1.0 →
 * poisoned the α=0.3 EWMA for the next ~7 buckets).
 *
 * Ported from: crates/methodology/src/discount.rs is_plausible_discount_sample()
 */
export function isPlausibleDiscountSample(d: number): boolean {
  return Math.abs(d) < 1;
}

// ─── applyEwma ───────────────────────────────────────────────────────────────

/**
 * Apply one EWMA step.
 *
 * When `prev` is null, seeds at `raw` (first observation).
 * Otherwise: `alpha * raw + (1 - alpha) * prev`.
 *
 * WHY: smooths noisy oracle ticks. With α=0.4, a single bad quote decays
 * significantly over the next few buckets instead of painting the state for
 * the full observation window. The plausibility filter (above) is the first
 * line of defense; EWMA is the second.
 *
 * Ported from: crates/methodology/src/ewma.rs apply_ewma_pure()
 */
export function applyEwma(
  raw: number,
  prev: number | null,
  alpha: number,
): number {
  if (prev === null) return raw;
  return alpha * raw + (1 - alpha) * prev;
}

// ─── isDirectionSensitive ────────────────────────────────────────────────────

/**
 * True for classes where only the DISCOUNT side (market < intrinsic/NAV)
 * carries a risk signal.
 *
 * WHY (LST): A premium (market > redemption value) is demand pressure, not
 * stress — holders can always redeem at intrinsic. The dangerous deviation is
 * the DISCOUNT (cf. stETH −7% in 2022, ezETH depeg) where sellers outrun
 * arbitrage. So a premium normalizes to PEGGED.
 *
 * WHY (stable_yield): A yield-bearing stable (USDY, sUSD, syrupUSDC) accrues
 * over time — its NAV grows above $1. market > NAV is thin secondary liquidity
 * demand, not stress. market < NAV is the redemption-stress signal.
 *
 * Ported from: crates/methodology/src/thresholds.rs is_direction_sensitive()
 */
export function isDirectionSensitive(cls: AssetClass): boolean {
  return cls === 'lst' || cls === 'stable_yield';
}

// ─── premiumSanityViolated ────────────────────────────────────────────────────

/**
 * True when `discount` is a premium (negative) on a direction-sensitive class
 * whose magnitude exceeds NAV_PREMIUM_SANITY_BPS.
 *
 * WHY: the ADR-0021 premium→PEGGED carve-out masks broken intrinsics. If the
 * NAV/redemption feed reads far too low (sHYUSD incident: +30% over a thin
 * Jupiter NAV print), the asset would publish a confident PEGGED off garbage.
 * 1000 bps (10%) leaves >6× margin over the widest legitimate premium
 * (INF ≈ 162 bps) while still catching the sHYUSD-class masking.
 *
 * The discount (positive) side and symmetric classes return false — a real
 * market-below-NAV move is classified by the normal bands, never laundered
 * into UNKNOWN.
 *
 * Ported from: crates/methodology/src/thresholds.rs premium_sanity_violated()
 */
export function premiumSanityViolated(
  cls: AssetClass,
  discount: number,
): boolean {
  if (!(isDirectionSensitive(cls) && discount < 0)) {
    return false;
  }
  return Math.abs(discount) * 10_000 > NAV_PREMIUM_SANITY_BPS;
}

// ─── Threshold helper: lower_thresholds ──────────────────────────────────────

/**
 * Lower every band threshold by `deadbandPct` percent (integer, floored).
 * Used to build the EXIT thresholds for the Schmitt-trigger band.
 * keep = 100 - deadbandPct; new_threshold = floor(threshold * keep / 100).
 *
 * Ported from: crates/methodology/src/thresholds.rs lower_thresholds()
 */
function lowerThresholds(
  thresholds: Thresholds,
  deadbandPct: number,
): Thresholds {
  const keep = Math.max(0, 100 - Math.floor(deadbandPct));
  const result: Thresholds = {};
  for (const [k, v] of Object.entries(thresholds)) {
    result[k] = Math.floor(v * keep / 100);
  }
  return result;
}

/**
 * Raise every band threshold by `deadbandPct` percent (integer, floored).
 * Used for CR exit thresholds: a LOWER ratio is WORSE, so the exit band
 * sits ABOVE the entry threshold.
 *
 * Ported from: crates/methodology/src/thresholds.rs raise_thresholds()
 */
function raiseThresholds(
  thresholds: Thresholds,
  deadbandPct: number,
): Thresholds {
  const result: Thresholds = {};
  for (const [k, v] of Object.entries(thresholds)) {
    result[k] = Math.floor(v * (100 + Math.floor(deadbandPct)) / 100);
  }
  return result;
}

// ─── stateForBpsDiscount ─────────────────────────────────────────────────────

/**
 * Convert a smoothed discount to a PegState using BPS thresholds.
 *
 * `discount = 1 - market/intrinsic`. |discount| is what matters for
 * symmetric classes. Use `stateForBpsDiscountAware` for direction-sensitive
 * classes.
 *
 * BLACK_SWAN defaults to 2× critical when not explicitly set. This makes the
 * fifth state reachable from spread (a USDC 4%+ break, a UST-style cascade),
 * not only from the CR path (hyUSD). It re-labels only the most extreme moves;
 * nothing at or below critical changes. See ADR-0025.
 *
 * Threshold map accepts both unsuffixed (`drift`) and suffixed (`drift_bps`)
 * keys for forward-compatibility. Defaults: drift=20, depeg=100, critical=300.
 *
 * Ported from: crates/methodology/src/thresholds.rs state_for_bps_discount()
 */
export function stateForBpsDiscount(
  discount: number,
  thresholds: Thresholds,
): PegState {
  const absBps = Math.floor(Math.abs(discount) * 10_000);

  const drift = thresholds['drift'] ?? thresholds['drift_bps'] ?? 20;
  const depeg = thresholds['depeg'] ?? thresholds['depeg_bps'] ?? 100;
  const critical = thresholds['critical'] ?? thresholds['critical_bps'] ?? 300;
  // BLACK_SWAN: default = 2× critical (methodology 0.4.0).
  const blackSwan =
    thresholds['black_swan'] ?? thresholds['black_swan_bps'] ?? critical * 2;

  if (absBps >= blackSwan) return 'BLACK_SWAN';
  if (absBps >= critical) return 'CRITICAL';
  if (absBps >= depeg) return 'DEPEG';
  if (absBps >= drift) return 'DRIFT';
  return 'PEGGED';
}

// ─── stateForBpsDiscountAware ─────────────────────────────────────────────────

/**
 * Direction-aware variant of stateForBpsDiscount.
 *
 * For direction-sensitive classes (lst, stable_yield) a premium (negative
 * discount) normalizes to PEGGED. For all other classes delegates to the
 * abs() form.
 *
 * WHY: an LST trading at a premium means demand outpaces secondary supply —
 * not a redemption-stress signal. The risk side is the discount where sellers
 * outrun arbitrage (cf. stETH 2022, ezETH depeg).
 *
 * Ported from: crates/methodology/src/thresholds.rs state_for_bps_discount_aware()
 */
export function stateForBpsDiscountAware(
  cls: AssetClass,
  discount: number,
  thresholds: Thresholds,
): PegState {
  if (isDirectionSensitive(cls) && discount < 0) {
    return 'PEGGED';
  }
  return stateForBpsDiscount(discount, thresholds);
}

// ─── stateForCr ──────────────────────────────────────────────────────────────

/**
 * CR-based state for hyUSD-style CDP stables.
 * Thresholds in percentage points (e.g. 150 = 150%).
 *
 * WHY: for collateral-ratio-driven assets the risk signal is the CR falling
 * below safety bands, not the market price diverging from $1. A CR of 100%
 * means the protocol is exactly at parity; below that is under-collateralized.
 * This is the INVERTED path: lower CR = worse.
 *
 * IMPORTANT: `state_for_cr`'s `<` comparisons are INTENTIONAL. DRIFT fires at
 * CR < 150 (not ≤). The 2026-06-19 attempt to change `<` to `<=` was a
 * regression (caught by /code-review + reverted before deploy). Do NOT change.
 *
 * Defaults: drift=150, depeg=130, critical=110, black_swan=100.
 * Accepts both unsuffixed (`drift`) and prefixed (`cr_drift`) keys.
 *
 * Ported from: crates/methodology/src/thresholds.rs state_for_cr()
 */
export function stateForCr(
  cr: number,
  thresholds: Thresholds,
): PegState {
  const drift = thresholds['drift'] ?? thresholds['cr_drift'] ?? 150;
  const depeg = thresholds['depeg'] ?? thresholds['cr_depeg'] ?? 130;
  const critical = thresholds['critical'] ?? thresholds['cr_critical'] ?? 110;
  const blackSwan = thresholds['black_swan'] ?? thresholds['cr_black_swan'] ?? 100;

  // Convert CR to integer percent, clamped ≥ 0.
  const crPct = Math.max(0, Math.floor(cr * 100));

  // INTENTIONAL strict `<` — do NOT change to `<=`.
  // CR path: lower = worse (inverted vs bps path).
  if (crPct < blackSwan) return 'BLACK_SWAN';
  if (crPct < critical) return 'CRITICAL';
  if (crPct < depeg) return 'DEPEG';
  if (crPct < drift) return 'DRIFT';
  return 'PEGGED';
}

// ─── classifyWithHysteresis ────────────────────────────────────────────────────

/**
 * Schmitt-trigger magnitude hysteresis over stateForBpsDiscountAware.
 *
 * WHY: time-based hysteresis (confirm_up/decay_down in the engine) suppresses
 * brief spikes but NOT a signal that sits and oscillates around a threshold —
 * that flaps (JupSOL: DRIFT↔PEGGED around 60 bps). A magnitude deadband fixes
 * it: escalate to a stricter state at the normal threshold, but only relax
 * back once the discount falls below `threshold × (1 - deadbandPct%)`.
 *
 * Key invariant: deadband NEVER slows escalation. Only relaxation is gated.
 * Time-hysteresis (confirm_up_secs) already debounces the way up.
 *
 * `deadbandPct = 0` reduces to the plain `stateForBpsDiscountAware` classification.
 *
 * Ported from: crates/methodology/src/thresholds.rs classify_with_hysteresis()
 */
export function classifyWithHysteresis(
  cls: AssetClass,
  discount: number,
  thresholds: Thresholds,
  current: PegState,
  deadbandPct: number,
): PegState {
  const raw = stateForBpsDiscountAware(cls, discount, thresholds);

  // Escalation (or no change): react at the normal threshold.
  // The deadband must NEVER slow a worsening peg.
  if (rank(raw) >= rank(current)) {
    return raw;
  }

  // Relaxation: only allow it once the discount falls below the
  // deadband-lowered (exit) thresholds.
  const exitThresholds = lowerThresholds(thresholds, deadbandPct);
  return stateForBpsDiscountAware(cls, discount, exitThresholds);
}

// ─── classifyCrWithHysteresis ─────────────────────────────────────────────────

/**
 * CR magnitude-hysteresis (Schmitt-trigger) over stateForCr.
 *
 * WHY: a CR-driven asset (hyUSD) whose ratio sits a few points above the
 * drift band flaps PEGGED↔DRIFT as oracle jitter clips the threshold. Time-
 * hysteresis debounces brief spikes but NOT sustained oscillation. A magnitude
 * deadband fixes it: escalate (CR dropping = worse) at the normal threshold,
 * but only relax once CR rises above `threshold × (1 + deadbandPct%)`.
 *
 * The exit band is RAISED (not lowered) because for CR lower = worse, so the
 * safe exit side is a HIGHER CR. This mirrors classify_with_hysteresis with
 * the band inverted.
 *
 * Key invariant: deadband NEVER slows escalation. Only relaxation is gated.
 *
 * Ported from: crates/methodology/src/thresholds.rs classify_cr_with_hysteresis()
 */
export function classifyCrWithHysteresis(
  cr: number,
  thresholds: Thresholds,
  current: PegState,
  deadbandPct: number,
): PegState {
  const raw = stateForCr(cr, thresholds);

  // Escalation (or no change): react at the normal threshold.
  // Never let the deadband slow a worsening (dropping-CR) peg.
  if (rank(raw) >= rank(current)) {
    return raw;
  }

  // Relaxation (rising CR): only allow it once CR clears the deadband-raised
  // (exit) thresholds, so a CR oscillating just above its band sticks instead
  // of flapping back to PEGGED.
  const exitThresholds = raiseThresholds(thresholds, deadbandPct);
  return stateForCr(cr, exitThresholds);
}

// ─── Top-level classify() ─────────────────────────────────────────────────────

/**
 * Input to the classify() pipeline.
 *
 * `intrinsic`: issuer-controlled reference value (NAV / redemption rate / $1 / CR).
 * `market`:    secondary-market quote (Jupiter usdPrice or SOL-path).
 * `cr`:        collateral ratio (0.0–∞) for CDP stables (hyUSD). If provided,
 *              the CR path is run alongside the spread path and the stricter
 *              result is returned.
 * `intrinsicSol`, `marketSol`: SOL-denominated values for LST (cancels SOL/USD race).
 * `current`:   current smoothed PegState (for hysteresis). Defaults to PEGGED.
 * `deadbandPct`: override for the Schmitt-trigger deadband. Defaults to DEADBAND_PCT.
 */
export interface ClassifyInput {
  class: AssetClass;
  intrinsic: number;
  market: number;
  cr?: number;
  intrinsicSol?: number;
  marketSol?: number;
  thresholds?: Thresholds;
  crThresholds?: Thresholds;
  current?: PegState;
  deadbandPct?: number;
}

/**
 * Result of the classify() pipeline.
 *
 * `state`:      the computed PegState.
 * `discountBps`: |discount| × 10000 as an integer, or null if intrinsic=0.
 * `direction`:  'premium' (market > intrinsic), 'discount' (market < intrinsic),
 *               'neutral', or 'unknown' (null discount).
 * `reason`:     human-readable explanation of how the state was reached.
 */
export interface ClassifyResult {
  state: PegState;
  discountBps: number | null;
  direction: 'premium' | 'discount' | 'neutral' | 'unknown';
  reason: string;
}

/**
 * Default per-class BPS thresholds (drift / depeg / critical; black_swan = 2×critical).
 * These are DEFAULTS, not gospel — recalibrate per asset using historical data.
 * Ported from METHODOLOGY.md per-class defaults.
 */
export const DEFAULT_THRESHOLDS: Record<AssetClass, Thresholds> = {
  stable_fiat:  { drift: 15,  depeg: 50,  critical: 200  },
  stable_cdp:   { drift: 10,  depeg: 30,  critical: 100  },
  stable_rwa:   { drift: 15,  depeg: 50,  critical: 200  },
  stable_dn:    { drift: 20,  depeg: 100, critical: 300  },
  stable_fx:    { drift: 20,  depeg: 100, critical: 300  },
  lst:          { drift: 20,  depeg: 80,  critical: 250  },
  synth_lev:    { drift: 100, depeg: 300, critical: 1000 },
  stable_yield: { drift: 20,  depeg: 30,  critical: 100  },
};

/**
 * Default CR thresholds for hyUSD-style CDP stables.
 * CR in percentage points (e.g. 150 = 150%).
 * Lower CR = worse (inverted). black_swan < critical < depeg < drift.
 */
export const DEFAULT_CR_THRESHOLDS: Thresholds = {
  cr_drift:      150,
  cr_depeg:      130,
  cr_critical:   110,
  cr_black_swan: 100,
};

/**
 * Wires the full classification pipeline:
 *   computeDiscount → isPlausibleDiscountSample → premiumSanityViolated (→ UNKNOWN)
 *   → stateForBpsDiscountAware / classifyWithHysteresis
 *   → optionally classifyCrWithHysteresis (for CDP stables)
 *   → returns { state, discountBps, direction, reason }
 *
 * The CR path runs when `input.cr` is provided AND the asset class is
 * `stable_cdp`. The STRICTER of the spread state and CR state is returned.
 *
 * Failure modes handled:
 *   - Zero/null intrinsic → UNKNOWN (never launder to discount=0).
 *   - Overflow in discount computation → UNKNOWN.
 *   - Implausible sample (|d| ≥ 1) → UNKNOWN (the $0 / 2× boundary).
 *   - NAV premium sanity violation → UNKNOWN (broken intrinsic anchor).
 *   - Real premium on direction-sensitive class → PEGGED (demand pressure).
 */
export function classify(input: ClassifyInput): ClassifyResult {
  const cls = input.class;
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS[cls];
  const crThresholds = input.crThresholds ?? DEFAULT_CR_THRESHOLDS;
  const current: PegState = input.current ?? 'PEGGED';
  const deadbandPct = input.deadbandPct ?? DEADBAND_PCT;

  // Step 1: compute discount.
  const discount = computeDiscount(input.intrinsic, input.market, {
    intrinsicSol: input.intrinsicSol,
    marketSol: input.marketSol,
    class: cls,
  });

  if (discount === null) {
    return {
      state: 'UNKNOWN',
      discountBps: null,
      direction: 'unknown',
      reason:
        'intrinsic is zero, absent, or division would overflow — cannot compute spread (H8: missing data ≠ confirming data)',
    };
  }

  const discountBps = Math.floor(Math.abs(discount) * 10_000);
  const direction: ClassifyResult['direction'] =
    discount > 1e-9
      ? 'discount'
      : discount < -1e-9
        ? 'premium'
        : 'neutral';

  // Step 2: plausibility filter.
  // WHY: |d| ≥ 1.0 means market at $0 or 2× intrinsic — economically impossible.
  // A Jupiter route returning out_amount=0 produced discount=1.0 exactly, poisoning
  // the EWMA and painting JupUSD CRITICAL for 7.5 min (2026-06-12 incident).
  if (!isPlausibleDiscountSample(discount)) {
    return {
      state: 'UNKNOWN',
      discountBps,
      direction,
      reason: `discount magnitude ${discountBps} bps (|d|=${Math.abs(discount).toFixed(4)}) ≥ 1.0 is implausible — market at $0 or 2× intrinsic; rejecting to avoid EWMA contamination`,
    };
  }

  // Step 3: NAV premium sanity check.
  // WHY: the direction-sensitive carve-out (premium → PEGGED) would mask a
  // broken intrinsic. If |premium| > 1000 bps on an LST or yield stable, the
  // anchor is broken, not the market bidding it up (sHYUSD incident).
  if (premiumSanityViolated(cls, discount)) {
    return {
      state: 'UNKNOWN',
      discountBps,
      direction,
      reason: `premium of ${discountBps} bps on a direction-sensitive class exceeds NAV sanity bound (${NAV_PREMIUM_SANITY_BPS} bps) — intrinsic anchor is likely broken (sHYUSD incident); emitting UNKNOWN instead of masking as PEGGED`,
    };
  }

  // Step 4: classify spread state with hysteresis.
  const spreadState = classifyWithHysteresis(
    cls,
    discount,
    thresholds,
    current,
    deadbandPct,
  );

  // Step 5: CR path for CDP stables (hyUSD).
  // Run when `cr` is provided. Stricter of spread or CR wins.
  if (input.cr !== undefined && input.cr !== null && cls === 'stable_cdp') {
    const crState = classifyCrWithHysteresis(
      input.cr,
      crThresholds,
      current,
      CR_DEADBAND_PCT,
    );
    const finalState = rank(crState) >= rank(spreadState) ? crState : spreadState;
    const crPct = Math.floor(input.cr * 100);
    const driver = rank(crState) >= rank(spreadState) ? 'CR' : 'spread';
    return {
      state: finalState,
      discountBps,
      direction,
      reason: `${driver}-driven: spread=${spreadState}(${discountBps} bps), CR=${crState}(${crPct}%); taking stricter`,
    };
  }

  // Build reason string.
  let reason: string;
  if (direction === 'premium' && isDirectionSensitive(cls)) {
    reason = `premium of ${discountBps} bps on direction-sensitive class → PEGGED (demand pressure, not redemption stress; LST/yield-stable carve-out)`;
  } else if (spreadState === 'PEGGED') {
    reason = `spread within band: ${discountBps} bps ${direction}`;
  } else {
    reason = `spread ${direction} ${discountBps} bps → ${spreadState}`;
  }

  return {
    state: spreadState,
    discountBps,
    direction,
    reason,
  };
}
