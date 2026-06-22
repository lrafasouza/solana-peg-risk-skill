/**
 * assets.ts — curated catalog of real Solana pegged assets for the peg-risk gate.
 *
 * Each entry pairs a mint with its peg-mechanism metadata: how to read the
 * intrinsic value, the consumer-facing anchor, and recalibratable thresholds.
 * Market price for ANY mint comes from Jupiter (works by mint); the intrinsic
 * source varies by class.
 *
 * `mintVerified: true` means the mint returned a live Jupiter price/v3 quote
 * (so it is a real, tradeable mint). Thresholds are the per-class DEFAULTS —
 * recalibrate per asset (see skill/peg-states.md).
 *
 * License: MIT
 */
import type { AssetClass, Thresholds } from './classify';
import { DEFAULT_THRESHOLDS } from './classify';

export type IntrinsicSource =
  | 'fixed-usd' // $1 anchor (fiat / cdp / rwa)
  | 'pyth' // Pyth Hermes price / NAV / redemption-rate feed
  | 'sanctum-lst' // Sanctum SOL-value API (LST exchange rate)
  | 'recipe-cdp' // collateral ratio via on-chain read — see skill/computing-spread.md
  | 'recipe-synth'; // leveraged NAV via on-chain read — see skill/computing-spread.md

export interface CatalogAsset {
  symbol: string;
  mint: string;
  mintVerified: boolean;
  class: AssetClass;
  pegAnchor: 'USD' | 'FX' | 'NAV' | 'SOL';
  intrinsicSource: IntrinsicSource;
  /** Only set when the REAL Pyth feed ID is known (no guessed IDs). */
  pythFeedId?: string;
  thresholds: Thresholds;
  notes: string;
}

/**
 * Verified real Pyth price-feed IDs. Others are intentionally omitted rather
 * than guessed — look them up at pyth.network/price-feeds.
 */
const PYTH = {
  USDC_USD: '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
  USDT_USD: '0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
  SOL_USD: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
} as const;

export const CATALOG: CatalogAsset[] = [
  // ── Fiat-backed ($1 anchor, symmetric) ──
  {
    symbol: 'USDC',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    mintVerified: true,
    class: 'stable_fiat',
    pegAnchor: 'USD',
    intrinsicSource: 'fixed-usd',
    pythFeedId: PYTH.USDC_USD,
    thresholds: DEFAULT_THRESHOLDS.stable_fiat,
    notes: 'Circle USDC. Live screen 0.9998 → PEGGED.',
  },
  {
    symbol: 'USDT',
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    mintVerified: true,
    class: 'stable_fiat',
    pegAnchor: 'USD',
    intrinsicSource: 'fixed-usd',
    pythFeedId: PYTH.USDT_USD,
    thresholds: DEFAULT_THRESHOLDS.stable_fiat,
    notes: 'Tether USDT. Live screen 0.9989 → PEGGED.',
  },
  {
    symbol: 'PYUSD',
    mint: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
    mintVerified: true,
    class: 'stable_fiat',
    pegAnchor: 'USD',
    intrinsicSource: 'fixed-usd',
    thresholds: DEFAULT_THRESHOLDS.stable_fiat,
    notes: 'PayPal USD. Mint verified live via Jupiter price/v3 (0.9999).',
  },
  {
    symbol: 'USDS',
    mint: 'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA',
    mintVerified: true,
    class: 'stable_fiat',
    pegAnchor: 'USD',
    intrinsicSource: 'fixed-usd',
    thresholds: DEFAULT_THRESHOLDS.stable_fiat,
    notes: 'Sky USDS. Mint verified live via Jupiter price/v3 (0.9997).',
  },

  // ── Liquid staking tokens (NAV/SOL anchor, discount-only) ──
  {
    symbol: 'jitoSOL',
    mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
    mintVerified: true,
    class: 'lst',
    pegAnchor: 'SOL',
    intrinsicSource: 'sanctum-lst',
    thresholds: DEFAULT_THRESHOLDS.lst,
    notes: 'Jito LST. Intrinsic = SOL exchange rate via Sanctum sol-value API.',
  },
  {
    symbol: 'mSOL',
    mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
    mintVerified: true,
    class: 'lst',
    pegAnchor: 'SOL',
    intrinsicSource: 'sanctum-lst',
    thresholds: DEFAULT_THRESHOLDS.lst,
    notes: 'Marinade mSOL. Mint verified live via Jupiter price/v3.',
  },
  {
    symbol: 'bSOL',
    mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
    mintVerified: true,
    class: 'lst',
    pegAnchor: 'SOL',
    intrinsicSource: 'sanctum-lst',
    thresholds: DEFAULT_THRESHOLDS.lst,
    notes: 'BlazeStake bSOL. Mint verified live via Jupiter price/v3.',
  },
  {
    symbol: 'JupSOL',
    mint: 'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v',
    mintVerified: true,
    class: 'lst',
    pegAnchor: 'SOL',
    intrinsicSource: 'sanctum-lst',
    thresholds: DEFAULT_THRESHOLDS.lst,
    notes: 'Jupiter JupSOL. Mint verified live via Jupiter price/v3.',
  },

  // ── Yield-bearing stables (NAV anchor, discount-only) ──
  {
    symbol: 'USDY',
    mint: 'A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6',
    mintVerified: true,
    class: 'stable_yield',
    pegAnchor: 'NAV',
    intrinsicSource: 'pyth',
    thresholds: DEFAULT_THRESHOLDS.stable_yield,
    notes: 'Ondo USDY. Live screen market 1.1379 (NAV grows above $1). Intrinsic = NAV via Pyth redemption-rate feed (look up the feed ID).',
  },

  // ── CDP stable (USD anchor + CR path) ──
  {
    symbol: 'hyUSD',
    mint: 'HUSDm9cvmSEMBbMHpFbJwsLGKBFnM6JNXR2NHHQ7kNFi',
    mintVerified: true,
    class: 'stable_cdp',
    pegAnchor: 'USD',
    intrinsicSource: 'recipe-cdp',
    thresholds: DEFAULT_THRESHOLDS.stable_cdp,
    notes: 'Hylo hyUSD. Not listed on Jupiter (thin secondary liquidity) → use DexScreener for market; collateral ratio via Hylo on-chain read — see skill/computing-spread.md.',
  },

  // ── Leveraged synthetic (NAV anchor) ──
  {
    symbol: 'xSOL',
    mint: '',
    mintVerified: false,
    class: 'synth_lev',
    pegAnchor: 'NAV',
    intrinsicSource: 'recipe-synth',
    thresholds: DEFAULT_THRESHOLDS.synth_lev,
    notes: 'Hylo xSOL leveraged SOL. Intrinsic = (collateral_sol − hyusd_supply_in_sol) / xsol_supply via on-chain read — see skill/computing-spread.md. // TODO add mint.',
  },
];

export const CATALOG_BY_SYMBOL: Record<string, CatalogAsset> = Object.fromEntries(
  CATALOG.map((a) => [a.symbol, a]),
);

export const CATALOG_BY_MINT: Record<string, CatalogAsset> = Object.fromEntries(
  CATALOG.filter((a) => a.mint).map((a) => [a.mint, a]),
);
