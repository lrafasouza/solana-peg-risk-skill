/**
 * backtest.test.ts — asserts the classifier fires the correct state on
 * documented historical depegs and does not false-alarm on healthy assets.
 * Deterministic, offline (no network, no keys). The CI Quality gate.
 */
import { describe, it, expect } from 'vitest';
import { runBacktest, HISTORICAL_SCENARIOS } from '../reference/backtest';

describe('historical depeg backtest', () => {
  const rows = runBacktest();

  for (const r of rows) {
    it(`${r.asset} (${r.date}) → ${r.expected}`, () => {
      expect(r.actual).toBe(r.expected);
    });
  }

  it('every scenario classifies as expected', () => {
    const failures = rows.filter((r) => !r.pass);
    expect(failures.map((f) => `${f.asset}: want ${f.expected} got ${f.actual}`)).toEqual([]);
  });

  it('coverage includes all five severe states and PEGGED', () => {
    const states = new Set(HISTORICAL_SCENARIOS.map((s) => s.expected));
    for (const s of ['PEGGED', 'DRIFT', 'DEPEG', 'CRITICAL', 'BLACK_SWAN'] as const) {
      expect(states.has(s)).toBe(true);
    }
  });

  it('healthy controls never alarm (PEGGED)', () => {
    const controls = rows.filter((r) => r.date === 'control');
    expect(controls.length).toBeGreaterThanOrEqual(3);
    expect(controls.every((r) => r.actual === 'PEGGED')).toBe(true);
  });
});
