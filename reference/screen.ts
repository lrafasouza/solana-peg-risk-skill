/**
 * screen.ts — live catalog screener.
 *
 * Pulls real Jupiter market prices (keyless lite-api) for every catalog asset
 * and classifies the USD-anchored ones live against their $1 intrinsic.
 * NAV/SOL-anchored assets (LST / yield / synth) need their intrinsic source
 * (Sanctum / Pyth / on-chain CR) — run `npm run demo <mint>` for the full read.
 *
 * READ-ONLY. No keys, no signing. Network: GET lite-api.jup.ag only.
 * License: MIT
 */
import { CATALOG } from './assets';
import { classify } from './classify';

const JUP = 'https://lite-api.jup.ag/price/v3';

async function jupPrices(mints: string[]): Promise<Record<string, number>> {
  const ids = mints.filter(Boolean).join(',');
  const res = await fetch(`${JUP}?ids=${ids}`);
  if (!res.ok) throw new Error(`Jupiter price/v3 ${res.status}`);
  const data = (await res.json()) as Record<string, { usdPrice?: number }>;
  const out: Record<string, number> = {};
  for (const [m, v] of Object.entries(data)) {
    if (v && typeof v.usdPrice === 'number') out[m] = v.usdPrice;
  }
  return out;
}

async function main() {
  const prices = await jupPrices(CATALOG.map((a) => a.mint));

  console.log(
    `${'SYMBOL'.padEnd(9)}${'CLASS'.padEnd(14)}${'ANCHOR'.padEnd(7)}${'MARKET'.padEnd(11)}${'STATE'.padEnd(11)}DETAIL`,
  );
  console.log('─'.repeat(82));

  for (const a of CATALOG) {
    const market = prices[a.mint];
    const head = `${a.symbol.padEnd(9)}${a.class.padEnd(14)}${a.pegAnchor.padEnd(7)}`;

    if (market === undefined) {
      const why = a.mintVerified ? 'no Jupiter price' : 'mint unverified — TODO';
      console.log(`${head}${'—'.padEnd(11)}${'NO-MKT'.padEnd(11)}${why}`);
      continue;
    }

    if (a.pegAnchor === 'USD') {
      // Fiat/CDP/RWA: intrinsic is the $1 target → classify the spread live.
      const r = classify({ class: a.class, intrinsic: 1.0, market, thresholds: a.thresholds });
      const detail =
        a.class === 'stable_cdp'
          ? `${r.discountBps} bps ${r.direction} (spread only — CR path is the full read)`
          : `${r.discountBps} bps ${r.direction}`;
      console.log(`${head}${market.toFixed(4).padEnd(11)}${r.state.padEnd(11)}${detail}`);
    } else {
      // NAV/SOL anchored: intrinsic needs Sanctum/Pyth/on-chain — not $1.
      console.log(
        `${head}${market.toFixed(4).padEnd(11)}${'NEEDS-NAV'.padEnd(11)}intrinsic via ${a.intrinsicSource} — run: npm run demo ${a.mint || a.symbol}`,
      );
    }
  }

  console.log(
    '\nUSD-anchored assets are classified live vs their $1 target. NAV-anchored ' +
      'assets (LST/yield/synth) require their intrinsic source — see skill/computing-spread.md.',
  );
}

main().catch((e) => {
  console.error('screen failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
