#!/usr/bin/env npx tsx
/**
 * tests/run.ts — Haiku trigger harness for the peg-risk skill.
 *
 * Adapted from /tmp/skills-research/solana-dev-skill/tests/run.ts.
 *
 * Usage:
 *   npx tsx run.ts                   # run trigger suite
 *   npx tsx run.ts --verbose         # show model reasoning per case
 *   npx tsx run.ts --case 3          # run a single case (1-indexed)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RED BASELINE (SPEC §9) — The gap this skill closes
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Without this skill, a naive agent makes two systematic errors when asked about
 * Solana pegged-asset safety:
 *
 * ERROR 1 — Wrong reference peg for LSTs:
 *   Q: "Is jitoSOL depegging if it trades at 1.05 SOL?"
 *   Naive agent: "jitoSOL should equal 1.00 SOL; 1.05 is +5% away → DEPEG alarm."
 *   Reality:     jitoSOL's intrinsic value is the SOL-denominated exchange rate
 *                (staking rewards accrued). If jitoSOL is worth 1.052 SOL per the
 *                Sanctum pool, a 1.05 SOL market price is actually a −19 bps DISCOUNT
 *                → PEGGED (within the 20 bps drift band for LSTs). The naive agent
 *                fires a false alarm.
 *
 * ERROR 2 — LST premium treated as a depeg:
 *   Q: "jitoSOL is trading at 1.06 SOL but Sanctum says intrinsic is 1.052 SOL — depeg?"
 *   Naive agent: "Price (1.06) > peg (1.0) by +6% → something is wrong."
 *   Reality:     jitoSOL is DIRECTION-SENSITIVE. A premium (market > intrinsic) means
 *                demand exceeds supply of arbitrage — holders can always redeem at
 *                intrinsic. The danger is discounts (sellers outrunning arb). The skill
 *                classifies a +76 bps premium as PEGGED, not DEPEG.
 *
 * This skill closes both gaps by teaching: spread = market − intrinsic (not $1.00),
 * direction-sensitivity (premium → PEGGED for LSTs/yield stables), and the 5 guards
 * against naive depeg lies documented in failure-modes.md.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ─────────────────────────────────────────────────────────────────
const MODEL = "claude-haiku-4-5-20251001";
const TARGET_SKILL = "peg-risk";

// ── Helpers ────────────────────────────────────────────────────────────────
interface SkillEntry {
  name: string;
  description: string;
}

function loadSkillDescription(path: string): SkillEntry | null {
  try {
    const content = readFileSync(path, "utf-8");
    // Match YAML frontmatter block
    const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return null;
    const frontmatter = match[1];
    const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    // Description may span multiple lines via YAML block scalar — grab the single-line form
    const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    if (!name || !description) return null;
    return { name, description };
  } catch {
    return null;
  }
}

// Load the REAL skill description from frontmatter
const targetSkill = loadSkillDescription(resolve(__dirname, "../skill/SKILL.md"));
if (!targetSkill) {
  console.error("ERROR: Could not load peg-risk skill description from ../skill/SKILL.md");
  process.exit(1);
}

// ── Decoy competitor skills (realistic near-misses) ────────────────────────
// These are plausible ecosystem skills that could attract similar prompts but
// serve different purposes. They stress-test that the trigger boundary is clean.
const DECOY_SKILLS: SkillEntry[] = [
  {
    name: "token-rug-scanner",
    description:
      "Scans a Solana token mint for rug-pull indicators: mint authority enabled, freeze authority, honeypot liquidity traps, sniper concentration, top-10 holder dominance, and bundled launch patterns. Use when checking whether a new token is safe to buy or list on a DEX, or when investigating suspicious mint behavior.",
  },
  {
    name: "jupiter-swap",
    description:
      "Execute or simulate token swaps on Jupiter aggregator. Finds optimal routes, estimates price impact, handles slippage configuration, and submits swap transactions. Use when a user wants to swap tokens, get a quote, or check the best route between two SPL tokens.",
  },
  {
    name: "anchor-audit",
    description:
      "Reviews Anchor programs for security vulnerabilities: missing signer checks, unchecked account ownership, integer overflow, PDA seed collisions, CPI privilege escalation, missing rent-exempt guards, and re-entrancy risks. Use when auditing Solana program code for security issues before deployment.",
  },
  {
    name: "find-skills",
    description:
      "Helps users discover, install, and configure agent skills. Lists available skills, explains what each one does, and guides installation. Use when a user asks what skills are available, wants to install a skill, or needs help finding the right skill for a task.",
  },
  {
    name: "solana-price-oracle",
    description:
      "Fetches real-time price data from Pyth Network and Switchboard oracles on Solana. Returns current price, confidence interval, and staleness metrics for any supported price feed. Use when you need a current market price, oracle confidence band, or want to compare Pyth vs Switchboard feeds.",
  },
  {
    name: "kamino-lend",
    description:
      "Manages positions in Kamino Finance lending markets: deposit collateral, borrow assets, check LTV ratio, monitor liquidation health, and adjust leverage. Use when a user wants to interact with Kamino lending pools, check their borrow health factor, or manage a leveraged position.",
  },
];

// Full skill list presented to the model
const ALL_SKILLS: SkillEntry[] = [targetSkill, ...DECOY_SKILLS];

// ── Types ──────────────────────────────────────────────────────────────────
interface TestCase {
  prompt: string;
  expected: boolean;
}

interface SuiteResult {
  name: string;
  pass: number;
  fail: number;
  failures: { prompt: string; expected: boolean; got: boolean; reasoning: string }[];
}

// ── System prompt ──────────────────────────────────────────────────────────
const TRIGGER_SYSTEM_PROMPT = `You are a skill-matching engine for a coding assistant.
You are given a list of available skills with their names and descriptions.
Your job is to decide which skills (if any) should be activated for the user's message.

Available skills:
${ALL_SKILLS.map((s) => `- ${s.name}: ${s.description}`).join("\n")}

Respond with a JSON object:
{
  "triggered_skills": ["skill-name", ...],
  "reasoning": "brief explanation"
}

Rules:
- Only include skills that are clearly relevant to the user's request.
- If no skill matches, return an empty array.
- A skill should trigger when the user's request falls within its described scope.
- Do not trigger a skill for tangentially related requests.
- Respond ONLY with the JSON object, no other text.`;

// ── Test cases ─────────────────────────────────────────────────────────────
//
// SHOULD-TRIGGER (12 cases): varied, messy, realistic DeFi builder prompts.
// Many use domain slang or imprecise phrasing — the description must be robust
// enough to catch them without false positives on the decoy skills.
//
// SHOULD-NOT-TRIGGER (8 cases): genuine near-misses that belong to decoys or
// unrelated domains. These stress-test the boundary precision.
//
const TRIGGER_CASES: TestCase[] = [
  // ── SHOULD trigger (expected: true) ────────────────────────────────────
  {
    // Core collateral-acceptance question with a specific CDP stable
    prompt: "Should my lending protocol accept hyUSD as collateral?",
    expected: true,
  },
  {
    // Listing-safety question for a yield-bearing stable
    prompt: "Is USDY safe to list on my perps venue?",
    expected: true,
  },
  {
    // LST premium/discount question — the canonical RED baseline scenario
    prompt: "jitoSOL is trading at 1.05 SOL but the pool says it should be worth 1.052 SOL. Is that a depeg?",
    expected: true,
  },
  {
    // Spread threshold / refuse-price question for a yield stable
    prompt: "What spread should I refuse syrupUSDC at in my routing logic?",
    expected: true,
  },
  {
    // Generic "is this stablecoin about to depeg?" — broad entry point
    prompt: "Is this stablecoin about to depeg?",
    expected: true,
  },
  {
    // Messier phrasing — NAV divergence / oracle lag concern
    prompt: "I noticed USDY oracle is showing $1.13 but the market price dropped to $1.09. Is that normal or a warning sign?",
    expected: true,
  },
  {
    // CR path — CDP-style collateral ratio question
    prompt: "hyUSD collateral ratio just dropped to 125%. Should I halt new borrows?",
    expected: true,
  },
  {
    // Discount vs. premium framing with an LST
    prompt: "mSOL is trading 40 bps below its Sanctum redemption rate. How should I classify that?",
    expected: true,
  },
  {
    // Integration decision phrasing — what risk params to set
    prompt: "We're integrating sUSD into our protocol. What liquidation threshold and oracle staleness bound should we use?",
    expected: true,
  },
  {
    // Casual phrasing — "is X safe right now?"
    prompt: "Is USDC still pegged? It felt wobbly yesterday.",
    expected: true,
  },
  {
    // Leveraged synthetic — xSOL spread question
    prompt: "xSOL is showing a 350 bps discount to its mark price. Is that a depeg or normal volatility?",
    expected: true,
  },
  {
    // RWA stable — PYUSD listing risk framing
    prompt: "What risk parameters should I apply when PYUSD trades at a 30 bps discount to $1?",
    expected: true,
  },

  // ── SHOULD NOT trigger (expected: false) ───────────────────────────────
  {
    // Swap execution — belongs to jupiter-swap, not a peg safety gate
    prompt: "Swap 10 USDC for SOL using Jupiter, minimize slippage.",
    expected: false,
  },
  {
    // Anchor program security audit — belongs to anchor-audit
    prompt: "Audit my Anchor program for missing signer checks and PDA seed collisions.",
    expected: false,
  },
  {
    // Token rug / honeypot check — belongs to token-rug-scanner
    prompt: "Is this memecoin a honeypot rug? Check the mint authority and holder concentration.",
    expected: false,
  },
  {
    // Deployment task — unrelated to peg risk
    prompt: "Deploy my Solana program to mainnet using the Anchor CLI.",
    expected: false,
  },
  {
    // Oracle price fetch — belongs to solana-price-oracle, not a peg safety gate
    prompt: "Get me the current Pyth price for SOL/USD with confidence interval.",
    expected: false,
  },
  {
    // Borrower health / LTV — belongs to kamino-lend, not asset-level peg integrity
    prompt: "My Kamino position LTV is 78%. Should I add more collateral to avoid liquidation?",
    expected: false,
  },
  {
    // Skill discovery — belongs to find-skills
    prompt: "What skills are available for Solana DeFi? Help me find the right one.",
    expected: false,
  },
  {
    // Generic Ethereum smart contract — wrong chain, wrong domain
    prompt: "Is my Uniswap v3 USDC/ETH pool vulnerable to price manipulation?",
    expected: false,
  },
];

// ── Evaluator ──────────────────────────────────────────────────────────────
function triggerEvaluator(text: string): { matched: boolean; reasoning: string } {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch?.[0] ?? text);
    const triggered: string[] = Array.isArray(parsed.triggered_skills) ? parsed.triggered_skills : [];
    const matched = triggered.includes(TARGET_SKILL);
    return {
      matched,
      reasoning: `triggered=[${triggered.join(", ")}] — ${parsed.reasoning}`,
    };
  } catch {
    return { matched: false, reasoning: `[parse error] ${text.slice(0, 120)}` };
  }
}

// ── Suite runner ───────────────────────────────────────────────────────────
async function runSuite(
  client: Anthropic,
  suiteName: string,
  systemPrompt: string,
  cases: TestCase[],
  evaluator: (text: string) => { matched: boolean; reasoning: string },
  verbose: boolean,
  singleCase: number,
): Promise<SuiteResult> {
  const selected = singleCase >= 0 ? [cases[singleCase]] : cases;
  const startIdx = singleCase >= 0 ? singleCase : 0;

  const result: SuiteResult = { name: suiteName, pass: 0, fail: 0, failures: [] };

  console.log(`\n🧪 ${suiteName}`);
  console.log(`   Model : ${MODEL}`);
  console.log(`   Skill : ${TARGET_SKILL}`);
  console.log(`   Cases : ${selected.length} (${cases.filter((c) => c.expected).length} should-trigger, ${cases.filter((c) => !c.expected).length} should-not)\n`);

  for (let i = 0; i < selected.length; i++) {
    const { prompt, expected } = selected[i];
    const idx = startIdx + i + 1;

    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content[0].type === "text" ? response.content[0].text : "";
      const { matched, reasoning } = evaluator(text);
      const ok = matched === expected;

      if (ok) {
        result.pass++;
        console.log(`  ✅ #${idx} [${expected ? "TRIGGER" : "SKIP   "}] "${prompt}"`);
      } else {
        result.fail++;
        console.log(`  ❌ #${idx} [${expected ? "TRIGGER" : "SKIP   "}] "${prompt}"`);
        result.failures.push({ prompt, expected, got: matched, reasoning });
      }

      if (verbose) {
        console.log(`        → ${reasoning}\n`);
      }
    } catch (err: unknown) {
      result.fail++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  💥 #${idx} ERROR — "${prompt}": ${msg}`);
      result.failures.push({
        prompt,
        expected,
        got: !expected,
        reasoning: `API error: ${msg}`,
      });
    }
  }

  return result;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ERROR: ANTHROPIC_API_KEY is not set. Export it before running this harness.");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose");
  const caseIdx = args.includes("--case")
    ? parseInt(args[args.indexOf("--case") + 1], 10) - 1
    : -1;

  const client = new Anthropic({ apiKey });

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  peg-risk skill — trigger harness`);
  console.log(`  Skill loaded from: skill/SKILL.md`);
  console.log(`  Description: ${targetSkill.description.slice(0, 80)}…`);
  console.log(`${"═".repeat(60)}`);

  const result = await runSuite(
    client,
    "peg-risk skill trigger matching",
    TRIGGER_SYSTEM_PROMPT,
    TRIGGER_CASES,
    triggerEvaluator,
    verbose,
    caseIdx,
  );

  // ── Summary ──────────────────────────────────────────────────────────────
  const total = result.pass + result.fail;
  const pct = total > 0 ? Math.round((result.pass / total) * 100) : 0;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${result.name}`);
  console.log(`  Result : ${result.pass}/${total} passed (${pct}%)`);

  if (result.failures.length > 0) {
    console.log(`\n  Failures:`);
    for (const f of result.failures) {
      console.log(`    ❌ "${f.prompt}"`);
      console.log(`       expected ${f.expected ? "TRIGGER" : "SKIP"}, got ${f.got ? "TRIGGER" : "SKIP"}`);
      console.log(`       ${f.reasoning}`);
    }
  }

  console.log(`${"─".repeat(60)}\n`);

  process.exit(result.fail > 0 ? 1 : 0);
}

main();
