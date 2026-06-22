---
name: peg-risk
description: Assesses depeg risk of Solana stablecoins and liquid-staking tokens before integrating, accepting them as collateral, routing through them, or listing them, and outputs concrete risk parameters (risk class, depeg thresholds, refuse-above-X-bps spread, oracle staleness bound). Use when evaluating whether a pegged asset (USDC, USDT, PYUSD, USDS, hyUSD, USDY, sUSD, syrupUSDC, jitoSOL, xSOL...) is currently sound, choosing collateral/oracle/liquidation thresholds, or when a token may be depegging, drifting, trading at a discount or premium to NAV, breaking its collateral ratio, or showing oracle-vs-market divergence. Covers fiat-backed, CDP, yield-bearing stables, LSTs, and leveraged synthetics.
---

# peg-risk — Collateral & Listing Safety Gate

This skill answers one question before you ship: **is this pegged asset safe to integrate right now, and what parameters should govern it?** It is a pre-integration safety gate — not a monitoring dashboard. The output is a pasteable `RISK-PARAMS` block (asset class, warn/refuse/liquidate thresholds in bps, oracle staleness bound, direction sensitivity) you can drop directly into lending protocol config, listing logic, or routing guards. The methodology is derived from a public, MIT-licensed peg-risk framework (`github.com/lrafasouza/pegana-replay`) that has been running in production on Solana mainnet since 2026-05-29.

---

## Why this is not the same as adjacent tools

| Other skills/tools | This skill |
|---|---|
| Pyth / Switchboard skills — give you a price | Judges whether that price has **broken peg** relative to intrinsic value |
| Token-intel / rug scanners — mint, honeypot, holder safety | Judges the asset's **peg mechanism** risk (market-vs-intrinsic spread, NAV/CR) |
| jupiter-lend / kamino — a borrower's LTV / liquidation health | Judges the **collateral asset's own** peg integrity before you accept it |

---

## Operating Procedure

| What you need | Go to |
|---|---|
| Understand the 5 states and per-class thresholds | `peg-states.md` |
| Understand why naive depeg checks lie (and the 5 real guards) | `failure-modes.md` |
| Get intrinsic + market prices for a specific asset class | `computing-spread.md` |
| Run the full gate and produce a RISK-PARAMS verdict | `assess.md` |
| Links to APIs, methodology source, operationalization pointer | `resources.md` |

---

## Progressive Disclosure

- **`peg-states.md`** — 8 asset classes, 5 states, per-class threshold tables (bps + CR path), constants, and how to recalibrate defaults per asset.
- **`failure-modes.md`** — The 5 ways a naive depeg check lies, with the guard for each and the real mainnet incident that proved it.
- **`computing-spread.md`** — How to compute `intrinsic` and `market` for each class using 2026 APIs (Pyth Hermes, Jupiter, Helius DAS, Sanctum, @solana/kit). Includes Tier 1 runnable adapters and Tier 2 on-chain-read recipes.
- **`assess.md`** — The gate workflow: classify asset → pull spread → run classifier → emit VERDICT + pasteable RISK-PARAMS block. Includes a worked jitoSOL example.
- **`resources.md`** — Canonical links to methodology source, Pyth, Helius, Jupiter, Sanctum, Switchboard, plus a 3-line "run this continuously" pointer.

---

## Command & Agent

- **Command**: `/peg-assess <mint>` — runs the gate end-to-end for a given mint address.
- **Agent**: `peg-risk-analyst` (model: opus) — performs the full classification workflow.

---

> **This skill is read-only.** All on-chain interactions are reads only. The skill never signs transactions, never sends funds, and never requests a private key. Always use your own `HELIUS_API_KEY`; the kit's bundled key returns 401. Thresholds in this skill are defaults derived from production data — treat them as starting points and recalibrate per asset.
