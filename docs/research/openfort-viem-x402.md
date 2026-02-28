---
date: 2026-02-28T10:25:00Z
researcher: Researcher
git_commit: n/a
branch: n/a
repository: desplega-ai/agent-swarm
topic: "Openfort viem integration as a robust alternative for x402 payments in agent-swarm"
tags: [research, x402, openfort, viem, payments, eip-3009, managed-wallets]
status: complete
autonomy: autopilot
last_updated: 2026-02-28
last_updated_by: Researcher
---

# Research: Openfort Viem Integration as a Robust Alternative for x402 Payments

**Date**: 2026-02-28
**Researcher**: Researcher (agent-swarm worker)
**Context**: PR #108 adds x402 payment capability; feedback that current approach is "too yolo"

## Research Question

Can Openfort's viem integration replace the raw `EVM_PRIVATE_KEY` approach in PR #108 for x402 payments, and is it a production-ready improvement?

## Summary

**Yes, Openfort's backend wallets are technically compatible with the x402 payment flow.** The x402 SDK's `ClientEvmSigner` interface only requires `address` and `signTypedData` — Openfort's backend wallet provides both. The integration would require ~20 lines of adapter code. However, the trade-off is not straightforward: Openfort adds managed key custody and eliminates raw private keys in env vars, but introduces API latency (~125ms per sign), a vendor dependency on a small startup (7 employees, $3M raised, 658 weekly npm downloads), and per-operation costs.

**Recommendation: Implement a provider-agnostic signer abstraction** in `src/x402/` that supports both raw viem accounts (current) and Openfort accounts (new option). This avoids vendor lock-in while giving operators the choice of managed key infrastructure. The current approach should remain as the default for simplicity; Openfort becomes an opt-in upgrade for production deployments that need managed custody.

## Detailed Findings

### 1. What is Openfort?

Openfort is a wallet-as-a-service platform providing embedded wallets, backend wallets, account abstraction (ERC-4337/EIP-7702), gas sponsorship, and key management. They position themselves as "Money Movement Infrastructure for AI Agents & Stablecoins."

**Company facts:**
- Founded 2022, CEO Joan Alavedra
- ~7 employees, $3M raised (Seed, May 2023)
- Originally gaming-focused, pivoting to AI agents and stablecoins
- Open-source key management (OpenSigner) using Shamir Secret Sharing (2-of-3 threshold)
- SOC2 Type II claimed (unverified), Quantstamp audit in progress for OpenSigner

**Key products relevant to our use case:**
| Product | Description |
|---------|-------------|
| Backend Wallets | Server-side EOA wallets, keys secured in Google Cloud TEE. Up to 500 write TPS claimed. |
| OpenSigner | Open-source, self-hostable key management using Shamir Secret Sharing |
| Gas Sponsorship | Native ERC-4337 paymaster (not needed for x402 — the facilitator pays gas) |
| Session Keys | Scoped, time-limited signing permissions (potential future feature for agents) |

**Pricing:**
| Plan | Monthly | Included Ops | Overage |
|------|---------|-------------|---------|
| Free | $0 | 2,000 | $0.01/op |
| Growth | $99 | 25,000 | $0.008/op |
| Pro | $249 | 100,000 | $0.006/op |
| Scale | $599 | 500,000 | $0.004/op |

For our use case (agents making x402 payments), each payment requires one `signTypedData` API call = 1 operation. At the Free tier, that is 2,000 payments/month before charges. At Growth ($99/mo), 25,000 payments/month.

**Supported chains:** 25+ EVM chains (Ethereum, Base, Polygon, Arbitrum, etc.) + Solana.

### 2. How the Openfort Viem Integration Works

The `@openfort/openfort-node` SDK (v0.9.1) provides a `toEvmAccount()` internal factory that creates an account object with viem-compatible signing methods.

**Architecture:**
```
@openfort/openfort-node
  └── src/wallets/evm/
        ├── accounts/evmAccount.ts   ← toEvmAccount() factory
        ├── actions/                  ← signHash, signMessage, signTransaction, signTypedData
        ├── evmClient.ts             ← EvmClient class
        └── types.ts                 ← Uses viem types (Address, Hex, etc.)
```

**How it works:**
1. You instantiate the SDK with an API key + wallet secret
2. `openfort.accounts.evm.backend.create()` creates a backend wallet (EOA secured in TEE)
3. The returned account object has `signMessage()`, `signTypedData()`, `signTransaction()`, `sign()`
4. Each signing operation makes an HTTP API call to Openfort's backend — the private key never leaves the TEE

**The account is NOT a native viem `LocalAccount`** — it has the same method signatures but different TypeScript types (`id`, `custody` fields). To use with viem's `WalletClient`, you wrap it via `toAccount()`:

```typescript
import { toAccount } from "viem/accounts";

const openfortAccount = await openfort.accounts.evm.backend.create();
const viemAccount = toAccount({
  address: openfortAccount.address,
  async signMessage({ message }) { return openfortAccount.signMessage({ message }); },
  async signTransaction(tx) { return openfortAccount.signTransaction(tx); },
  async signTypedData(data) { return openfortAccount.signTypedData(data); },
});
```

**Signing flow per operation:**
| Operation | Client-side (viem utils) | API call | Latency |
|-----------|-------------------------|----------|---------|
| `signMessage` | EIP-191 prefix via `toPrefixedMessage()` | Backend hashes + signs | ~125ms |
| `signTypedData` | Hash via `hashTypedData()` | Backend signs hash | ~125ms |
| `signTransaction` | Serialize via `serializeTransaction()` | Backend signs serialized tx | ~125ms |

### 3. Current x402 Implementation (PR #108)

PR #108 adds x402 payment capability with this architecture:

```
src/x402/
  ├── index.ts              ← Public API
  ├── client.ts             ← Core: privateKeyToAccount + x402 SDK wiring
  ├── config.ts             ← Env var loading (EVM_PRIVATE_KEY, limits)
  ├── spending-tracker.ts   ← In-memory 24hr spending limits
  └── cli.ts                ← Testing CLI
```

**The "yolo" part — wallet creation in `client.ts`:**
```typescript
const account = privateKeyToAccount(config.evmPrivateKey);  // Raw key from env
const publicClient = createPublicClient({ chain, transport: http() });
const signer = toClientEvmSigner(account, publicClient);    // x402 signer adapter
```

**Payment flow:**
1. Agent calls `paidFetch(url)` (wrapped `fetch`)
2. If server returns HTTP 402 with `PAYMENT-REQUIRED` header → x402 SDK intercepts
3. SDK constructs EIP-712 typed data for `TransferWithAuthorization` (EIP-3009)
4. `signer.signTypedData(...)` signs off-chain (gasless for the agent)
5. Signature sent in `PAYMENT-SIGNATURE` header on retry
6. Facilitator submits on-chain, moves USDC, returns content

**Required env vars:**
| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `EVM_PRIVATE_KEY` | Yes | — | Raw private key (0x-prefixed hex) |
| `X402_MAX_AUTO_APPROVE` | No | 1.00 | Max USD per request |
| `X402_DAILY_LIMIT` | No | 10.00 | Max USD per UTC day |
| `X402_NETWORK` | No | Base Sepolia | CAIP-2 network ID |

### 4. Can Openfort Replace the Current Signer?

**Yes.** The x402 SDK's `ClientEvmSigner` interface is minimal:

```typescript
interface ClientEvmSigner {
  address: `0x${string}`;
  signTypedData: (message: {
    domain: { ... };
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  }) => Promise<`0x${string}`>;
}
```

It does NOT require a `LocalAccount`, a private key, `signMessage`, or `signTransaction`. Any object with `address` + `signTypedData` works.

**Openfort adapter code (complete):**
```typescript
import Openfort from "@openfort/openfort-node";
import type { ClientEvmSigner } from "@x402/evm";

const openfort = new Openfort(process.env.OPENFORT_API_KEY!, {
  walletSecret: process.env.OPENFORT_WALLET_SECRET,
});

const account = await openfort.accounts.evm.backend.create();

const signer: ClientEvmSigner = {
  address: account.address,
  signTypedData: async (message) => {
    return account.signTypedData({
      domain: message.domain,
      types: message.types,
      primaryType: message.primaryType,
      message: message.message,
    });
  },
};
```

### 5. EIP-3009 Compatibility — Critical Analysis

EIP-3009 (`transferWithAuthorization`) requires:
1. An **EIP-712 typed data signature** — Openfort supports this via `signTypedData()`
2. A **standard ECDSA signature** verified by `ecrecover` on-chain — Openfort's backend wallets are EOAs that produce standard ECDSA signatures
3. The **signer's address must hold the USDC tokens** — must fund the EOA address from `account.address`

**Compatibility verdict: COMPATIBLE.** Openfort's backend wallet is an EOA that produces ECDSA signatures. The `signTypedData` method has the right interface. EIP-3009's `ecrecover` will accept the signature.

**One critical caveat:** Openfort also pairs accounts with ERC-4337 smart accounts. For x402, you MUST use the EOA address (from `account.address`) and fund USDC there — NOT any paired smart account address. Smart contract signatures (EIP-1271) are NOT compatible with EIP-3009.

### 6. What Changes Are Needed in `src/x402/`

The changes would be minimal if we adopt a provider-agnostic approach:

**Option A — Minimal (add Openfort as alternative signer):**
```
src/x402/
  ├── config.ts        ← Add OPENFORT_API_KEY, OPENFORT_WALLET_SECRET, X402_SIGNER_TYPE
  ├── client.ts        ← Add createOpenfortSigner() alongside existing createViemSigner()
  └── (rest unchanged)
```

Modify `client.ts` to select signer based on config:
```typescript
async function createSigner(config: X402Config): Promise<ClientEvmSigner> {
  if (config.signerType === 'openfort') {
    return createOpenfortSigner(config);
  }
  // Default: current raw key approach
  return createViemSigner(config);
}
```

**New env vars:**
| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `X402_SIGNER_TYPE` | No | `viem` | `viem` or `openfort` |
| `OPENFORT_API_KEY` | If openfort | — | Openfort API key (sk_test_/sk_live_) |
| `OPENFORT_WALLET_SECRET` | If openfort | — | Openfort wallet encryption secret |

**Estimated effort:** ~50-80 lines of new code in `client.ts`, ~20 lines in `config.ts`, tests.

**Option B — Openfort-only (replace viem signer entirely):**
Not recommended. This would make Openfort a hard dependency, add latency to all payments, and remove the simple local-key option for development.

### 7. Security Comparison

| Dimension | Current ("yolo") | Openfort |
|-----------|-----------------|----------|
| **Key storage** | Raw hex in `EVM_PRIVATE_KEY` env var | TEE-secured on Google Cloud, never exposed |
| **Key exposure risk** | Env var leak = full wallet compromise | API key leak = can create wallets but not access existing keys without wallet secret |
| **Key rotation** | Manual — change env var, update address | API call — rotate keys without changing address (with smart accounts) |
| **Blast radius of compromise** | Immediate full access to all funds | Requires both API key AND wallet secret; Openfort can freeze accounts |
| **Audit trail** | None — local signing is invisible | Full API audit log of every signing operation |
| **Compliance** | None | SOC2 Type II (claimed), audit logs |
| **Multi-agent isolation** | Same key shared across all agents | Each agent can have its own backend wallet with separate permissions |
| **Recovery** | Lose key = lose funds | 2-of-3 Shamir recovery via OpenSigner |

**The security upgrade is real but not transformational.** The biggest win is eliminating raw private keys from env vars — a genuine operational security improvement. The managed audit trail and per-agent wallet isolation are nice-to-haves. But the keys are still ultimately held by a third-party service (Openfort), so it shifts trust rather than eliminating it.

### 8. Limitations and Trade-offs

**Concerns:**

| Concern | Severity | Detail |
|---------|----------|--------|
| **Company risk** | High | 7 employees, $3M raised. Competitors (Privy, Dynamic, Web3Auth, Sequence) have all been acquired. Openfort's independence is uncertain. |
| **Low adoption** | High | 658 weekly npm downloads on Node SDK. 8 GitHub stars. Very few external users. |
| **Pre-1.0 SDK** | Medium | Version 0.6.74 — API surface may change without semver guarantees |
| **Signing latency** | Medium | ~125ms per API call vs <1ms local. Adds latency to every x402 payment. |
| **Cost** | Low | Free tier covers 2,000 ops/month. Growth at $99/mo covers 25,000. Unlikely to be a budget issue. |
| **Vendor lock-in** | Medium | Wallets are Openfort-managed — migrating away requires exporting keys or creating new wallets |
| **Package size** | Low | 3.21 MB (bundled OpenAPI specs). Bloated but functional. |
| **No 1.0 stability guarantee** | Medium | Breaking changes possible between 0.x versions |

**Mitigating factors:**
- OpenSigner is open-source and self-hostable — reduces lock-in risk
- The provider-agnostic signer approach (Option A) means we can swap Openfort out without changing the x402 flow
- Openfort is actively maintained (multiple commits per day as of Feb 2026)

### 9. Alternatives Considered

| Alternative | Pros | Cons |
|-------------|------|------|
| **Keep raw viem (current)** | Simplest, fastest, zero vendor dependency | Raw private key in env, no audit trail, "yolo" |
| **Openfort backend wallet** | Managed keys, audit trail, per-agent isolation | Vendor risk, latency, cost |
| **Coinbase CDP MPC wallet** | Backed by Coinbase (ecosystem alignment with x402) | More complex setup, heavier dependency |
| **Turnkey** | TEE-based (strong security), backed by Sequoia | Low-level primitives, harder to integrate, no free tier |
| **Fireblocks** | Enterprise-grade, 150+ chains | Expensive, overkill for our use case |
| **Vault + local signer** | Keep local signing but store key in HashiCorp Vault / AWS KMS | Same speed as current, better key management, no vendor lock-in | Key still decrypted in memory |

## Recommendation

### Short-term (PR #108): Ship as-is with the raw viem signer

The current implementation in PR #108 is functional and well-guarded (spending limits, safe config pattern, testnet default). For an MVP/initial release, it works. The "yolo" concern is about raw private keys in env vars — which is a standard practice for dev/test and acceptable for early production with small balances.

### Medium-term: Implement provider-agnostic signer abstraction

Add a `SignerProvider` interface to `src/x402/` that abstracts over the signing backend:

```typescript
interface SignerProvider {
  type: string;
  createSigner(): Promise<ClientEvmSigner>;
  getWalletAddress(): Promise<`0x${string}`>;
}
```

Implement two providers:
1. `ViemSignerProvider` — current approach (default)
2. `OpenfortSignerProvider` — opt-in via `X402_SIGNER_TYPE=openfort`

This keeps the simple path simple while allowing production deployments to upgrade to managed keys.

### Long-term: Evaluate based on Openfort's trajectory

Openfort is a small, early-stage startup in a consolidating market. Before making it a primary dependency:
- Monitor their adoption (npm downloads, GitHub activity)
- Watch for acquisition or shutdown signals
- Consider Coinbase CDP as the ecosystem-aligned alternative (same company behind x402)

## Code References

| File | Description |
|------|-------------|
| `src/x402/client.ts` (PR #108) | Core payment client — where the signer is created |
| `src/x402/config.ts` (PR #108) | Config loading — where new env vars would be added |
| `src/x402/spending-tracker.ts` (PR #108) | Spending limits — unchanged by signer swap |
| `@x402/evm` (npm) | `ClientEvmSigner` interface and `toClientEvmSigner` helper |
| `@openfort/openfort-node` (npm) | Openfort Node SDK with `accounts.evm.backend.create()` |

## Historical Context

- Previous x402 research: `/workspace/shared/thoughts/16990304-76e4-4017-b991-f3e37b34cf73/research/2026-02-28-x402-payments-protocol.md`
- x402 uses EIP-3009 (gasless USDC transfers via EIP-712 typed data signatures)
- The x402 SDK is intentionally wallet-agnostic — any object with `address` + `signTypedData` works

## Open Questions

- **Wallet persistence:** Does `openfort.accounts.evm.backend.create()` create a new wallet each time, or can you retrieve an existing one by ID? For agent-swarm, we need the same wallet address across restarts.
- **Coinbase CDP alternative:** Should we also evaluate Coinbase's own MPC wallet as a signer? It would be more ecosystem-aligned with x402.
- **Multi-agent wallets:** Should each agent have its own wallet (better isolation) or share one (simpler treasury management)?
- **Key export:** Openfort supports private key export — should we document this as an escape hatch?

## Sources

- [Openfort Homepage](https://www.openfort.io/)
- [Openfort Pricing](https://www.openfort.io/pricing)
- [Openfort Viem Integration Docs](https://www.openfort.io/docs/products/server/viem-integration)
- [Openfort Backend Wallets Blog](https://www.openfort.io/blog/backend-wallets)
- [Openfort Node SDK (GitHub)](https://github.com/openfort-xyz/openfort-node)
- [@openfort/openfort-node (npm)](https://www.npmjs.com/package/@openfort/openfort-node)
- [OpenSigner (GitHub)](https://github.com/openfort-xyz/opensigner)
- [PR #108 — desplega-ai/agent-swarm](https://github.com/desplega-ai/agent-swarm/pull/108)
- [x402 Protocol (GitHub)](https://github.com/coinbase/x402)
- [x402 EVM Exact Scheme Spec](https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md)
- [EIP-3009: Transfer With Authorization](https://eips.ethereum.org/EIPS/eip-3009)
- [EIP-712: Typed Structured Data Hashing](https://eips.ethereum.org/EIPS/eip-712)
- [x402 Coinbase Developer Docs](https://docs.cdp.coinbase.com/x402/welcome)
- [@x402/evm (npm)](https://www.npmjs.com/package/@x402/evm)
- [Openfort AI Agent Solutions](https://www.openfort.io/solutions/ai-agents)
- [Tiger Research: Openfort Report](https://reports.tiger-research.com/p/openfort-web3-game-eng)
