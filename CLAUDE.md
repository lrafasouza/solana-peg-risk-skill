# Peg-Risk Skill — Agent Config

This file configures Claude Code to use the peg-risk skill when working in this repo or a project that has installed it.

## Skill

**Skill**: `peg-risk` (installed at `~/.claude/skills/peg-risk` or `.claude/skills/peg-risk`)

**Activates when**: evaluating whether a pegged asset (stablecoin, LST, yield-bearing stable, leveraged synthetic) is safe to integrate, accept as collateral, route through, or list; choosing depeg thresholds; investigating oracle-vs-market divergence; assessing a potential depeg event in progress.

## Stack

- **@solana/kit** (NOT `@solana/web3.js`) for all on-chain reads
- **@pythnetwork/hermes-client** for Pyth oracle feeds
- **Jupiter** `/price/v3` (`usdPrice` field) and `/swap/v1/quote` for market depth
- **Helius DAS** (`getAsset` with `showFungible: true`) for token metadata and market price
- **Sanctum** public API for LST SOL-value rates

## Sub-files (read in order for any gate workflow)

| File | Purpose |
|------|---------|
| `skill/peg-states.md` | 8 asset classes, 5 states, per-class thresholds (bps + CR), constants, recalibration guidance |
| `skill/failure-modes.md` | 5 ways a naive depeg check lies; 5 guards; real incidents |
| `skill/computing-spread.md` | Per-class intrinsic + market recipes; Tier 1 runnable / Tier 2 on-chain recipe |
| `skill/assess.md` | Gate workflow: classify → pull spread → run guards → emit VERDICT + RISK-PARAMS |
| `skill/resources.md` | Canonical API links, methodology source, operationalization pointer |

## Gate Workflow

1. Classify asset class from mint or name
2. Pull intrinsic and market per `computing-spread.md`
3. Compute discount, run plausibility + NAV-sanity guards
4. Classify with hysteresis
5. Emit VERDICT + pasteable RISK-PARAMS block

## Command

`/peg-assess <mint>` — runs the gate end-to-end

## Agent

`peg-risk-analyst` (model: opus) — performs the full classification workflow end-to-end

## Rules

- **Read-only**: all on-chain interactions are reads only; never sign, never send
- **UNKNOWN is not safe**: missing or broken intrinsic data → UNKNOWN → blocking signal
- **Thresholds are defaults**: treat per-class bps/CR values as starting points; recalibrate per asset
- **User supplies keys**: the kit's bundled Helius key returns 401; user must provide `HELIUS_API_KEY`
