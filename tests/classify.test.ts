/**
 * classify.test.ts — Deterministic offline unit tests for classify.ts.
 *
 * The CI gate: no network, no API keys, no side effects.
 * ~30 cases ported from the Rust test suite in thresholds.rs + discount.rs + ewma.rs.
 *
 * Run: vitest run tests/classify.test.ts
 *   or: cd reference && npm test
 */

import { describe, it, expect } from 'vitest';
import {
  computeDiscount,
  isPlausibleDiscountSample,
  applyEwma,
  isDirectionSensitive,
  premiumSanityViolated,
  stateForBpsDiscount,
  stateForBpsDiscountAware,
  stateForCr,
  classifyWithHysteresis,
  classifyCrWithHysteresis,
  classify,
  rank,
  anchor,
  DEADBAND_PCT,
  CR_DEADBAND_PCT,
  NAV_PREMIUM_SANITY_BPS,
  EWMA_ALPHA,
  DEFAULT_THRESHOLDS,
} from '../reference/classify.js';

// ─── Shared threshold fixtures (mirrors Rust test helpers) ────────────────────

function bpsThresholds() {
  return { drift_bps: 20, depeg_bps: 100, critical_bps: 300 };
}

function crThresholds() {
  return {
    cr_drift: 150,
    cr_depeg: 130,
    cr_critical: 110,
    cr_black_swan: 100,
  };
}

// JupSOL-calibration thresholds used to verify Schmitt-trigger.
function jupThresholds() {
  return { drift: 60, depeg: 150, critical: 300 };
}

// ─── Constants ────────────────────────────────────────────────────────────────

describe('constants', () => {
  it('DEADBAND_PCT = 25', () => expect(DEADBAND_PCT).toBe(25));
  it('CR_DEADBAND_PCT = 2', () => expect(CR_DEADBAND_PCT).toBe(2));
  it('NAV_PREMIUM_SANITY_BPS = 1000', () => expect(NAV_PREMIUM_SANITY_BPS).toBe(1000));
  it('EWMA_ALPHA = 0.4', () => expect(EWMA_ALPHA).toBe(0.4));
});

// ─── anchor() ────────────────────────────────────────────────────────────────

describe('anchor()', () => {
  it('stable_fiat → USD', () => expect(anchor('stable_fiat')).toBe('USD'));
  it('stable_cdp → USD', () => expect(anchor('stable_cdp')).toBe('USD'));
  it('stable_rwa → USD', () => expect(anchor('stable_rwa')).toBe('USD'));
  it('stable_dn → USD', () => expect(anchor('stable_dn')).toBe('USD'));
  it('stable_fx → FX', () => expect(anchor('stable_fx')).toBe('FX'));
  it('lst → NAV', () => expect(anchor('lst')).toBe('NAV'));
  it('stable_yield → NAV', () => expect(anchor('stable_yield')).toBe('NAV'));
  it('synth_lev → NAV', () => expect(anchor('synth_lev')).toBe('NAV'));
});

// ─── computeDiscount ─────────────────────────────────────────────────────────

describe('computeDiscount()', () => {
  // Port of: zero_intrinsic_returns_none (discount.rs)
  it('zero intrinsic → null (never launder to discount=0)', () => {
    expect(computeDiscount(0, 1, { class: 'stable_fiat' })).toBeNull();
  });

  // Port of: stable_uses_usd_path
  it('1% discount: intrinsic=1.00 market=0.99 → 0.01', () => {
    const d = computeDiscount(1.0, 0.99, { class: 'stable_fiat' });
    expect(d).not.toBeNull();
    expect(Math.abs(d! - 0.01)).toBeLessThan(1e-9);
  });

  // Port of: lst_prefers_sol_path_when_both_present
  it('LST: SOL path cancels SOL/USD multiplier when both provided', () => {
    // USD path would show drift; SOL path shows 0.
    const d = computeDiscount(111.7, 112.57, {
      class: 'lst',
      intrinsicSol: 1.117,
      marketSol: 1.117,
    });
    expect(d).not.toBeNull();
    // SOL path: 1 - 1.117/1.117 = 0
    expect(Math.abs(d!)).toBeLessThan(1e-9);
  });

  // Port of: lst_falls_back_to_usd_when_sol_missing
  it('LST falls back to USD path when SOL values missing', () => {
    const d = computeDiscount(1.10, 1.09, { class: 'lst' });
    expect(d).not.toBeNull();
    // 1 - 1.09/1.10 ≈ 0.00909...
    expect(Math.abs(d! - (1 - 1.09 / 1.10))).toBeLessThan(1e-6);
  });

  // Port of: micro_nonzero_intrinsic_returns_none_not_panic (F-12 regression)
  it('F-12: micro intrinsic (1e-27) → null, not throw (overflow guard)', () => {
    // An xSOL NAV ≈ 1e-27 from Hylo CR<1 rounding residual would cause
    // rust_decimal `/` to panic (crash-loop the engine). Must return null.
    const d = computeDiscount(1e-27, 200, { class: 'synth_lev' });
    // market/intrinsic = 2e29: a finite JS float, but implausibly large → the
    // |q|>1e6 guard returns null, mirroring rust_decimal checked_div → None.
    expect(d).toBeNull();
    // Same on the LST SOL-denominated path: m_sol / i_sol = 200 / 1e-27 → null.
    expect(
      computeDiscount(200, 200, { class: 'lst', intrinsicSol: 1e-27, marketSol: 200 }),
    ).toBeNull();
  });

  it('F-12: Infinity intrinsic → null', () => {
    expect(computeDiscount(Infinity, 1, { class: 'stable_fiat' })).toBeNull();
  });

  it('F-12: NaN intrinsic → null', () => {
    expect(computeDiscount(NaN, 1, { class: 'stable_fiat' })).toBeNull();
  });
});

// ─── isPlausibleDiscountSample ────────────────────────────────────────────────

describe('isPlausibleDiscountSample()', () => {
  // Port of: plausibility_rejects_total_loss_and_doubling_boundary (discount.rs)
  it('discount = 1.0 (market=$0) → false (strict <)', () => {
    expect(isPlausibleDiscountSample(1.0)).toBe(false);
  });

  it('discount = -1.0 (market=2×) → false', () => {
    expect(isPlausibleDiscountSample(-1.0)).toBe(false);
  });

  it('discount = 0.97 (severe but real depeg) → true', () => {
    expect(isPlausibleDiscountSample(0.97)).toBe(true);
  });

  it('discount = -0.97 → true', () => {
    expect(isPlausibleDiscountSample(-0.97)).toBe(true);
  });

  // Port of: plausibility_rejects_huge_samples
  it('discount = -1160.47 → false', () => {
    expect(isPlausibleDiscountSample(-1160.47)).toBe(false);
  });

  it('discount = 2.5 → false', () => {
    expect(isPlausibleDiscountSample(2.5)).toBe(false);
  });

  it('discount = 0.0024 → true', () => {
    expect(isPlausibleDiscountSample(0.0024)).toBe(true);
  });
});

// ─── applyEwma ───────────────────────────────────────────────────────────────

describe('applyEwma()', () => {
  // Port of: seeds_at_raw_when_no_prev (ewma.rs)
  it('no prev → seeds at raw', () => {
    expect(applyEwma(0.01, null, 0.3)).toBe(0.01);
  });

  // Port of: classic_blend
  it('classic blend: 0.3*0 + 0.7*0.01 = 0.007', () => {
    const r = applyEwma(0, 0.01, 0.3);
    expect(Math.abs(r - 0.007)).toBeLessThan(1e-12);
  });

  // Port of: alpha_zero_returns_prev
  it('alpha=0 → returns prev', () => {
    expect(applyEwma(999, 0.005, 0)).toBe(0.005);
  });

  // Port of: alpha_one_returns_raw
  it('alpha=1 → returns raw', () => {
    expect(applyEwma(0.999, 0.005, 1)).toBe(0.999);
  });
});

// ─── isDirectionSensitive ────────────────────────────────────────────────────

describe('isDirectionSensitive()', () => {
  it('lst → true', () => expect(isDirectionSensitive('lst')).toBe(true));
  it('stable_yield → true', () => expect(isDirectionSensitive('stable_yield')).toBe(true));
  it('stable_fiat → false', () => expect(isDirectionSensitive('stable_fiat')).toBe(false));
  it('stable_cdp → false', () => expect(isDirectionSensitive('stable_cdp')).toBe(false));
  it('synth_lev → false', () => expect(isDirectionSensitive('synth_lev')).toBe(false));
});

// ─── premiumSanityViolated ────────────────────────────────────────────────────

describe('premiumSanityViolated()', () => {
  // Port of: premium_sanity_flags_broken_intrinsic_on_direction_sensitive
  it('sHYUSD-class: −30% premium on stable_yield → true (broken anchor)', () => {
    expect(premiumSanityViolated('stable_yield', -0.30)).toBe(true);
  });

  it('−30% premium on lst → true (broken anchor)', () => {
    expect(premiumSanityViolated('lst', -0.30)).toBe(true);
  });

  // Port of: premium_sanity_allows_real_premiums
  it('INF ≈ −162 bps on lst → false (legitimate premium must pass)', () => {
    expect(premiumSanityViolated('lst', -0.0162)).toBe(false);
  });

  it('exactly −10% on lst → false (boundary: 1000 bps is NOT exceeded)', () => {
    // Math: |-0.10| * 10000 = 1000, and 1000 > 1000 is false.
    expect(premiumSanityViolated('lst', -0.10)).toBe(false);
  });

  it('−10.01% on lst → true (just past boundary)', () => {
    expect(premiumSanityViolated('lst', -0.1001)).toBe(true);
  });

  // Port of: premium_sanity_ignores_discount_side_and_symmetric_classes
  it('discount side (positive) on stable_yield → false (real depeg, not masked)', () => {
    expect(premiumSanityViolated('stable_yield', 0.30)).toBe(false);
  });

  it('−30% on stable_fiat → false (symmetric class, not direction-sensitive)', () => {
    expect(premiumSanityViolated('stable_fiat', -0.30)).toBe(false);
  });
});

// ─── stateForBpsDiscount ─────────────────────────────────────────────────────

describe('stateForBpsDiscount()', () => {
  const t = bpsThresholds(); // drift=20, depeg=100, critical=300

  // Port of: bps_pegged, bps_drift, bps_depeg, bps_critical_negative
  it('10 bps → PEGGED', () => expect(stateForBpsDiscount(0.0010, t)).toBe('PEGGED'));
  it('50 bps → DRIFT', () => expect(stateForBpsDiscount(0.0050, t)).toBe('DRIFT'));
  it('150 bps → DEPEG', () => expect(stateForBpsDiscount(0.0150, t)).toBe('DEPEG'));
  it('−350 bps → CRITICAL (abs)', () => expect(stateForBpsDiscount(-0.0350, t)).toBe('CRITICAL'));

  // Port of: bps_black_swan_default_is_two_times_critical
  it('650 bps ≥ 2×300 → BLACK_SWAN (default black_swan=2×critical)', () => {
    expect(stateForBpsDiscount(0.0650, t)).toBe('BLACK_SWAN');
  });

  it('500 bps: ≥ critical(300) but < black_swan(600) → CRITICAL', () => {
    expect(stateForBpsDiscount(0.0500, t)).toBe('CRITICAL');
  });

  // Port of: bps_black_swan_explicit_key_overrides_default
  it('explicit black_swan_bps=500 overrides default', () => {
    const t2 = { ...t, black_swan_bps: 500 };
    expect(stateForBpsDiscount(0.0450, t2)).toBe('CRITICAL'); // 450 < 500
    expect(stateForBpsDiscount(0.0550, t2)).toBe('BLACK_SWAN'); // 550 ≥ 500
  });
});

// ─── stateForBpsDiscountAware ─────────────────────────────────────────────────

describe('stateForBpsDiscountAware()', () => {
  const t = bpsThresholds();

  // Port of: yield_class_ignores_premium_side
  it('stable_yield: premium (negative discount) → PEGGED', () => {
    expect(stateForBpsDiscountAware('stable_yield', -0.0200, t)).toBe('PEGGED');
  });

  it('stable_yield: discount side classifies normally (200 bps → DEPEG)', () => {
    expect(stateForBpsDiscountAware('stable_yield', 0.0200, t)).toBe('DEPEG');
  });

  // Port of: lst_ignores_premium_side
  it('lst: premium (−150 bps) → PEGGED (demand pressure, not stress)', () => {
    expect(stateForBpsDiscountAware('lst', -0.0150, t)).toBe('PEGGED');
  });

  it('lst: discount (150 bps) → DEPEG (real stress signal)', () => {
    expect(stateForBpsDiscountAware('lst', 0.0150, t)).toBe('DEPEG');
  });

  it('stable_fiat: symmetric — negative discount still classifies', () => {
    expect(stateForBpsDiscountAware('stable_fiat', -0.0150, t)).toBe('DEPEG');
  });
});

// ─── stateForCr ──────────────────────────────────────────────────────────────

describe('stateForCr()', () => {
  const t = crThresholds(); // drift=150, depeg=130, critical=110, black_swan=100

  // Port of: cr_healthy, cr_drift, cr_critical, cr_black_swan
  it('CR = 2.0 (200%) → PEGGED', () => expect(stateForCr(2.0, t)).toBe('PEGGED'));
  it('CR = 1.40 (140%) → DRIFT', () => expect(stateForCr(1.40, t)).toBe('DRIFT'));
  it('CR = 1.05 (105%) → CRITICAL', () => expect(stateForCr(1.05, t)).toBe('CRITICAL'));
  it('CR = 0.95 (95%) → BLACK_SWAN', () => expect(stateForCr(0.95, t)).toBe('BLACK_SWAN'));

  // Port of: cr_one_reads_as_critical_h2_consequence
  // WHY: synthesizing CR=1.0 from missing data used to fire a FALSE Critical.
  // The H2 fix (engine skip-on-missing) prevents this, but the arithmetic
  // must stay correct to catch any regression.
  it('CR = 1.0 (100%) → CRITICAL (H2 consequence: synthesized value fires false alert)', () => {
    expect(stateForCr(1.0, t)).toBe('CRITICAL');
  });

  it('CR = 1.30 (130%) → DEPEG (border: crPct < depeg=130 is false → DRIFT)', () => {
    // crPct = floor(1.30 * 100) = 130; 130 < 130 is false → not DEPEG → check drift: 130 < 150 → DRIFT
    expect(stateForCr(1.30, t)).toBe('DRIFT');
  });

  it('CR = 1.29 (129%) → DEPEG', () => {
    // crPct = floor(1.29 * 100) = 129; 129 < 130 → DEPEG
    expect(stateForCr(1.29, t)).toBe('DEPEG');
  });
});

// ─── classifyWithHysteresis ────────────────────────────────────────────────────

describe('classifyWithHysteresis()', () => {
  const t = jupThresholds(); // drift=60, depeg=150, critical=300

  // Port of: hysteresis_enters_drift_at_normal_threshold
  it('from PEGGED: escalation uses full threshold — 65 bps ≥ 60 → DRIFT', () => {
    expect(classifyWithHysteresis('lst', 0.0065, t, 'PEGGED', 25)).toBe('DRIFT');
  });

  // Port of: hysteresis_holds_drift_inside_deadband
  // drift entry=60, exit=60×0.75=45; at 50 bps: below entry but above exit → stay DRIFT
  it('DRIFT: 50 bps (in deadband, between exit=45 and entry=60) → hold DRIFT', () => {
    expect(classifyWithHysteresis('lst', 0.0050, t, 'DRIFT', 25)).toBe('DRIFT');
  });

  // Port of: hysteresis_repegs_below_exit_threshold
  // 40 bps < exit(45) → repeg to PEGGED
  it('DRIFT: 40 bps (< exit=45) → repeg to PEGGED', () => {
    expect(classifyWithHysteresis('lst', 0.0040, t, 'DRIFT', 25)).toBe('PEGGED');
  });

  // Port of: hysteresis_escalates_without_deadband
  it('deadband must NEVER slow escalation: PEGGED → DEPEG at 160 bps', () => {
    expect(classifyWithHysteresis('lst', 0.0160, t, 'PEGGED', 25)).toBe('DEPEG');
  });

  // Port of: hysteresis_steps_down_one_band_with_deadband
  it('from DEPEG: 140 bps (below entry=150, above exit=112) → stay DEPEG', () => {
    expect(classifyWithHysteresis('lst', 0.0140, t, 'DEPEG', 25)).toBe('DEPEG');
  });

  it('from DEPEG: 100 bps (< depeg-exit=112) → exit DEPEG → check drift-exit=45: ≥ → DRIFT', () => {
    expect(classifyWithHysteresis('lst', 0.0100, t, 'DEPEG', 25)).toBe('DRIFT');
  });

  // Port of: hysteresis_zero_deadband_is_plain_classification
  it('deadband=0 → plain classification: 50 bps < drift(60), current DRIFT → PEGGED', () => {
    expect(classifyWithHysteresis('lst', 0.0050, t, 'DRIFT', 0)).toBe('PEGGED');
  });

  // Port of: hysteresis_lst_premium_stays_pegged_even_when_current_drift
  it('LST premium (−80 bps) → always PEGGED, even if current=DRIFT (directional carve-out wins)', () => {
    expect(classifyWithHysteresis('lst', -0.0080, t, 'DRIFT', 25)).toBe('PEGGED');
  });
});

// ─── classifyCrWithHysteresis ─────────────────────────────────────────────────

describe('classifyCrWithHysteresis()', () => {
  const t = crThresholds(); // drift=150, exit_drift=153 (2% deadband)

  // Port of: cr_hysteresis_escalates_immediately
  it('CR=1.49 from PEGGED → DRIFT immediately (no deadband on escalation)', () => {
    expect(classifyCrWithHysteresis(1.49, t, 'PEGGED', 2)).toBe('DRIFT');
  });

  it('CR=1.29 from DRIFT → DEPEG (deeper drop, escalation is never slowed)', () => {
    expect(classifyCrWithHysteresis(1.29, t, 'DRIFT', 2)).toBe('DEPEG');
  });

  // Port of: cr_hysteresis_holds_inside_the_deadband
  // drift entry=150, exit=153; CR=1.51 (151%): above entry but below exit → stay DRIFT
  it('CR=1.51 from DRIFT (above entry=150 but below exit=153) → hold DRIFT', () => {
    expect(classifyCrWithHysteresis(1.51, t, 'DRIFT', 2)).toBe('DRIFT');
  });

  // Port of: cr_hysteresis_relaxes_once_cr_clears_the_band
  // CR=1.53 (153%) ≥ exit_drift=153 → relax to PEGGED
  it('CR=1.53 (≥ exit=153) → relax to PEGGED', () => {
    expect(classifyCrWithHysteresis(1.53, t, 'DRIFT', 2)).toBe('PEGGED');
  });

  // Port of: cr_hysteresis_zero_deadband_is_plain_state_for_cr
  it('deadband=0: CR=1.51 from DRIFT → PEGGED (151% ≥ drift=150)', () => {
    expect(classifyCrWithHysteresis(1.51, t, 'DRIFT', 0)).toBe('PEGGED');
  });
});

// ─── Top-level classify() ─────────────────────────────────────────────────────

describe('classify()', () => {
  it('USDC pegged: intrinsic=$1 market=$0.9997 → PEGGED (~3 bps)', () => {
    const r = classify({ class: 'stable_fiat', intrinsic: 1.0, market: 0.9997 });
    expect(r.state).toBe('PEGGED');
    // JS float arithmetic: 1 - 0.9997 = 0.000299999... → Math.floor(*10000) = 2
    // (Rust rust_decimal has exact decimal representation; JS floats don't)
    expect(r.discountBps).toBeLessThanOrEqual(3);
    expect(r.discountBps).toBeGreaterThanOrEqual(2);
    expect(r.direction).toBe('discount');
  });

  it('stable_fiat drifting: 20 bps discount → DRIFT', () => {
    // drift=15 for stable_fiat; 20 bps > 15 → DRIFT
    const r = classify({ class: 'stable_fiat', intrinsic: 1.0, market: 0.9980 });
    expect(r.state).toBe('DRIFT');
  });

  it('stable_fiat severe depeg: 55 bps discount → DEPEG', () => {
    const r = classify({ class: 'stable_fiat', intrinsic: 1.0, market: 0.9945 });
    expect(r.state).toBe('DEPEG');
  });

  it('zero intrinsic → UNKNOWN with null discountBps', () => {
    const r = classify({ class: 'stable_fiat', intrinsic: 0, market: 1.0 });
    expect(r.state).toBe('UNKNOWN');
    expect(r.discountBps).toBeNull();
    expect(r.direction).toBe('unknown');
  });

  it('implausible sample (discount=1.0, market=0) → UNKNOWN', () => {
    const r = classify({ class: 'stable_fiat', intrinsic: 1.0, market: 0 });
    expect(r.state).toBe('UNKNOWN');
    // discountBps is 10000 (100%), not null — the discount was computed, then rejected
    expect(r.discountBps).toBe(10000);
  });

  it('LST premium (market > intrinsic) → PEGGED (direction-sensitive carve-out)', () => {
    // jitoSOL: intrinsic 94.00 (Sanctum), market 94.15 (+162 bps premium)
    const r = classify({
      class: 'lst',
      intrinsic: 94.00,
      market: 94.15,
      intrinsicSol: 1.0,
      marketSol: 1.00160,
    });
    expect(r.state).toBe('PEGGED');
    expect(r.direction).toBe('premium');
  });

  it('NAV premium sanity: LST +30% premium → UNKNOWN (broken intrinsic anchor)', () => {
    // sHYUSD incident: market=$1.30, intrinsic=$1.00 (thin NAV print)
    const r = classify({ class: 'lst', intrinsic: 1.0, market: 1.30 });
    // discount = 1 - 1.30/1.00 = -0.30, |d|=0.30, 3000 bps > 1000 → UNKNOWN
    expect(r.state).toBe('UNKNOWN');
    expect(r.direction).toBe('premium');
  });

  it('stable_yield discount → classifies normally (real redemption stress)', () => {
    // USDY at -40 bps to NAV (market < redemption rate) → DRIFT
    const r = classify({ class: 'stable_yield', intrinsic: 1.01, market: 1.0059 });
    expect(['DRIFT', 'DEPEG'].includes(r.state)).toBe(true);
    expect(r.direction).toBe('discount');
  });

  it('stable_yield small premium (demand, not stress) → PEGGED', () => {
    // sUSD: market slightly above NAV
    const r = classify({ class: 'stable_yield', intrinsic: 1.05, market: 1.052 });
    expect(r.state).toBe('PEGGED');
    expect(r.direction).toBe('premium');
  });

  it('synth_lev: symmetric, premium classifies as normal (not direction-sensitive)', () => {
    // xSOL: if market >> intrinsic, that's a real signal
    const r = classify({ class: 'synth_lev', intrinsic: 100, market: 200 });
    // 10000 bps (100% premium) is implausible (|d|=1.0), should → UNKNOWN
    expect(r.state).toBe('UNKNOWN');
  });

  it('synth_lev: 5% discount (500 bps) → DEPEG (threshold=300)', () => {
    const r = classify({ class: 'synth_lev', intrinsic: 100, market: 95 });
    expect(r.state).toBe('DEPEG'); // 500 bps > critical=1000? No. depeg=300 → DEPEG
    // Note: synth_lev default: drift=100, depeg=300, critical=1000
    // 500 bps ≥ depeg=300 → DEPEG
    expect(r.discountBps).toBe(500);
  });

  it('rank() ordering: PEGGED<DRIFT<DEPEG<CRITICAL<BLACK_SWAN, UNKNOWN=0', () => {
    expect(rank('UNKNOWN')).toBe(0);
    expect(rank('PEGGED')).toBe(0);
    expect(rank('DRIFT')).toBe(1);
    expect(rank('DEPEG')).toBe(2);
    expect(rank('CRITICAL')).toBe(3);
    expect(rank('BLACK_SWAN')).toBe(4);
  });
});

// ─── Property-style checks (deterministic, not random) ────────────────────────

describe('monotonicity properties (deterministic sweep)', () => {
  const t = bpsThresholds();

  it('BPS: larger |discount| → same or stricter state', () => {
    const discounts = [0, 10, 20, 50, 100, 200, 300, 600];
    let prev = rank(stateForBpsDiscount(0, t));
    for (const bps of discounts) {
      const cur = rank(stateForBpsDiscount(bps / 10_000, t));
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });

  it('CR: lower CR → same or stricter state', () => {
    const crs = [2.0, 1.60, 1.50, 1.40, 1.30, 1.10, 1.00, 0.90];
    let prev = rank(stateForCr(2.0, crThresholds()));
    for (const cr of crs) {
      const cur = rank(stateForCr(cr, crThresholds()));
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });

  it('hysteresis never slows escalation (sampled sweep)', () => {
    const t2 = jupThresholds();
    const discounts = [0, 0.003, 0.006, 0.010, 0.020, 0.030, 0.040];
    for (const d of discounts) {
      const plain = stateForBpsDiscountAware('stable_fiat', d, t2);
      // For any current state, if plain ≥ current → hysteresis must == plain
      for (const current of ['PEGGED', 'DRIFT', 'DEPEG'] as const) {
        if (rank(plain) >= rank(current)) {
          expect(classifyWithHysteresis('stable_fiat', d, t2, current, 25)).toBe(plain);
        }
      }
    }
  });
});
