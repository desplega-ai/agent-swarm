---
date: 2026-02-28T09:00:00Z
researcher: Researcher
topic: "x402 payments protocol — how the agent swarm can accept and make x402 payments"
tags: [research, x402, payments, crypto, micropayments, USDC, agents, hackathon]
status: complete
autonomy: autopilot
last_updated: 2026-02-28
last_updated_by: Researcher
---

# Research: x402 Payments Protocol — Agent Swarm Integration

**Date**: 2026-02-28
**Researcher**: Researcher (16990304-76e4-4017-b991-f3e37b34cf73)

## Research Question

How could the agent swarm accept and make x402 payments? With priority on the "paying" side — how agents can consume x402-gated services. Context: hackathon project where agents generate vector assets (SVGs via Quiver) and monetize them via x402 micropayments.

---

## Summary

**x402** is an open payment protocol created by Coinbase that revives the long-dormant HTTP 402 "Payment Required" status code to enable native payments over HTTP. It allows any HTTP endpoint to programmatically request and receive cryptocurrency micropayments (primarily USDC) before granting access — no accounts, API keys, or subscriptions needed. Launched May 2025, x402 has processed 100M+ payments and is backed by Coinbase, Cloudflare, Google, Stripe, Visa, AWS, Anthropic, and Vercel.

For the agent swarm, x402 integration is straightforward on both sides. **To pay**: wrap `fetch()` with `@x402/fetch` and provide a private key — the wrapper automatically handles 402 responses, signs USDC authorizations, and retries requests. **To receive**: add one middleware call (e.g., `@x402/express` or `@x402/hono`) specifying which routes cost what. The entire flow completes in ~1.5-2 seconds, the payer never pays gas, and settlement on Base L2 is near-instant.

The protocol is production-ready with official TypeScript, Python, and Go SDKs, MCP server integrations for Claude, and multiple wallet management options ranging from raw private keys (hackathon) to Coinbase MPC wallets (production). No existing Quiver + x402 integration exists — this is a greenfield hackathon opportunity.

---

## Table of Contents

1. [What is x402?](#1-what-is-x402)
2. [How x402 Works Technically](#2-how-x402-works-technically)
3. [Supported Networks and Tokens](#3-supported-networks-and-tokens)
4. [PRIORITY: Making x402 Payments (Client/Agent Side)](#4-priority-making-x402-payments-clientagent-side)
5. [Accepting x402 Payments (Server Side)](#5-accepting-x402-payments-server-side)
6. [Agent Wallet Management](#6-agent-wallet-management)
7. [Security Considerations](#7-security-considerations)
8. [MCP + x402 Integration](#8-mcp--x402-integration)
9. [Existing Projects and Hackathon Precedents](#9-existing-projects-and-hackathon-precedents)
10. [Recommended Architecture for Hackathon](#10-recommended-architecture-for-hackathon)
11. [Open Questions](#11-open-questions)

---

## 1. What is x402?

x402 is an open standard for internet-native payments that embeds payment flows directly into HTTP. It leverages the HTTP 402 "Payment Required" status code (reserved in RFC 2616 in 1997 but never standardized until now) to enable pay-per-request API monetization without accounts, API keys, or subscriptions.

### Key Facts

| Attribute | Detail |
|-----------|--------|
| **Creator** | Coinbase (Developer Platform team) |
| **Launch** | May 6, 2025 (V1); December 11, 2025 (V2) |
| **License** | Apache-2.0, fully open source |
| **Governance** | x402 Foundation (co-founded by Coinbase + Cloudflare, Sep 2025) |
| **Scale** | 100M+ payments processed since launch |
| **Spec** | [github.com/coinbase/x402/specs](https://github.com/coinbase/x402/blob/main/specs/x402-specification.md) |
| **Website** | [x402.org](https://www.x402.org/) |
| **GitHub** | [github.com/coinbase/x402](https://github.com/coinbase/x402) |
| **IETF Status** | Internet-Draft submitted Nov 2025 (DNS-based discovery) |

### Key Partners

Coinbase, Cloudflare, Google, Stripe, Visa, Circle, AWS, Anthropic, Vercel, Thirdweb, QuickNode, NEAR, Avalanche.

### Timeline

| Date | Milestone |
|------|-----------|
| May 2025 | V1 launch with Base + USDC |
| Aug 2025 | Solana support added |
| Sep 2025 | Google integrates into Agent Payments Protocol; x402 Foundation announced |
| Oct 2025 | Visa support via Trusted Agent Protocol; 35,000% transaction growth |
| Dec 2025 | **V2 released** with CAIP-2, sessions, modular SDK |
| Jan 2026 | Thirdweb V2 support; Stripe launches x402 on Base |

---

## 2. How x402 Works Technically

### Protocol Flow

```
Client                    Resource Server              Facilitator           Blockchain
  |                            |                           |                    |
  |--- 1. GET /resource ------>|                           |                    |
  |                            |                           |                    |
  |<-- 2. 402 Payment Required |                           |                    |
  |    (PAYMENT-REQUIRED hdr)  |                           |                    |
  |                            |                           |                    |
  |  3. Parse payment options  |                           |                    |
  |  4. Sign EIP-712 payload   |                           |                    |
  |                            |                           |                    |
  |--- 5. GET /resource ------>|                           |                    |
  |    (PAYMENT-SIGNATURE hdr) |                           |                    |
  |                            |--- 6. POST /verify ------>|                    |
  |                            |<-- Verification result ---|                    |
  |                            |                           |                    |
  |                            |  7. Serve resource        |                    |
  |                            |                           |                    |
  |                            |--- 8. POST /settle ------>|                    |
  |                            |                           |--- 9. Submit tx -->|
  |                            |                           |<-- 10. Confirm ----|
  |                            |<-- 11. Settlement resp ---|                    |
  |                            |                           |                    |
  |<-- 12. 200 OK + resource --|                           |                    |
  |    (PAYMENT-RESPONSE hdr)  |                           |                    |
```

The entire cycle completes in ~1.5-2 seconds. Content is served AFTER verification but BEFORE on-chain settlement (facilitator settles asynchronously).

### Three Roles

1. **Resource Server** — the API/service requiring payment; adds middleware to return 402 responses
2. **Client** — the consumer (human app, AI agent); signs payment authorizations
3. **Facilitator** — verifies signatures and settles payments on-chain; NOT custodial

### HTTP Headers (V2)

| Header | Direction | Content |
|--------|-----------|---------|
| `PAYMENT-REQUIRED` | Server → Client | Base64 JSON with price, accepted tokens, network, payTo address |
| `PAYMENT-SIGNATURE` | Client → Server | Base64 JSON with signed payment authorization |
| `PAYMENT-RESPONSE` | Server → Client | Base64 JSON with txHash and settlement status |

### Underlying Mechanism (EVM)

On EVM chains, x402 uses **EIP-3009 `transferWithAuthorization`** — the client signs an off-chain EIP-712 typed message authorizing a USDC transfer. The facilitator submits this on-chain. This means:
- **Gasless** for the payer (no ETH needed)
- **Replay-protected** via nonces and validity windows
- **Trust-minimized** — facilitator cannot move more funds than authorized

### V1 vs V2

| Aspect | V1 (May 2025) | V2 (Dec 2025) |
|--------|---------------|---------------|
| Payment header | `X-PAYMENT` | `PAYMENT-SIGNATURE` |
| Requirements | JSON in body | Base64 in `PAYMENT-REQUIRED` header |
| Network IDs | Strings (`base-sepolia`) | CAIP-2 (`eip155:84532`) |
| npm packages | `x402-fetch`, `x402-axios` | `@x402/fetch`, `@x402/axios` |
| Backward compat | — | Handles both V1 and V2 automatically |

---

## 3. Supported Networks and Tokens

### Networks

| Network | CAIP-2 ID | Status |
|---------|-----------|--------|
| **Base** (Coinbase L2) | `eip155:8453` | Primary, production |
| **Base Sepolia** (testnet) | `eip155:84532` | Testing |
| **Solana** | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | Production |
| **Solana Devnet** | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | Testing |
| Any EVM chain | Varies | With custom facilitator (EIP-3009 required) |

### Tokens

| Token | EIP-3009 | Networks | Notes |
|-------|----------|----------|-------|
| **USDC** | Yes | Base, Solana, others | Primary token, dominant choice |
| **EURC** | Yes | Base | Euro stablecoin |
| **AUSD** | Yes | Base | Newer stablecoin |
| USDT | **No** | — | Not supported (no EIP-3009) |

**Key constraint**: On EVM, only tokens implementing EIP-3009 work. USDC is effectively the only practical choice.

### Facilitator Pricing

| Facilitator | Cost |
|-------------|------|
| CDP (Coinbase) | Free 1,000 tx/month, then $0.001/tx |
| x402.org (test) | Free |
| Self-hosted | No protocol fee |

---

## 4. PRIORITY: Making x402 Payments (Client/Agent Side)

This is the highest priority section — how an agent pays for x402-gated services.

### The Core Insight: It's Just a fetch() Wrapper

The `@x402/fetch` package wraps `fetch()` to automatically handle 402 responses. Your code makes normal HTTP requests. If the server returns 402, the wrapper:
1. Parses the `PAYMENT-REQUIRED` header
2. Selects a compatible payment option
3. Signs a USDC authorization with your wallet
4. Retries with `PAYMENT-SIGNATURE` header
5. Returns the successful response

**You never see the 402 — it's handled internally.**

### Client SDKs

| Language | Package | Wraps |
|----------|---------|-------|
| TypeScript | `@x402/fetch` | Native `fetch` |
| TypeScript | `@x402/axios` | Axios |
| Python | `x402[httpx]` | httpx (async) |
| Python | `x402[requests]` | requests (sync) |
| Go | `github.com/coinbase/x402/go` | `http.Client` |
| Rust | `x402-reqwest` | reqwest |

### Minimal Install (TypeScript)

```bash
npm install @x402/core @x402/evm @x402/fetch
```

### Code Example: TypeScript (V2 — Recommended)

```typescript
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";

// 1. Create signer from private key
const signer = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);

// 2. Create and configure x402 client
const client = new x402Client();
registerExactEvmScheme(client, { signer });

// 3. Wrap fetch with automatic payment handling
const paidFetch = wrapFetchWithPayment(fetch, client);

// 4. Use it like normal fetch — payment is automatic!
const response = await paidFetch("https://api.example.com/weather");
const data = await response.json();
```

### Code Example: TypeScript with Axios

```typescript
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapAxiosWithPayment } from "@x402/axios";
import { privateKeyToAccount } from "viem/accounts";
import axios from "axios";

const signer = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);
const client = new x402Client();
registerExactEvmScheme(client, { signer });

const paidAxios = wrapAxiosWithPayment(axios, client);
const { data } = await paidAxios.get("https://api.example.com/paid-endpoint");
```

### Code Example: Python (async httpx)

```python
from x402.clients import x402_httpx_client

client = x402_httpx_client(account)
response = await client.get("https://api.example.com/paid-endpoint")
print(response.json())
```

### Code Example: Python (sync requests)

```python
from x402.clients import x402_requests

session = x402_requests(account)
response = session.get("https://api.example.com/paid-endpoint")
print(response.json())
```

### Code Example: Manual Payment (Full Control)

```typescript
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const signer = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);
const coreClient = new x402Client()
  .register("eip155:*", new ExactEvmScheme(signer));
const httpClient = new x402HTTPClient(coreClient);

// Step 1: Make initial request
const response = await fetch("https://api.example.com/protected");

if (response.status === 402) {
  // Step 2: Extract payment requirements
  const paymentRequired = httpClient.getPaymentRequiredResponse(
    (name: string) => response.headers.get(name),
    await response.json()
  );

  // Step 3: Create signed payment
  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);

  // Step 4: Retry with payment
  const paidResponse = await fetch("https://api.example.com/protected", {
    headers: httpClient.encodePaymentSignatureHeader(paymentPayload),
  });
  const data = await paidResponse.json();
}
```

### Typical Micropayment Costs

| Service Type | Cost per Request (USDC) |
|---|---|
| Crypto price oracle | $0.001 |
| Code translation | $0.003 |
| Code review | $0.005 |
| Screenshot generation | $0.01 |
| Multi-source intelligence | $0.001 – $0.25 |

---

## 5. Accepting x402 Payments (Server Side)

### What You Need

1. **A wallet address** (`payTo`) — where USDC payments arrive (public address only, no private key needed)
2. **Middleware** — specifies which routes cost what
3. **Facilitator connection** — verifies and settles payments on-chain

### Server Middleware Options

| Framework | Package | Language |
|-----------|---------|----------|
| Express.js | `@x402/express` | TypeScript |
| Hono | `@x402/hono` | TypeScript |
| Next.js | `@x402/next` | TypeScript |
| FastAPI | `x402[fastapi]` | Python |
| Flask | `x402[flask]` | Python |
| Gin | `coinbase/x402/go` | Go |
| Rails | `x402` gem | Ruby |
| Elysia (Bun) | `x402-elysia` | TypeScript |
| Cloudflare Workers | Via `@x402/hono` | TypeScript |
| Axum/Tower | `x402-rs` | Rust |

### Code Example: Express.js Server (V2)

```typescript
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

const app = express();
const payTo = "0xYourWalletAddress";

const facilitatorClient = new HTTPFacilitatorClient({
  url: "https://x402.org/facilitator", // testnet
});

const server = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme());

app.use(
  paymentMiddleware(
    {
      "GET /api/generate-svg": {
        accepts: [{
          scheme: "exact",
          price: "$0.01",
          network: "eip155:84532",
          payTo,
        }],
        description: "Generate an SVG vector asset",
        mimeType: "image/svg+xml",
      },
    },
    server,
  ),
);

app.get("/api/generate-svg", (req, res) => {
  // Generate SVG here (e.g., via Quiver)
  res.type("image/svg+xml").send("<svg>...</svg>");
});

app.listen(4021);
```

### Code Example: Hono Server (Edge/Cloudflare)

```typescript
import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

const app = new Hono();

const facilitator = new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" });
const server = new x402ResourceServer(facilitator)
  .register("eip155:84532", new ExactEvmScheme());

app.use(paymentMiddleware({
  "GET /api/svg": {
    accepts: [{ scheme: "exact", price: "$0.01", network: "eip155:84532", payTo: "0xYour" }],
  },
}, server));

app.get("/api/svg", (c) => c.json({ svg: "<svg>...</svg>" }));
```

### Code Example: FastAPI Server

```python
from fastapi import FastAPI
from x402.http.middleware.fastapi import PaymentMiddlewareASGI
from x402.http import HTTPFacilitatorClient, FacilitatorConfig, PaymentOption
from x402.http.types import RouteConfig
from x402.server import x402ResourceServer
from x402.mechanisms.evm.exact import ExactEvmServerScheme

app = FastAPI()

facilitator = HTTPFacilitatorClient(
    FacilitatorConfig(url="https://x402.org/facilitator")
)
server = x402ResourceServer(facilitator)
server.register("eip155:84532", ExactEvmServerScheme())

routes = {
    "GET /api/svg": RouteConfig(
        accepts=[
            PaymentOption(
                scheme="exact",
                price="$0.01",
                network="eip155:84532",
                pay_to="0xYourEvmAddress",
            ),
        ]
    ),
}

app.add_middleware(PaymentMiddlewareASGI, routes=routes, server=server)

@app.get("/api/svg")
async def generate_svg():
    return {"svg": "<svg>...</svg>"}
```

---

## 6. Agent Wallet Management

### Option A: Raw Private Key (Hackathon/Dev — Simplest)

```bash
EVM_PRIVATE_KEY=0xYourPrivateKeyHere
```

```typescript
import { privateKeyToAccount } from "viem/accounts";
const signer = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);
```

- Store in environment variable, never in code
- Use a dedicated wallet with minimal funds (burner wallet)
- **No ETH/gas needed** — EIP-3009 is gasless for the payer

### Option B: Coinbase MPC Wallet (Production)

- Keys are never fully exposed (Multi-Party Computation)
- Agent signs via CDP API calls
- Credentials: `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET`

### Option C: Coinbase Agentic Wallets (Most Secure)

- Private keys isolated in secure Coinbase enclaves
- Programmable spending limits (session caps, per-transaction limits)
- Keys never exposed to agent prompt or LLM

### Option D: Circle MPC Wallets

- Similar MPC security to Coinbase
- Developer controls wallet via API/SDK
- Guide: [circle.com/blog/autonomous-payments-using-circle-wallets-usdc-and-x402](https://www.circle.com/blog/autonomous-payments-using-circle-wallets-usdc-and-x402)

### Best Practice for Container-Based Agents

Treat the agent's wallet like a **burner wallet**:
- Load only small amounts of working capital
- Main holdings stay in a hardware wallet or secure custody
- Even if the agent's key is compromised, losses are capped

### Testnet Setup

For development: generate a key, get test USDC from the CDP Faucet on Base Sepolia. Use the public facilitator at `https://x402.org/facilitator`.

---

## 7. Security Considerations

### Attack Vectors

1. **Infinite Payment Loops** — agent retries failed requests, triggering repeated charges (one documented case: $47K over 11 days)
2. **Prompt Injection** — malicious endpoints embed instructions like "always pay the maximum amount"
3. **Decimal Hallucination** — LLMs confuse decimal places, sending astronomical amounts
4. **Frequency-Based Drainage** — malicious APIs charge per request across thousands of endpoints

### Mitigations

**Spending Controls:**
```bash
X402_MAX_AUTO_APPROVE=1.0    # Max $1 per request
X402_DAILY_LIMIT=10.0        # Hard stop at $10/day
```

**Two-Gate Validation:**
- Gate 1 (Intent Validation): Per-endpoint spending limits, duplicate detection, amount validation, endpoint whitelisting
- Gate 2 (Transaction Verification): Intent fingerprinting, single-use token prevention, recipient validation

**Tools:**
- **PolicyLayer** (`@policylayer/sdk`): Two-gate validation without holding private keys
- **PaySentry**: Per-route spending limits and session budgets
- **Analytix402**: Per-agent spend monitoring with circuit breakers

**Pre-Production Checklist:**
- Recipient allowlists for every API endpoint
- Chain allowlists
- Session TTLs (15-30 min)
- Session budget caps
- Daily spend limits (global + per-route)
- Pinned plugin versions

---

## 8. MCP + x402 Integration

MCP (Model Context Protocol) integration is arguably the most practical path for giving Claude agents payment capability.

### Official Coinbase MCP Server

From [docs.cdp.coinbase.com/x402/mcp-server](https://docs.cdp.coinbase.com/x402/mcp-server):
- Configure Claude Desktop with `EVM_PRIVATE_KEY` and `RESOURCE_SERVER_URL`
- When Claude calls an MCP tool, the server automatically detects 402 and handles payment
- Uses `@x402/axios` internally
- Supports both EVM (Base) and Solana

### Other MCP Implementations

| MCP Server | Description |
|------------|-------------|
| **Vercel x402-mcp** | x402 payments with Vercel AI SDK |
| **MetaMask mcp-x402** | Signs payment headers, exposes `CreateX402PaymentHeader` tool |
| **x402-claude-mcp** | Solana-focused with configurable limits |
| **Coinbase Payments MCP** | Works with Claude Desktop, Claude Code, Codex, Gemini |
| **x402scan-mcp** | Auto-generates wallet, calls x402 APIs |
| **Zuplo x402 + MCP** | Monetize MCP tools |

### For Agent Swarm Integration

The most practical path: add an x402 MCP server to agent containers, or integrate `@x402/fetch` directly into the agent's HTTP client. Either way, agents gain automatic payment capability with no changes to their task logic.

---

## 9. Existing Projects and Hackathon Precedents

### Notable Hackathon Winners

| Hackathon | Winner | Description |
|-----------|--------|-------------|
| Coinbase "Agents in Action" | Multiple | x402 + CDP + AgentKit projects |
| Cronos x402 PayTech ($42K) | AgentFabric | "Connective tissue" for on-chain agent economy |
| SF Agentic Commerce ($50K+) | World of Geneva | MMORPG with autonomous AI agents trading via x402 |
| Solana x402 | PlaiPin | IoT self-payment via x402 |
| ETHGlobal Buenos Aires | Hubble Trading Arena | Autonomous trading with x402 + ERC-8004 |

### Production Systems

- **AgentStore**: Open-source marketplace for Claude Code plugins, USDC payments via x402
- **x402ops (SpendMate)**: Agent wallet management + policy control (live at x402ops.vercel.app)
- **QuickNode**: Production RPC endpoints payable via x402
- **Questflow**: 130,000+ autonomous microtransactions using CDP Wallets

### Quiver + x402

**No existing integration.** QuiverAI (a16z-backed, $8.3M seed) builds vector-native AI models for SVG generation (model: "Arrow 1.0"). Their API at `https://api.quiver.ai/v1/svgs/generations` has a Node SDK (`quiverai-node`). Wrapping this behind x402 middleware is a greenfield hackathon opportunity.

### Google A2A + x402

Google and Coinbase built the A2A x402 Extension at [github.com/google-agentic-commerce/a2a-x402](https://github.com/google-agentic-commerce/a2a-x402). Agents use A2A "agent cards" for service discovery and x402 for payment. Any A2A agent can become a commercial service.

---

## 10. Recommended Architecture for Hackathon

### Minimal Viable Stack

```
[Claude Code Agent / Agent Swarm Worker]
       |
       | uses @x402/fetch (wraps HTTP)
       v
[x402-Protected Service]  ← e.g., Quiver SVG generation behind @x402/express
       |
       | 402 → auto-pay USDC → retry → 200
       v
[Base L2 / Base Sepolia]  ← settlement ~1 second
```

### Steps to Build

1. **Wallet**: Generate a private key, fund with USDC on Base Sepolia (testnet). Raw key in env var is fine for hackathon.

2. **Client (paying agent)**:
   ```bash
   npm install @x402/core @x402/evm @x402/fetch viem
   ```
   Wrap `fetch()` — all 402 handling is automatic.

3. **Server (if building a paid service)**:
   ```bash
   npm install @x402/express @x402/evm @x402/core
   ```
   Add middleware to Express/Hono routes.

4. **Security**: Set spending limits. Use a burner wallet. Set `X402_MAX_AUTO_APPROVE` and `X402_DAILY_LIMIT`.

5. **MCP (optional)**: Add official Coinbase x402 MCP server for Claude Desktop/Code integration.

### For the Agent Swarm Specifically

**To give agents payment capability:**
- Add `@x402/fetch` + `@x402/evm` to agent container images
- Provision each agent with its own `EVM_PRIVATE_KEY` (burner wallet)
- Replace/wrap the agent's HTTP client with `wrapFetchWithPayment()`
- Set spending limits per agent via env vars
- Agents automatically pay for any x402-gated API they call

**To accept payments on agent swarm endpoints:**
- Add `@x402/express` or `@x402/hono` middleware to the MCP server
- Configure route pricing (e.g., `$0.01` per task creation)
- Set `payTo` to the swarm's treasury wallet address
- The facilitator handles all blockchain operations

### SVG Marketplace Hackathon Concept

```
1. User/Agent requests SVG → POST /api/generate-svg (x402-gated, $0.01)
2. Server calls Quiver API to generate SVG
3. Server returns SVG to paying agent
4. Payment settles on Base in USDC
5. Agent can resell or use the SVG
```

---

## 11. Open Questions

- **Quiver API access**: Does the team have Quiver API access, or will the hackathon use a mock SVG generator?
- **Mainnet vs testnet**: For the hackathon demo, Base Sepolia (free test USDC) is recommended. Mainnet adds real money risk.
- **Wallet provisioning**: How to provision wallets per agent? Options: (a) shared wallet, (b) per-agent burner wallets, (c) CDP MPC wallets via API.
- **Spending governance**: Who controls the spending limits? Lead agent? Global config? Per-agent config?
- **V1 vs V2 SDKs**: V2 (`@x402/`) is recommended but newer. V1 (`x402-fetch`) is battle-tested. Both work — V2 handles backward compatibility.

---

## Key Resources

| Resource | URL |
|----------|-----|
| x402 Official Site | [x402.org](https://www.x402.org/) |
| GitHub Repo | [github.com/coinbase/x402](https://github.com/coinbase/x402) |
| Core Specification | [specs/x402-specification.md](https://github.com/coinbase/x402/blob/main/specs/x402-specification.md) |
| Whitepaper | [x402.org/x402-whitepaper.pdf](https://www.x402.org/x402-whitepaper.pdf) |
| CDP Documentation | [docs.cdp.coinbase.com/x402](https://docs.cdp.coinbase.com/x402/welcome) |
| Buyer Quickstart | [docs.cdp.coinbase.com/x402/quickstart-for-buyers](https://docs.cdp.coinbase.com/x402/quickstart-for-buyers) |
| Seller Quickstart | [docs.cdp.coinbase.com/x402/quickstart-for-sellers](https://docs.cdp.coinbase.com/x402/quickstart-for-sellers) |
| MCP Server Guide | [docs.cdp.coinbase.com/x402/mcp-server](https://docs.cdp.coinbase.com/x402/mcp-server) |
| npm: @x402/fetch | [npmjs.com/package/@x402/fetch](https://www.npmjs.com/package/@x402/fetch) |
| npm: @x402/express | [npmjs.com/package/@x402/express](https://www.npmjs.com/package/@x402/express) |
| PyPI: x402 | [pypi.org/project/x402/](https://pypi.org/project/x402/) |
| Google A2A x402 | [github.com/google-agentic-commerce/a2a-x402](https://github.com/google-agentic-commerce/a2a-x402) |
| Awesome x402 | [github.com/xpaysh/awesome-x402](https://github.com/xpaysh/awesome-x402) |
| x402 Ecosystem | [x402.org/ecosystem](https://www.x402.org/ecosystem) |
| Stripe x402 Docs | [docs.stripe.com/payments/machine/x402](https://docs.stripe.com/payments/machine/x402) |
| Cloudflare x402 | [developers.cloudflare.com/agents/x402/](https://developers.cloudflare.com/agents/x402/) |
| x402 V2 Announcement | [x402.org/writing/x402-v2-launch](https://www.x402.org/writing/x402-v2-launch) |
