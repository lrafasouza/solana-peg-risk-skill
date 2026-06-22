/**
 * backtest.ts — runs the classifier against documented historical depeg events.
 *
 * Proves the methodology fires the correct SEVERE state on real depegs and does
 * NOT false-alarm on healthy assets. Fully DETERMINISTIC and offline (no network).
 *
 * Figures are documented historical lows (with sources) used as illustrative
 * scenarios — NOT live data. Some events (UST, stETH, DAI) are cross-chain or
 * algorithmic; they are included to exercise the fiat-discount, LST-discount and
 * CR paths the classifier implements. The point is the CLASSIFIER's response to
 * a known input, which is what a peg-risk gate must get right.
 *
 * License: MIT
 */
import { classify, type AssetClass, type PegState } from './classify';

export interface Scenario {
  name: string;
  date: string;
  asset: string;
  class: AssetClass;
  intrinsic: number;
  market: number;
  cr?: number;
  intrinsicSol?: number;
  marketSol?: number;
  expected: PegState;
  note: string;
}

export const HISTORICAL_SCENARIOS: Scenario[] = [
  // ── Real depegs: must fire severe states ──
  {
    name: 'USDC — SVB bank run',
    date: '2023-03-11',
    asset: 'USDC',
    class: 'stable_fiat',
    intrinsic: 1.0,
    market: 0.8774,
    expected: 'BLACK_SWAN',
    note: 'USDC fell to ~$0.877 after Circle disclosed $3.3B exposure to Silicon Valley Bank. ~1226 bps ≥ 2×critical (400).',
  },
  {
    name: 'DAI — USDC contagion',
    date: '2023-03-11',
    asset: 'DAI',
    class: 'stable_fiat',
    intrinsic: 1.0,
    market: 0.897,
    expected: 'BLACK_SWAN',
    note: 'DAI (majority USDC-collateralized at the time) fell to ~$0.897 in the same event. ~1030 bps.',
  },
  {
    name: 'UST — Terra collapse',
    date: '2022-05-12',
    asset: 'UST',
    class: 'stable_fiat',
    intrinsic: 1.0,
    market: 0.1,
    expected: 'BLACK_SWAN',
    note: 'Algorithmic UST death spiral to ~$0.10. Cross-chain/algorithmic, illustrative; |discount|<1 keeps it classifiable rather than rejected as impossible.',
  },
  {
    name: 'stETH — Celsius/3AC discount',
    date: '2022-06-13',
    asset: 'stETH',
    class: 'lst',
    intrinsic: 1.0,
    market: 0.935,
    expected: 'BLACK_SWAN',
    note: 'stETH traded ~6.5% below ETH as forced sellers outran arbitrage. Cross-chain, illustrates the LST DISCOUNT path (~650 bps ≥ lst black_swan 500). A premium would NOT have fired — only the discount side.',
  },

  // ── Band coverage: each severity is reachable (synthetic, exact-band) ──
  {
    name: 'Fiat stable — mild drift',
    date: 'illustrative',
    asset: 'USDx',
    class: 'stable_fiat',
    intrinsic: 1.0,
    market: 0.998,
    expected: 'DRIFT',
    note: '20 bps ≥ drift (15), < depeg (50).',
  },
  {
    name: 'Fiat stable — depeg band',
    date: 'illustrative',
    asset: 'USDx',
    class: 'stable_fiat',
    intrinsic: 1.0,
    market: 0.994,
    expected: 'DEPEG',
    note: '60 bps ≥ depeg (50), < critical (200).',
  },
  {
    name: 'Fiat stable — critical band',
    date: 'illustrative',
    asset: 'USDx',
    class: 'stable_fiat',
    intrinsic: 1.0,
    market: 0.975,
    expected: 'CRITICAL',
    note: '250 bps ≥ critical (200), < black_swan (400).',
  },

  // ── CDP collateral-ratio path (hyUSD-style; lower CR = worse) ──
  {
    name: 'CDP — CR 105% undercollateralizing',
    date: 'illustrative',
    asset: 'hyUSD',
    class: 'stable_cdp',
    intrinsic: 1.0,
    market: 1.0,
    cr: 1.05,
    expected: 'CRITICAL',
    note: 'CR 105% < critical (110), ≥ black_swan (100) → CRITICAL via the CR path even with the market at par.',
  },
  {
    name: 'CDP — CR 95% insolvent',
    date: 'illustrative',
    asset: 'hyUSD',
    class: 'stable_cdp',
    intrinsic: 1.0,
    market: 1.0,
    cr: 0.95,
    expected: 'BLACK_SWAN',
    note: 'CR 95% < black_swan (100) → BLACK_SWAN (CR path).',
  },

  // ── Healthy controls: must NOT false-alarm ──
  {
    name: 'USDC — healthy',
    date: 'control',
    asset: 'USDC',
    class: 'stable_fiat',
    intrinsic: 1.0,
    market: 0.9997,
    expected: 'PEGGED',
    note: '3 bps < drift (15) → PEGGED.',
  },
  {
    name: 'jitoSOL — legitimate premium',
    date: 'control',
    asset: 'jitoSOL',
    class: 'lst',
    intrinsic: 1.0,
    market: 1.0079,
    expected: 'PEGGED',
    note: '−79 bps premium on an LST is demand pressure — direction-sensitivity normalizes it to PEGGED (a naive symmetric check false-alarms DRIFT here).',
  },
  {
    name: 'USDY — NAV premium',
    date: 'control',
    asset: 'USDY',
    class: 'stable_yield',
    intrinsic: 1.0,
    market: 1.002,
    expected: 'PEGGED',
    note: '−20 bps premium on a yield stable is thin secondary bid → PEGGED.',
  },
];

export interface BacktestRow extends Scenario {
  actual: PegState;
  pass: boolean;
  discountBps: number | null;
}

export function runBacktest(scenarios: Scenario[] = HISTORICAL_SCENARIOS): BacktestRow[] {
  return scenarios.map((s) => {
    const r = classify({
      class: s.class,
      intrinsic: s.intrinsic,
      market: s.market,
      cr: s.cr,
      intrinsicSol: s.intrinsicSol,
      marketSol: s.marketSol,
    });
    return { ...s, actual: r.state, pass: r.state === s.expected, discountBps: r.discountBps };
  });
}

// CLI: `tsx backtest.ts` prints the table and exits non-zero on any mismatch.
if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = runBacktest();
  let pass = 0;
  for (const r of rows) {
    const mark = r.pass ? '✓' : '✗';
    console.log(
      `${mark} expected ${r.expected.padEnd(11)} got ${r.actual.padEnd(11)} ${r.asset.padEnd(8)} ${r.name}`,
    );
    if (r.pass) pass++;
  }
  console.log(`\n${pass}/${rows.length} historical scenarios classified as expected.`);
  process.exit(pass === rows.length ? 0 : 1);
}
