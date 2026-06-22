# Build Spec — `solana-peg-risk-skill`

**Authoritative blueprint. Builders follow this exactly. Opus authored it; Sonnet 4.6 builds from it; Opus reviews.**

Date: 2026-06-21 · License: MIT · Repo will be pushed (by a human) to a public GitHub repo.

---

## 0. Mission (one sentence)

A Claude Code **skill** that teaches a coding agent to **assess depeg risk of any Solana stablecoin or LST before integrating / accepting it as collateral / routing through it / listing it**, and to **emit pasteable risk parameters** (asset class, depeg thresholds, refuse-above-X-bps spread, oracle staleness bound, direction-sensitivity). Framed as a **collateral/listing SAFETY GATE**, not a monitoring dashboard.

It is derived from the **public MIT methodology** of Pegana (a live Solana peg-risk oracle): `github.com/lrafasouza/pegana-replay`. The skill **reuses** Helius/Pyth/Switchboard/Jupiter as input layers (it cites them, never re-implements them).

## 1. Why this wins the bounty (judging criteria — keep these true)

- **Usefulness**: a real, recurring pre-integration decision (DeFi lending/listing/routing builders). Output is **config the builder ships**, not an opinion.
- **Novelty**: verified clean gap — no peg/depeg/stablecoin-risk skill exists across 50+ ecosystem skills and 29 bounty PRs. Lead with the **failure-mode framing** (the 5 ways a naive depeg check lies), which is uncopyable.
- **Quality**: methodology is **battle-tested in mainnet production**; ship a **runnable, CI-green TS port** + tests. The reference skill (`solana-game-skill`) ships ZERO runnable code — our runnable port is the differentiator. NEVER name-drop "Pegana" in the skill body as a product; cite the MIT methodology repo as the upstream source.
- **Fit**: identical shape to `solana-game-skill`; MIT; submodule/registry-ready.

## 2. CRITICAL guardrails (do not violate)

1. **Depersonalize.** The skill is general-purpose. Reference the method as *"a public, MIT-licensed peg-risk methodology (`github.com/lrafasouza/pegana-replay`)"*. No "Pegana product" marketing, no `pegana.xyz` API, no private endpoints.
2. **Moat / provenance.** Port ONLY from PUBLIC sources: `pegana-replay` repo + the local mirror `crates/methodology/src/*.rs`, `crates/common-verify/src/lib.rs`, `tools/pegana-replay-public/METHODOLOGY.md`. **DO NOT** reference or copy: the closed engine, `rederive.rs`, private indexer adapters (`crates/indexer-rs/src/sources/*`), `assets.toml` live secrets, calibration data, API keys, ops infra. (The classifier logic itself is fully public — confirmed.)
3. **Thresholds are DEFAULTS, not gospel.** Always teach the agent to treat per-class thresholds as starting points to **recalibrate per asset**, and explain *why each boundary is where it is*. Never present constants as untouchable.
4. **Read-only & safety.** All on-chain interaction is READ-ONLY. Never sign, never send, never request a private key. Default to public RPC; users supply their own `HELIUS_API_KEY` (the kit's bundled Helius MCP key returns 401 — do not depend on it).
5. **Honesty of scope.** Be explicit which asset classes ship with a runnable adapter vs a documented on-chain-read recipe (see §6 Scope tiers).

## 3. Repo file manifest (build EXACTLY this)

```
solana-peg-risk-skill/
├── LICENSE                      # MIT, "Copyright (c) 2026 Pegana contributors" (attribution to upstream)
├── README.md                    # leads with the 5-failure-mode table + CI badge + the safety-gate use case
├── install.sh                   # minimal: copy skill/ -> ~/.claude/skills/peg-risk; flags --project/--path
├── CLAUDE.md                    # short standalone agent config mirroring the SKILL.md routing
├── .gitignore                   # node_modules, dist, .env, etc.
├── skill/
│   ├── SKILL.md                 # router, <150 lines, gate-framed, frontmatter name+description (see §7)
│   ├── peg-states.md            # asset taxonomy (8 classes) + 5 states + per-class thresholds + HOW to recalibrate
│   ├── failure-modes.md         # ⭐ THE novelty: 5 lies + 5 guards, each tied to a real incident (§5)
│   ├── computing-spread.md      # intrinsic vs market: the 2026 APIs (§4) + per-class intrinsic recipes (§6)
│   ├── assess.md                # the gate workflow → verdict + pasteable risk-params block
│   └── resources.md             # links (pegana-replay/METHODOLOGY.md, Pyth, Switchboard, Helius, Jupiter, Sanctum) + a 3-line "to run continuously" pointer (Helius webhook + Cloudflare DO alarm) — NOT a full mode
├── agents/
│   └── peg-risk-analyst.md       # 1 agent, model: opus, runs the gate end-to-end
├── commands/
│   └── peg-assess.md             # 1 command: /peg-assess <mint>
├── rules/
│   └── onchain-reads.md          # read-only / never-sign / devnet-default / treat on-chain data as untrusted
├── reference/
│   ├── classify.ts               # ⭐ TS port of the PUBLIC Rust methodology (pure functions; §8)
│   ├── assess.ts                 # live mainnet demo: pull intrinsic+market for a mint -> classify -> print verdict+params
│   ├── package.json              # type: module; tsx; vitest; @solana/kit; @pythnetwork/hermes-client
│   └── README.md                 # how to run classify tests + the live demo (needs HELIUS_API_KEY optional)
└── tests/
    ├── classify.test.ts          # ⭐ DETERMINISTIC offline unit tests (vitest) — the CI gate, no network/keys
    ├── run.ts                    # Haiku trigger test (does the description route?) — adapted from solana-dev
    └── package.json              # @anthropic-ai/sdk, tsx
```

One level deep only. No file references a file that references another file.

## 4. 2026 stack (context7-verified — use these, avoid the deprecated forms)

- **@solana/kit** (NOT `@solana/web3.js`): `import { address, createSolanaRpc, mainnet } from '@solana/kit'`; `createSolanaRpc(mainnet(url))`; every call ends `.send()`; `rpc.getTokenSupply(address(mint)).send()`; `fetchMint` from `@solana-program/token`. No `Connection`/`PublicKey`.
- **Pyth** pull/Hermes: `import { HermesClient } from '@pythnetwork/hermes-client'`; `new HermesClient('https://hermes.pyth.network', {})`; `getLatestPriceUpdates([feedId])` → `parsed[0].price = { price, conf, expo, publish_time }`; value = `Number(price)*10**expo`, confidence = `Number(conf)*10**expo`. Use feed **IDs** (`0x…`), not push price-accounts (deprecated).
- **Switchboard** On-Demand: `@switchboard-xyz/on-demand` (NOT `solana.js`); read via quote/bundle; staleness via slot delta. Mention as an alternative oracle source; Pyth is the primary in examples.
- **Helius DAS**: POST `https://mainnet.helius-rpc.com/?api-key=KEY`, method `getAsset`, `displayOptions.showFungible: true` → `result.token_info.price_info.price_per_token` (+ `.currency`, often `"USDC"`). `price_info` can be null for thin mints → fall back to Jupiter. **User supplies HELIUS_API_KEY** (kit MCP key 401s). LIVE-verified: USDC 0.9997, jitoSOL 94.33.
- **Jupiter** (keyless `lite-api.jup.ag`; keyed `api.jup.ag`): price = `GET /price/v3?ids=<mints>` → `{ "<mint>": { usdPrice, blockId, decimals, liquidity } }` (field is **`usdPrice`**, not v2 `.price`); depth = `GET /swap/v1/quote?inputMint=&outputMint=&amount=&slippageBps=` → `outAmount` + `priceImpactPct`. Probe depth on the THIN asset (not SOL→USDC). NOT the deprecated `quote-api.jup.ag/v6`. LIVE-verified: USDC 0.9998, USDY 1.138, jitoSOL 94.36.
- **Cloudflare** (only in the 3-line "operationalize" pointer): Durable Object alarms are single-shot (must re-arm in `alarm()`); Workers cron min granularity 1 minute.

## 5. The 5 failure modes (THE novelty — `failure-modes.md` content)

Each is a way a naive depeg check ("is it within X bps of $1?") lies, with the guard. Tie each to the real incident from the methodology docstrings. This is the uncopyable spine — write it as principles, drawn from production scar tissue.

1. **"Track the price vs $1."** Wrong for half the universe: an **LST legitimately trades above 1 SOL** as staking rewards accrue; a **yield stable trades around NAV**, not $1. → **Guard: spread = market − intrinsic**, where intrinsic is the issuer-controlled value (oracle NAV / on-chain exchange or redemption rate / CR), not the $1 sticker.
2. **"Any deviation is bad" (symmetric).** A **premium on an LST/yield stable is demand, not stress** — holders can always redeem at intrinsic (cf. stETH −7% 2022 and ezETH were *discounts*; the danger is sellers outrunning arbitrage). → **Guard: direction-sensitivity** — for `lst` and `stable_yield`, a premium normalizes to PEGGED; only the **discount** side classifies.
3. **"Trust the oracle."** Issuer feeds **lag execution and can stay confidently stale during a panic** (Maple syrupUSDC NAV lags 6–24h; many depegs began with a stale-but-confident feed). → **Guard: keep an independent executable market quote** and watch the *divergence*; never fuse/average sources — pick one per direction (issuer-NAV for intrinsic, market spot for market).
4. **"A single tick = a depeg."** One bad quote lies: a Jupiter route returning **`out_amount = 0` painted JupUSD CRITICAL for ~7.5 min** off one tick; a CR oscillating near a band **flapped hyUSD 52×/2 days**. → **Guard: plausibility filter** (reject `|discount| ≥ 1`, i.e. $0 or 2×), **EWMA smoothing** (α≈0.4), and **hysteresis** (time + a Schmitt-trigger magnitude deadband — escalate at the threshold, only relax once the signal clears `threshold×(1−deadband)`; CR side is inverted).
5. **"A confident number is a correct number."** A **broken intrinsic** can publish a confident PEGGED off garbage: a thin-liquidity NAV print read ~30% below market made one asset publish PEGGED off a bad anchor. → **Guard: NAV-sanity / fail-safe UNKNOWN** — a premium beyond a sanity bound (1000 bps) on a direction-sensitive class means the anchor is broken → emit **UNKNOWN**, never PEGGED. Missing/zero intrinsic → UNKNOWN, never discount=0. **UNKNOWN ≠ safe.**

## 6. Asset taxonomy, states, thresholds, and SCOPE TIERS (`peg-states.md` + `computing-spread.md`)

**5 peg states**: `PEGGED · DRIFT · DEPEG · CRITICAL · BLACK_SWAN` (+ `UNKNOWN` as the fail-safe). Strictness rank Pegged/Unknown=0, Drift=1, Depeg=2, Critical=3, BlackSwan=4.

**8 asset classes** (from `common-verify/src/lib.rs` `AssetClass`): `StableFiat, StableCdp, StableRwa, StableDn, StableFx, Lst, SynthLev, StableYield`. `anchor()` ∈ {USD, FX, NAV}.

**Per-class spread thresholds (bps) — DEFAULTS from METHODOLOGY.md** (drift / depeg / critical; black_swan defaults to 2×critical):
| Class | drift | depeg | critical | notes |
|---|---|---|---|---|
| stable_fiat (USDC/USDT/PYUSD) | 15 | 50 | 200 | symmetric |
| stable_cdp (hyUSD) | 10 | 30 | 100 | also has a **CR path** (below) |
| lst (jitoSOL/mSOL…) | 20 | 80 | 250 | **discount-only** |
| stable_yield (USDY/sUSD/syrupUSDC) | discount-only | 30 | 100 | **discount-only** |
| synth_lev (xSOL) | 100 | 300 | 1000 | symmetric |

**CR path** (CDP stables like hyUSD): thresholds in CR% — drift 150, depeg 130, critical 110, black_swan 100; **lower CR = worse** (inverted). Deadband `CR_DEADBAND_PCT=2`.
**Spread deadband** `DEADBAND_PCT=25`. **NAV premium sanity** `NAV_PREMIUM_SANITY_BPS=1000`. **EWMA** α=0.4.

**SCOPE TIERS — be honest in the docs:**
- **Tier 1 — ships a runnable adapter (`assess.ts` supports these end-to-end):**
  - `stable_fiat` / `stable_fx`: intrinsic = peg target (USD or FX cross via a Pyth FX feed); market = Jupiter `usdPrice`/quote.
  - any class whose intrinsic is a **Pyth feed** (NAV / redemption-rate `.RR` / FX cross): intrinsic via Hermes.
  - `lst`: intrinsic = SOL exchange rate via the **Sanctum public API** (`https://sanctum-extra-api.ngrok.dev` / documented Sanctum endpoint `/v1/sol-value/current` — verify the current public host in `resources.md`) OR stake-pool account decode (`@solana/kit`); market = Jupiter, SOL-denominated path (cancels the SOL/USD multiplier).
- **Tier 2 — documented on-chain-read RECIPE (taught in `computing-spread.md`, not a shipped live adapter):**
  - `stable_cdp` (hyUSD CR) and `synth_lev` (xSOL) via Hylo on-chain accounts (`getAccountInfo` on the public Hylo program); explain the formula `xsol_intrinsic = (collateral_sol − hyusd_supply_in_sol) / xsol_supply` and that adapter code is left to the integrator because the account layout is issuer-specific. Provide the method, not a brittle copied layout.

`assess.ts` must clearly print, for a Tier-2 asset, "intrinsic source not bundled — see computing-spread.md" rather than fabricate a number.

## 7. SKILL.md frontmatter (exact)

```yaml
---
name: peg-risk
description: <USE THE FINAL DESCRIPTION BELOW>
---
```

**FINAL description (verbatim, 3rd person, capability-first, no workflow leak):**

> Assesses depeg risk of Solana stablecoins and liquid-staking tokens before integrating, accepting them as collateral, routing through them, or listing them, and outputs concrete risk parameters (risk class, depeg thresholds, refuse-above-X-bps spread, oracle staleness bound). Use when evaluating whether a pegged asset (USDC, USDT, PYUSD, USDS, hyUSD, USDY, sUSD, syrupUSDC, jitoSOL, xSOL...) is currently sound, choosing collateral/oracle/liquidation thresholds, or when a token may be depegging, drifting, trading at a discount or premium to NAV, breaking its collateral ratio, or showing oracle-vs-market divergence. Covers fiat-backed, CDP, yield-bearing stables, LSTs, and leveraged synthetics.

SKILL.md body (<150 lines): a 1-paragraph "what this is for" (the safety gate), a **contrast table** vs adjacent skills (see below), an "Operating Procedure" routing table (task → file), a "Progressive Disclosure" list (the 5 sub-files, one line each), the command + agent, and a closing "this is read-only" note.

**Contrast table (defends Novelty — include in SKILL.md AND README):**
| Other skills | This skill |
|---|---|
| Pyth/Switchboard skills = give you a price | judges whether that price has **broken peg** |
| token-intel / rug scanners = mint/honeypot/holders safety | judges the asset's **peg-mechanism** risk (market-vs-intrinsic spread, NAV/CR) |
| jupiter-lend/kamino = a borrower's LTV/liquidation health | judges the **collateral asset's own** peg integrity before you accept it |

## 8. `classify.ts` — port contract (PURE functions, no network)

Port these from the public Rust (read `crates/methodology/src/{thresholds,discount,ewma,transition}.rs` + `crates/common-verify/src/lib.rs`). Use plain numbers (bps as integers; discount as a float/decimal). Keep names parallel:

- `type PegState = 'PEGGED'|'DRIFT'|'DEPEG'|'CRITICAL'|'BLACK_SWAN'|'UNKNOWN'`
- `type AssetClass = 'stable_fiat'|'stable_cdp'|'stable_rwa'|'stable_dn'|'stable_fx'|'lst'|'synth_lev'|'stable_yield'`
- `computeDiscount(intrinsic, market, {intrinsicSol?, marketSol?, class})`: returns `number | null`; `1 - market/intrinsic`; LST prefers SOL path; **null when intrinsic == 0** (never launder to 0); guard against division blowups (the F-12 lesson — return null, don't throw).
- `isPlausibleDiscountSample(d): boolean` = `Math.abs(d) < 1` (STRICT — the `out_amount=0` / `1.0` lesson).
- `applyEwma(raw, prev, alpha)`: `prev==null ? raw : alpha*raw + (1-alpha)*prev`.
- `isDirectionSensitive(class)`: true for `lst`, `stable_yield`.
- `NAV_PREMIUM_SANITY_BPS = 1000`; `premiumSanityViolated(class, discount)`: direction-sensitive AND discount<0 AND `|discount|*10000 > 1000`.
- `stateForBpsDiscount(discount, thresholds)`: black_swan/critical/depeg/drift/pegged on `|discount|*10000`, black_swan default = 2×critical.
- `stateForBpsDiscountAware(class, discount, thresholds)`: direction-sensitive premium → PEGGED, else delegate.
- `stateForCr(cr, thresholds)`: inverted (cr% < band → worse).
- `classifyWithHysteresis(class, discount, thresholds, current, deadbandPct)`: escalate at threshold; relax only below `threshold*(1-deadband/100)`.
- `classifyCrWithHysteresis(cr, thresholds, current, deadbandPct)`: inverted exit band `threshold*(1+deadband/100)`.
- `DEADBAND_PCT = 25`, `CR_DEADBAND_PCT = 2`, `EWMA_ALPHA = 0.4`.
- A top-level `classify({class, intrinsic, market, cr?, ...})` that wires: computeDiscount → plausibility → premium-sanity (→ UNKNOWN) → state. Returns `{ state, discountBps, direction, reason }`.

`classify.test.ts` (vitest, deterministic, the CI gate) must port the key Rust unit assertions: pegged/drift/depeg/critical/black_swan boundaries; LST & yield premium → PEGGED; discount side classifies; hysteresis enters at threshold / holds in deadband / repegs below exit / never slows escalation; CR escalates immediately / holds in band / relaxes above band; premium-sanity flags broken intrinsic but allows real premiums (−162 bps INF passes, −30% fails); zero/None intrinsic → null; `|d|≥1` rejected (the $0 / 2× boundary). ~25–30 cases.

## 9. Tests & Iron Law

- **RED baseline (run BEFORE finishing):** with the skill NOT installed, a naive agent answers "is jitoSOL depegging if it trades at 1.05 SOL?" by comparing to 1.0 (false alarm) and treats an LST premium as a depeg. Document this baseline in `tests/run.ts` comments as the gap the skill closes.
- `tests/run.ts`: Haiku trigger harness (adapt `/tmp/skills-research/solana-dev-skill/tests/run.ts`). ~12 should-trigger prompts (varied: "should my lending protocol accept hyUSD as collateral?", "is USDY safe to list?", "jitoSOL trading below NAV?", "depeg risk of syrupUSDC") + ~8 near-miss should-NOT (e.g. "swap USDC for SOL", "audit my anchor program", "is this token a rug?"). Loads the real description from SKILL.md. Needs `ANTHROPIC_API_KEY` (non-blocking job).
- **CI split**: `classify.test.ts` (offline, deterministic) = the gate; `run.ts` (key-gated) = optional; `assess.ts` live = manual demo. Add a `.github/workflows/ci.yml` that runs `vitest` on the offline tests only.

## 10. README.md (order)

Title + one-line + **CI badge** → the **5-failure-mode table** (lead with the novelty) → "The safety-gate use case" (the lending/listing scenario + an example `/peg-assess` risk-params output block) → What's inside → Install (`./install.sh` + `--project`) → Asset coverage (Tier 1 runnable / Tier 2 recipe — honest) → How it works (spread = market − intrinsic, 5 states, the guards) → **the contrast table** → Reference implementation & tests (runnable, CI-green) → Credits ("methodology: MIT, github.com/lrafasouza/pegana-replay") → License MIT.

Keep it sharp, technical, no hype words ("revolutionary", "powerful"). Show real numbers (USDC 0.9997, jitoSOL 94.33).
