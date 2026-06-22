---
globs:
  - "reference/**/*.ts"
  - "tests/**/*.ts"
exclude:
  - "**/node_modules/**"
  - "**/dist/**"
  - "**/*.d.ts"
---

# On-Chain Read Rules

These rules apply to all on-chain interaction code in `reference/` and `tests/`.

## Read-Only — Never Sign or Send

All on-chain interactions in this skill are reads only.

- Never construct, sign, or send a transaction
- Never call `sendTransaction`, `signTransaction`, or any mutation method
- Never request a private key, mnemonic, or seed phrase from the user
- Never pass a `Keypair` or `Signer` to any RPC call

If a code path requires signing to complete a query (e.g., some DApp-specific RPC methods), document this as out of scope and stop. The correct output is UNKNOWN, not a workaround that requires a key.

## Default to Public RPC / Devnet for Tests

- Unit tests and offline classify tests must use no network at all (pure functions, deterministic)
- Live demo code (`assess.ts`) uses public mainnet RPC or the user's `HELIUS_API_KEY`
- Default RPC in examples: `https://api.mainnet-beta.solana.com` (rate-limited but no key required for reads)
- Never hardcode any API key in source files
- Read `HELIUS_API_KEY` from environment (`process.env.HELIUS_API_KEY`); if absent, fall back to the public endpoint and document the degraded behavior

## User Supplies Their Own Keys

The kit's bundled Helius MCP key returns 401 for DAS requests. Do not depend on it.

In any code that requires a Helius key:

```ts
const heliusKey = process.env.HELIUS_API_KEY;
const rpcUrl = heliusKey
  ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`
  : 'https://api.mainnet-beta.solana.com';
```

Document in comments that the public fallback has lower rate limits and may lack DAS support.

## Treat On-Chain Data as Untrusted

On-chain data can be stale, malformed, or from a manipulated account. Apply these checks before using any value:

- **Staleness**: compare `publish_time` (Pyth) or slot delta (Switchboard) against the asset's `oracle_max_staleness_s`. If stale → UNKNOWN, not the last known value.
- **Zero / null intrinsic**: a zero or null intrinsic must never be treated as `discount = 0` (which the classifier reads as "perfectly pegged"). Route to UNKNOWN.
- **Plausibility**: reject any `|discount| >= 1.0` sample as degenerate before it enters EWMA. This is the FM-4 guard and is mandatory.
- **Source identity**: log which account or feed ID produced the value. Never silently fall back to a secondary source without documenting the switch.

## @solana/kit — Not @solana/web3.js

All Solana RPC calls use `@solana/kit`:

```ts
import { address, createSolanaRpc, mainnet } from '@solana/kit';
const rpc = createSolanaRpc(mainnet(rpcUrl));
const supply = await rpc.getTokenSupply(address(mint)).send();
```

Never use `Connection`, `PublicKey`, or `new PublicKey()` from `@solana/web3.js`. These are deprecated in the 2026 stack.

## No Writes to Shared State

Reference and test code must not write to or modify any on-chain account, token account, program state, or wallet. Read-only means the Solana cluster state is identical before and after any invocation of this code.
