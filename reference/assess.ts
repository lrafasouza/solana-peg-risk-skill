/**
 * assess.ts — Live mainnet demo: pull intrinsic + market for a mint,
 * run classify(), print verdict + risk parameters.
 *
 * READ-ONLY. No signing. No private keys. No hardcoded secrets.
 * Uses 2026 APIs only: @solana/kit, @pythnetwork/hermes-client, Jupiter lite-api.
 *
 * Usage:
 *   npm run demo <mint>
 *   HELIUS_API_KEY=<key> npm run demo <mint>
 *
 * Examples:
 *   npm run demo EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v   # USDC
 *   npm run demo J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn  # jitoSOL
 *   npm run demo A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6  # USDY
 *
 * Tier-1 classes ship a runnable adapter here.
 * Tier-2 classes (stable_cdp hyUSD, synth_lev xSOL) print a recipe note.
 * See skill/computing-spread.md for the on-chain intrinsic recipes.
 *
 * License: MIT
 */

import { createSolanaRpc, mainnet } from '@solana/kit';
import { HermesClient } from '@pythnetwork/hermes-client';
import {
  classify,
  DEFAULT_THRESHOLDS,
  type AssetClass,
  type ClassifyResult,
} from './classify.js';

// ─── Well-known mint registry (subset — add more as needed) ──────────────────

interface MintInfo {
  symbol: string;
  class: AssetClass;
  /**
   * Pyth Hermes feed ID (0x...) for intrinsic, if applicable.
   * - stable_fiat / stable_fx: USD or FX cross feed.
   * - stable_yield: redemption-rate feed (e.g. USDY/USD).
   * - lst: not used here; Sanctum is the intrinsic source.
   * null = no Pyth intrinsic; falls back to fixed-1 (fiat) or Sanctum (LST).
   */
  pythFeedId: string | null;
  /**
   * Pyth feed ID used as the MARKET quote for direction-sensitive classes.
   * null = use Jupiter usdPrice.
   */
  pythMarketFeedId: string | null;
  /**
   * Sanctum symbol for LSTs (used in sol-value API).
   * null = not an LST.
   */
  sanctumSymbol: string | null;
  /**
   * For Tier-2 classes: skip live adapter and print recipe note.
   */
  tier2: boolean;
}

const MINT_REGISTRY: Record<string, MintInfo> = {
  // ── stable_fiat ────────────────────────────────────────────────────────────
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: {
    symbol: 'USDC',
    class: 'stable_fiat',
    // Pyth USDC/USD feed
    pythFeedId: '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
    pythMarketFeedId: null,
    sanctumSymbol: null,
    tier2: false,
  },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: {
    symbol: 'USDT',
    class: 'stable_fiat',
    // Pyth USDT/USD feed
    pythFeedId: '0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
    pythMarketFeedId: null,
    sanctumSymbol: null,
    tier2: false,
  },
  // ── stable_yield ───────────────────────────────────────────────────────────
  A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6: {
    symbol: 'USDY',
    class: 'stable_yield',
    // USDY/USD.RR redemption-rate feed from Ondo Finance
    pythFeedId: '0xe393449f6aff8a4b6d3e1165a7c9ebec103685f3b41e60db4277b5b6d10e7326',
    pythMarketFeedId: null,
    sanctumSymbol: null,
    tier2: false,
  },
  // ── lst ────────────────────────────────────────────────────────────────────
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: {
    symbol: 'jitoSOL',
    class: 'lst',
    pythFeedId: null, // intrinsic from Sanctum
    pythMarketFeedId: null,
    sanctumSymbol: 'JITOSOL',
    tier2: false,
  },
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: {
    symbol: 'mSOL',
    class: 'lst',
    pythFeedId: null,
    pythMarketFeedId: null,
    sanctumSymbol: 'MSOL',
    tier2: false,
  },
  bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1: {
    symbol: 'bSOL',
    class: 'lst',
    pythFeedId: null,
    pythMarketFeedId: null,
    sanctumSymbol: 'BSOL',
    tier2: false,
  },
  // ── stable_cdp (Tier-2) ────────────────────────────────────────────────────
  HYUSAiER4bv6eXDL3oHMM9QKNrVKfSTjLuemDjWQHs1N: {
    symbol: 'hyUSD',
    class: 'stable_cdp',
    pythFeedId: null,
    pythMarketFeedId: null,
    sanctumSymbol: null,
    tier2: true,
  },
  // ── synth_lev (Tier-2) ─────────────────────────────────────────────────────
  xLfYxeGZ3eTfe4WuoH45wRFQx2iRNsWiS3hKJJCnmqn: {
    symbol: 'xSOL',
    class: 'synth_lev',
    pythFeedId: null,
    pythMarketFeedId: null,
    sanctumSymbol: null,
    tier2: true,
  },
};

// ─── Pyth SOL/USD feed ID ─────────────────────────────────────────────────────
const SOL_USD_FEED_ID =
  '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

// ─── Helper: fetch Pyth price via Hermes ─────────────────────────────────────

interface PythPrice {
  price: number;
  conf: number;
  publishTime: number;
  feedId: string;
}

async function fetchPythPrice(feedId: string): Promise<PythPrice | null> {
  try {
    const client = new HermesClient('https://hermes.pyth.network', {});
    const res = await client.getLatestPriceUpdates([feedId]);
    if (!res.parsed || res.parsed.length === 0) return null;
    const p = res.parsed[0];
    const price = Number(p.price.price) * Math.pow(10, p.price.expo);
    const conf = Number(p.price.conf) * Math.pow(10, p.price.expo);
    return { price, conf, publishTime: p.price.publish_time, feedId };
  } catch (err) {
    console.error(`  [Pyth] Failed to fetch ${feedId.slice(0, 10)}…: ${err}`);
    return null;
  }
}

// ─── Helper: fetch Jupiter price (lite-api, keyless) ─────────────────────────

interface JupiterPrice {
  usdPrice: number;
  blockId: number;
  decimals: number;
}

async function fetchJupiterPrice(mint: string): Promise<JupiterPrice | null> {
  try {
    const url = `https://lite-api.jup.ag/price/v3?ids=${mint}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      console.error(`  [Jupiter] HTTP ${res.status} for ${mint}`);
      return null;
    }
    const data = await res.json() as Record<string, { usdPrice?: number; blockId?: number; decimals?: number }>;
    const entry = data[mint];
    if (!entry?.usdPrice) return null;
    return {
      usdPrice: entry.usdPrice,
      blockId: entry.blockId ?? 0,
      decimals: entry.decimals ?? 6,
    };
  } catch (err) {
    console.error(`  [Jupiter] Failed for ${mint}: ${err}`);
    return null;
  }
}

// ─── Helper: fetch Helius DAS price_info (optional, cross-check) ─────────────

interface HeliusPrice {
  pricePerToken: number;
  currency: string;
}

async function fetchHeliusPrice(
  mint: string,
  apiKey: string,
): Promise<HeliusPrice | null> {
  try {
    const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
    const body = {
      jsonrpc: '2.0',
      id: 'peg-risk-assess',
      method: 'getAsset',
      params: { id: mint, displayOptions: { showFungible: true } },
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      result?: { token_info?: { price_info?: { price_per_token?: number; currency?: string } } };
    };
    const priceInfo = data.result?.token_info?.price_info;
    if (!priceInfo?.price_per_token) return null;
    return {
      pricePerToken: priceInfo.price_per_token,
      currency: priceInfo.currency ?? 'USDC',
    };
  } catch {
    return null;
  }
}

// ─── Helper: fetch Sanctum SOL value for LSTs ────────────────────────────────

interface SanctumSolValue {
  solPerLst: number;
}

async function fetchSanctumSolValue(
  symbol: string,
): Promise<SanctumSolValue | null> {
  try {
    // Public Sanctum extra-api endpoint for SOL value (current as of 2026).
    // Endpoint: GET /v1/sol-value/current?lst=<SYMBOL>
    // Note: verify the current public host at https://docs.sanctum.so if this
    // endpoint changes. The symbol is the LST's ticker (e.g. "JITOSOL", "MSOL").
    const url = `https://sanctum-extra-api.ngrok.dev/v1/sol-value/current?lst=${symbol}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      console.error(`  [Sanctum] HTTP ${res.status} for ${symbol}`);
      return null;
    }
    const data = await res.json() as { solValue?: string | number } | Array<{ solValue?: string | number }>;

    // Sanctum returns a single object or array — handle both shapes.
    const raw = Array.isArray(data) ? data[0]?.solValue : (data as { solValue?: string | number }).solValue;
    if (raw === undefined || raw === null) return null;
    const solPerLst = typeof raw === 'string' ? parseFloat(raw) : Number(raw);
    if (!Number.isFinite(solPerLst) || solPerLst <= 0) return null;
    return { solPerLst };
  } catch (err) {
    console.error(`  [Sanctum] Failed for ${symbol}: ${err}`);
    return null;
  }
}

// ─── Helper: fetch Jupiter depth probe ───────────────────────────────────────

interface DepthProbe {
  priceImpactPct: number;
  outAmount: number;
  amountIn: number;
}

/**
 * Probe sell-side depth: how much slippage to exit $10k of the asset?
 * Uses Jupiter swap/v1/quote with a 100-bps slippage tolerance.
 * Probes the THIN asset side (inputMint = pegged asset, outputMint = USDC).
 */
async function probeDepth(
  mint: string,
  decimals: number,
  usdPrice: number,
): Promise<DepthProbe | null> {
  try {
    // Probe $10,000 worth of the asset.
    const targetUsd = 10_000;
    const amountIn = Math.floor((targetUsd / usdPrice) * Math.pow(10, decimals));
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const url =
      `https://lite-api.jup.ag/swap/v1/quote` +
      `?inputMint=${mint}&outputMint=${USDC}&amount=${amountIn}&slippageBps=100`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = await res.json() as {
      outAmount?: string;
      priceImpactPct?: string | number;
    };
    if (!data.outAmount) return null;
    return {
      priceImpactPct: Number(data.priceImpactPct ?? 0),
      outAmount: Number(data.outAmount),
      amountIn,
    };
  } catch {
    return null;
  }
}

// ─── Print verdict ────────────────────────────────────────────────────────────

const STATE_EMOJI: Record<string, string> = {
  PEGGED: '✅',
  DRIFT: '⚠️ ',
  DEPEG: '🟠',
  CRITICAL: '🔴',
  BLACK_SWAN: '💀',
  UNKNOWN: '❓',
};

function printVerdict(
  symbol: string,
  mint: string,
  cls: AssetClass,
  result: ClassifyResult,
  inputs: {
    intrinsic?: number | null;
    market?: number | null;
    solPerLst?: number | null;
    solMarket?: number | null;
    helius?: number | null;
    depth?: DepthProbe | null;
    solUsd?: number | null;
  },
  thresholds: Record<string, number>,
): void {
  const emoji = STATE_EMOJI[result.state] ?? '?';
  const { discountBps, direction, reason } = result;
  const discStr =
    discountBps !== null
      ? `${discountBps} bps ${direction}`
      : 'n/a';

  console.log('');
  console.log('═'.repeat(60));
  console.log(`  PEG RISK ASSESSMENT: ${symbol}`);
  console.log('═'.repeat(60));
  console.log(`  Mint:     ${mint}`);
  console.log(`  Class:    ${cls}`);
  console.log(`  State:    ${emoji} ${result.state}`);
  console.log(`  Spread:   ${discStr}`);
  console.log(`  Reason:   ${reason}`);
  console.log('');
  console.log('  ── Inputs ──────────────────────────────────────────────');
  if (inputs.intrinsic !== undefined && inputs.intrinsic !== null) {
    console.log(`  Intrinsic:  $${inputs.intrinsic.toFixed(6)}`);
  }
  if (inputs.market !== undefined && inputs.market !== null) {
    console.log(`  Market:     $${inputs.market.toFixed(6)}  (Jupiter lite-api)`);
  }
  if (inputs.helius !== undefined && inputs.helius !== null) {
    const delta = inputs.market != null
      ? ((inputs.helius - inputs.market) / inputs.market * 10_000).toFixed(1) + ' bps'
      : 'n/a';
    console.log(`  Helius DAS: $${inputs.helius.toFixed(6)}  (delta vs Jupiter: ${delta})`);
  }
  if (inputs.solPerLst !== undefined && inputs.solPerLst !== null) {
    console.log(`  sol/LST:    ${inputs.solPerLst.toFixed(6)} SOL  (Sanctum)`);
  }
  if (inputs.solMarket !== undefined && inputs.solMarket !== null) {
    console.log(`  LST mkt:    ${inputs.solMarket.toFixed(6)} SOL  (Jupiter SOL-denom)`);
  }
  if (inputs.solUsd !== undefined && inputs.solUsd !== null) {
    console.log(`  SOL/USD:    $${inputs.solUsd.toFixed(4)}  (Pyth)`);
  }
  if (inputs.depth) {
    const d = inputs.depth;
    console.log(
      `  Depth:      $10k sell → ${d.priceImpactPct.toFixed(3)}% impact (Jupiter quote)`,
    );
  }
  console.log('');
  console.log('  ── Risk Parameters (pasteable config) ──────────────────');
  console.log(`  asset_class:     ${cls}`);
  console.log(`  refuse_above_bps: ${thresholds['depeg'] ?? '?'}  # refuse if spread > this`);
  console.log(`  drift_bps:        ${thresholds['drift'] ?? '?'}`);
  console.log(`  depeg_bps:        ${thresholds['depeg'] ?? '?'}`);
  console.log(`  critical_bps:     ${thresholds['critical'] ?? '?'}`);
  console.log(`  oracle_staleness: 30s  # reject intrinsic if publish_time > 30s ago`);
  console.log(`  direction_sensitive: ${cls === 'lst' || cls === 'stable_yield'}`);
  console.log('');
  console.log(
    '  NOTE: thresholds above are methodology DEFAULTS. Recalibrate per asset',
  );
  console.log(
    '  using historical spread data before accepting as collateral / listing.',
  );
  console.log('═'.repeat(60));
  console.log('');
}

// ─── Main assess logic ────────────────────────────────────────────────────────

async function assess(mint: string): Promise<void> {
  const info = MINT_REGISTRY[mint];
  if (!info) {
    console.log(`\nMint ${mint} not in registry.`);
    console.log(
      'Add it to MINT_REGISTRY in assess.ts with its class and Pyth feed IDs.',
    );
    console.log('\nRegistered mints:');
    for (const [m, v] of Object.entries(MINT_REGISTRY)) {
      console.log(`  ${v.symbol.padEnd(12)} ${m}`);
    }
    process.exit(1);
  }

  const { symbol, class: cls } = info;
  console.log(`\nAssessing ${symbol} (${cls}) …`);
  console.log(`  Mint: ${mint}`);

  // ── Tier-2: print recipe note and exit ──────────────────────────────────
  if (info.tier2) {
    console.log('');
    console.log(`⚠️  ${symbol} (${cls}) — intrinsic source not bundled.`);
    console.log('');
    console.log('  See skill/computing-spread.md for the on-chain intrinsic recipe.');
    console.log('');
    if (cls === 'stable_cdp') {
      console.log(
        '  hyUSD intrinsic = 1.00 USD (fixed, but also runs CR path).',
      );
      console.log(
        '  CR = hyUSD collateral (SOL) / hyUSD supply (USD / SOL_USD).',
      );
      console.log(
        '  On-chain: read Hylo Exchange program state (cr_drift=150%, cr_depeg=130%).',
      );
      console.log(
        '  Account layout is issuer-specific — adapter code left to integrator.',
      );
    } else if (cls === 'synth_lev') {
      console.log(
        '  xSOL intrinsic (SOL) = (collateral_sol − hyusd_supply_in_sol) / xsol_supply',
      );
      console.log(
        '  where hyusd_supply_in_sol = hyusd_supply × $1 / SOL_USD (Pyth).',
      );
      console.log(
        '  On-chain: read Hylo Exchange state. Layout is issuer-specific.',
      );
    }
    console.log('');
    process.exit(0);
  }

  const heliusApiKey = process.env.HELIUS_API_KEY ?? null;
  const thresholds = DEFAULT_THRESHOLDS[cls];

  // ── Fetch SOL/USD from Pyth (needed for LSTs) ───────────────────────────
  let solUsd: number | null = null;
  if (cls === 'lst') {
    console.log('  Fetching SOL/USD from Pyth Hermes …');
    const solPyth = await fetchPythPrice(SOL_USD_FEED_ID);
    if (solPyth) {
      solUsd = solPyth.price;
      console.log(
        `  SOL/USD: $${solUsd.toFixed(4)} (conf ±${solPyth.conf.toFixed(4)})`,
      );
    } else {
      console.log('  WARNING: could not fetch SOL/USD from Pyth.');
    }
  }

  // ── Fetch intrinsic ──────────────────────────────────────────────────────
  let intrinsic: number | null = null;
  let solPerLst: number | null = null;

  if (cls === 'lst' && info.sanctumSymbol) {
    // LST intrinsic: Sanctum sol-value API.
    console.log(`  Fetching Sanctum SOL value for ${info.sanctumSymbol} …`);
    const s = await fetchSanctumSolValue(info.sanctumSymbol);
    if (s) {
      solPerLst = s.solPerLst;
      console.log(`  sol/LST (intrinsic): ${solPerLst.toFixed(6)} SOL`);
      if (solUsd) {
        intrinsic = solPerLst * solUsd;
        console.log(
          `  Intrinsic USD: $${intrinsic.toFixed(4)} (${solPerLst.toFixed(6)} × $${solUsd.toFixed(4)})`,
        );
      }
    } else {
      console.log('  WARNING: Sanctum SOL value unavailable.');
    }
  } else if (info.pythFeedId) {
    // Pyth Hermes intrinsic (stable_fiat, stable_yield with RR feed, etc.)
    console.log(`  Fetching intrinsic from Pyth Hermes …`);
    const pp = await fetchPythPrice(info.pythFeedId);
    if (pp) {
      intrinsic = pp.price;
      const staleness = Math.floor(Date.now() / 1000) - pp.publishTime;
      console.log(
        `  Intrinsic (Pyth): $${intrinsic.toFixed(6)} (staleness: ${staleness}s, conf ±${pp.conf.toFixed(6)})`,
      );
      if (staleness > 30) {
        console.log(
          `  ⚠️  Stale intrinsic (${staleness}s > 30s) — consider as UNKNOWN.`,
        );
      }
    } else {
      console.log('  WARNING: Pyth intrinsic unavailable.');
    }
  } else {
    // stable_fiat / stable_cdp with no Pyth feed: fixed $1.
    intrinsic = 1.0;
    console.log('  Intrinsic: $1.0000 (fixed peg target)');
  }

  // ── Fetch market price from Jupiter ─────────────────────────────────────
  console.log('  Fetching market price from Jupiter lite-api …');
  const jup = await fetchJupiterPrice(mint);
  let market: number | null = null;
  let jupDecimals = 6;
  if (jup) {
    market = jup.usdPrice;
    jupDecimals = jup.decimals;
    console.log(`  Market (Jupiter): $${market.toFixed(6)}`);
  } else {
    console.log('  WARNING: Jupiter market price unavailable.');
  }

  // ── LST: compute SOL-denominated market price ────────────────────────────
  let marketSol: number | null = null;
  if (cls === 'lst' && market !== null && solUsd !== null && solUsd > 0) {
    marketSol = market / solUsd;
    console.log(
      `  Market SOL-denom: ${marketSol.toFixed(6)} SOL (${market.toFixed(4)} / ${solUsd.toFixed(4)})`,
    );
  }

  // ── Helius DAS cross-check (optional) ───────────────────────────────────
  let heliusPrice: number | null = null;
  if (heliusApiKey) {
    console.log('  Fetching Helius DAS price_info (cross-check) …');
    const h = await fetchHeliusPrice(mint, heliusApiKey);
    if (h) {
      heliusPrice = h.pricePerToken;
      console.log(
        `  Helius DAS: $${heliusPrice.toFixed(6)} (${h.currency})`,
      );
    } else {
      console.log('  Helius DAS: price_info not available for this mint.');
    }
  } else {
    console.log(
      '  Helius DAS: skipped (set HELIUS_API_KEY env for cross-check).',
    );
  }

  // ── Jupiter depth probe ──────────────────────────────────────────────────
  let depth: DepthProbe | null = null;
  if (market !== null) {
    console.log('  Probing sell-side depth (Jupiter $10k quote) …');
    depth = await probeDepth(mint, jupDecimals, market);
    if (depth) {
      console.log(
        `  Depth: $10k sell → ${depth.priceImpactPct.toFixed(3)}% price impact`,
      );
    } else {
      console.log('  Depth probe unavailable.');
    }
  }

  // ── Run classify() ───────────────────────────────────────────────────────
  if (intrinsic === null || market === null) {
    console.log('\n❌ Cannot classify: missing intrinsic or market price.');
    process.exit(1);
  }

  const result = classify({
    class: cls,
    intrinsic,
    market,
    intrinsicSol: solPerLst ?? undefined,
    marketSol: marketSol ?? undefined,
    thresholds,
    current: 'PEGGED', // demo: no prior state
  });

  // ── Print verdict ────────────────────────────────────────────────────────
  printVerdict(symbol, mint, cls, result, {
    intrinsic,
    market,
    solPerLst,
    solMarket: marketSol,
    helius: heliusPrice,
    depth,
    solUsd,
  }, thresholds);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const mint = process.argv[2];
if (!mint) {
  console.log('Usage: npm run demo <mint-address>');
  console.log('');
  console.log('Examples:');
  console.log(
    '  npm run demo EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v  # USDC',
  );
  console.log(
    '  npm run demo J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn  # jitoSOL',
  );
  console.log(
    '  npm run demo A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6  # USDY',
  );
  console.log('');
  console.log('Optional: set HELIUS_API_KEY env for DAS cross-check.');
  process.exit(0);
}

assess(mint).catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
