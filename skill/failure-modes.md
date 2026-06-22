# Failure Modes — 5 Ways a Naive Depeg Check Lies

A naive depeg check does one thing: it asks "is the price within X bps of $1?" This check fails in 5 distinct ways. Each failure has a real mainnet incident attached to it. Understanding these failure modes is what separates a depeg guard that catches depegs from one that fires false alarms during normal operations and misses real stress.

Source: `crates/methodology/src/discount.rs` and `thresholds.rs` docstrings; production incidents dated in context.

---

## FM-1: Wrong Peg Target

**The naive lie**: "Track the price vs $1."

**Why it breaks**: Half the universe has a peg target that is not $1. An LST like jitoSOL legitimately trades above 1 SOL as staking rewards accrue. As of mid-2026, jitoSOL's exchange rate is ~1.118 SOL — a 11.8% "premium" over 1 SOL that is not a stress signal; it is staking yield accumulating in the token. A yield-bearing stable like USDY has a per-share NAV published by Ondo Finance's oracle — the market price will track NAV, not $1, as yield accrues. Treating either as a "$1 peg" fires constant false alarms on healthy assets or, worse, misses a real depeg because the "deviation from $1" metric is structurally meaningless.

**The guard**: Compute `spread = market − intrinsic`, where `intrinsic` is what the asset is *supposed to be worth* according to its issuance mechanism — the on-chain redemption rate for LSTs, the NAV oracle for yield stables, the $1 target for fiat stables. The spread is what tells you whether the market agrees with the mechanism. A zero spread means the market is arbitraging correctly. A negative spread (market below intrinsic) means the arbitrage path is stressed.

**The formula** (`discount.rs`): `discount = 1 - market/intrinsic`. Positive discount = market below intrinsic (stress). Negative discount = market above intrinsic (premium, demand, or broken intrinsic — see FM-5).

---

## FM-2: Wrong Direction Interpretation

**The naive lie**: "Any deviation from peg is bad."

**Why it breaks**: A premium on an LST or yield-bearing stable is not a stress signal — it is demand. LST holders can always redeem at intrinsic (the on-chain exchange rate); the premium is bid pressure from secondary market buyers who have not yet arbitraged. The dangerous direction for LSTs and yield stables is the *discount* — when `market < intrinsic`, it means sellers are outrunning arbitrageurs (redemption stress, illiquidity, or panic). The 2022 stETH incident was a 7% *discount*. The ezETH depeg was a *discount*. Both triggered at discount, not premium. A system that fires on LST premiums will fire constantly on every epoch boundary and every inflow surge.

**The guard**: Direction-sensitive classification. For `lst` and `stable_yield`, a premium (negative discount) normalizes to PEGGED. Only the discount side runs through the threshold bands. The production implementation is `is_direction_sensitive()` in `thresholds.rs` combined with `state_for_bps_discount_aware()`, which short-circuits premium → PEGGED before reaching the threshold logic. Symmetric classes (`stable_fiat`, `stable_cdp`, `stable_fx`, `synth_lev`) use the absolute value of the discount for both directions.

**Real guard limit — INF case**: INF (Infinity by Sanctum) has shown a legitimate premium of ~162 bps, the widest observed across 26 production assets. This premium passes through correctly as PEGGED. The 1000 bps NAV-sanity ceiling (FM-5) ensures premiums that are implausibly large are caught as data-quality failures, not accepted as legitimate.

---

## FM-3: Trusting the Oracle

**The naive lie**: "Trust the issuer oracle — if it says the asset is worth $1.00, it is."

**Why it breaks**: Issuer-controlled feeds lag execution and can remain confident and stale during a panic. Maple Finance publishes syrupUSDC's NAV once per day. If liquidity disappears intraday, the executable spot market reflects it within seconds; the NAV feed lags 6–24 hours. The feed continues to publish NAV ≈ $1.00 while real redemption attempts are being haircut or gated. Many high-profile depeg incidents began with an oracle feed publishing stale-but-confident values during the stress period. Using only the oracle gives you a 6–24 hour blind spot precisely during the event that matters.

**The guard**: Keep an independent executable market quote as the `market` side. Never fuse or average the two sources — that dilutes both signals and creates a composite number with unclear meaning. Instead, use them as two separate inputs: issuer-controlled oracle as `intrinsic`, deepest executable venue (Jupiter route, Pyth spot feed) as `market`. Watch the divergence between them. When they agree, the spread is ~0. When they diverge, the spread quantifies how much the market disagrees with the issuer's declared value — which is exactly the information you need.

**Implication for integration**: If you only have access to the issuer oracle and no executable market quote, the honest output is UNKNOWN. Missing-data UNKNOWN is not confirmation of a healthy peg.

---

## FM-4: Single-Tick Trigger

**The naive lie**: "One tick showing a 100 bps deviation means the asset is in DEPEG."

**Why it breaks in two ways**:

*False alarm (the $0 tick)*: On 2026-06-12, a Jupiter route for JupUSD returned `out_amount = 0`. The discount formula (`1 - market/intrinsic`) returned exactly `1.0` (a 100% "discount"). The initial implementation used an `≤ 1.0` plausibility bound, which let the `1.0` value through. With EWMA α=0.3, this single tick poisoned the smoothed value long enough to publish JupUSD as CRITICAL for approximately 7.5 minutes. No asset was actually trading at $0.

*Oscillation (the hyUSD flap)*: hyUSD's CR oscillated near the 130% depeg threshold, crossing back and forth as SOL/USD oracle jitter clipped the threshold. Without a deadband, the state machine emitted 52 DEPEG↔DRIFT transitions over 2 days. Each transition was technically correct for that tick, but the signal was noise, not stress.

**The guard — two layers**:

1. **Plausibility filter**: Reject any raw discount sample where `|discount| ≥ 1.0` (strict bound). No real asset trades at $0 or at 2× its intrinsic value. This is guard code in `is_plausible_discount_sample()` — a single bad tick does not enter the EWMA. The bound is strict (`<`, not `≤`) because `1.0` exactly (the $0 case) was the incident boundary.

2. **EWMA + Schmitt-trigger deadband**: EWMA (α=0.4) attenuates single-tick spikes by ~80%. The Schmitt-trigger deadband (`DEADBAND_PCT=25`) prevents oscillation near thresholds: escalate at the normal threshold; relax only once the smoothed discount falls below `threshold × (1 − 0.25)`. Example with drift=60 bps (JupSOL): enter DRIFT at 60 bps, exit DRIFT only below 45 bps. A discount bouncing between 48 and 64 bps stays in DRIFT rather than flapping.

**Escalation is never slowed**: The deadband only applies to relaxation (moving to a less-strict state). Escalation (moving to a stricter state) always uses the full threshold — a worsening peg is never held in a better state by the deadband.

---

## FM-5: Confident Number, Broken Anchor

**The naive lie**: "The oracle published a confident number, so the intrinsic is correct."

**Why it breaks**: A broken intrinsic source can make a direction-sensitive asset (LST, yield stable) publish a confident PEGGED off garbage data. The FM-2 guard (direction-sensitive: premium → PEGGED) is correct for real premiums, but it has a failure mode: if the intrinsic feed reads far too low (e.g., a thin-liquidity Jupiter NAV for sHYUSD printing ~30% below the real NAV), the market sits far "above" the intrinsic. The spread is a large negative premium. The direction-sensitive guard normalizes that large negative premium to PEGGED — and the asset publishes a confident PEGGED status off a garbage anchor.

The sHYUSD case: market ≈ +30% over a thin-Jupiter NAV print made the asset appear to have an enormous positive premium. The direction-sensitive carve-out (premium → PEGGED) was triggered. The actual intrinsic was broken, not the peg. No real LST or yield stable premium approaches 30% — the widest observed legitimate premium across 26 production assets is INF at ~162 bps (1.62%).

**The guard — NAV-sanity / fail-safe UNKNOWN**:

A premium beyond `NAV_PREMIUM_SANITY_BPS = 1000` (10%) on a direction-sensitive class means the intrinsic anchor is almost certainly broken. At this magnitude, the correct output is `UNKNOWN` (broken intrinsic), not PEGGED. The check: `premium_sanity_violated(class, discount)` returns true when the class is direction-sensitive AND `|discount| × 10000 > 1000`.

The 1000 bps boundary provides a >6× margin over the widest legitimate premium (162 bps). It catches the sHYUSD-class masking with zero false positives against every observed legitimate premium.

**What UNKNOWN means here**: Not "we don't know if it is pegged or depegging" — it means "the data we would need to make that determination is broken." That is not a safe state. An asset with a broken intrinsic feed is not something you can safely accept as collateral or route through. Treat UNKNOWN as a blocking signal requiring manual investigation.

**Also blocks the zero/missing intrinsic case**: `compute_discount()` returns `None` when intrinsic is zero or absent. A zero or missing intrinsic must not be laundered into `discount = 0`, which the state machine would read as a confirmed healthy peg (a zero discount means intrinsic exactly equals market). The `None` return routes to UNKNOWN, not PEGGED.

---

## Summary Table

| # | Naive assumption | Failure | Guard | Real incident |
|---|---|---|---|---|
| FM-1 | Price vs $1 | LSTs/yield stables always look "depegged" | `spread = market − intrinsic` | jitoSOL 11.8% above $1 (correct, not stress) |
| FM-2 | Any deviation = bad | LST/yield premium fires false alarms | Direction-sensitive: premium → PEGGED for `lst`, `stable_yield` | stETH −7% 2022 and ezETH were *discounts*; demand premiums are normal |
| FM-3 | Trust the oracle | 6–24h blind spot during intraday stress | Independent executable market quote; never fuse sources | Maple/syrupUSDC daily NAV lags intraday redemption freeze |
| FM-4 | One tick = real depeg | $0 route paints CRITICAL; CR oscillation generates 52 transitions | Plausibility filter (`|d|<1.0` strict) + EWMA + Schmitt deadband | JupUSD CRITICAL 7.5 min (2026-06-12); hyUSD 52 flaps/2d |
| FM-5 | Confident = correct | Broken intrinsic publishes PEGGED off garbage anchor | NAV-sanity: premium > 1000 bps → UNKNOWN; zero intrinsic → UNKNOWN | sHYUSD +30% over thin NAV → false PEGGED |
