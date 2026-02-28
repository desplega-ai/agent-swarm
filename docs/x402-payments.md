# x402 Payments

The agent swarm includes built-in support for [x402](https://x402.org/) payments, allowing agents to automatically pay for x402-gated API endpoints using USDC on Base.

## How It Works

x402 is an open payment protocol that uses the HTTP 402 "Payment Required" status code for native micropayments over HTTP. When an agent calls an x402-gated API:

1. The initial request returns a `402 Payment Required` response
2. The x402 client automatically signs a USDC payment authorization
3. The request is retried with the payment signature
4. The API returns the response — payment is settled on-chain asynchronously

The entire flow is **gasless** for the payer (uses EIP-3009 `transferWithAuthorization`) and completes in ~1.5-2 seconds.

## Setup

### 1. Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `EVM_PRIVATE_KEY` | **Yes** | — | Wallet private key (0x-prefixed hex). Use a burner wallet with minimal funds. |
| `X402_MAX_AUTO_APPROVE` | No | `1.00` | Maximum USD amount to auto-approve per request |
| `X402_DAILY_LIMIT` | No | `10.00` | Daily spending limit in USD |
| `X402_FACILITATOR_URL` | No | `https://x402.org/facilitator` | Facilitator endpoint for payment verification |
| `X402_NETWORK` | No | `eip155:84532` | CAIP-2 network ID (Base Sepolia for testing, `eip155:8453` for mainnet) |

### 2. Wallet Setup

For development/testing:
1. Generate a new wallet (e.g., using MetaMask or `cast wallet new`)
2. Get test USDC from the [CDP Faucet](https://portal.cdp.coinbase.com/products/faucet) on Base Sepolia
3. Set `EVM_PRIVATE_KEY` to the wallet's private key
4. No ETH needed — x402 payments are gasless for the payer

For production:
- Use a dedicated burner wallet with minimal funds
- Consider Coinbase MPC wallets or Circle wallets for enhanced security
- Set appropriate spending limits via `X402_MAX_AUTO_APPROVE` and `X402_DAILY_LIMIT`

## Usage

### Simple: Drop-in fetch replacement

```typescript
import { createX402Fetch } from "@/x402";

const paidFetch = createX402Fetch();

// Use it like normal fetch — x402 payments are automatic
const response = await paidFetch("https://api.example.com/paid-endpoint");
const data = await response.json();
```

### Advanced: Full client with spending tracking

```typescript
import { createX402Client } from "@/x402";

const client = createX402Client();

// Make paid requests
const response = await client.fetch("https://api.example.com/paid-endpoint");

// Check spending
const summary = client.getSpendingSummary();
console.log(`Spent today: $${summary.todaySpent.toFixed(2)}`);
console.log(`Remaining: $${summary.dailyRemaining.toFixed(2)}`);
```

### Custom configuration

```typescript
import { createX402Client } from "@/x402";

const client = createX402Client({
  maxAutoApprove: 0.50,  // Max $0.50 per request
  dailyLimit: 5.00,      // Max $5.00 per day
  network: "eip155:8453", // Use Base mainnet
});
```

## CLI

Test x402 payments from the command line:

```bash
# Check configuration
bun src/x402/cli.ts check

# Make a paid request
bun src/x402/cli.ts fetch https://api.example.com/paid-endpoint

# View spending summary
bun src/x402/cli.ts status
```

## Spending Controls

The x402 module enforces two spending limits:

1. **Per-request limit** (`X402_MAX_AUTO_APPROVE`): Blocks any single payment exceeding this amount. Default: $1.00.
2. **Daily limit** (`X402_DAILY_LIMIT`): Blocks payments that would cause total daily spending to exceed this amount. Default: $10.00.

Spending is tracked in-memory and resets when the process restarts. For persistent tracking, use the swarm config system.

## Architecture

The module uses the x402 V2 SDK:

- `@x402/core` — Core client and HTTP utilities
- `@x402/evm` — EVM payment scheme (EIP-3009 transferWithAuthorization)
- `@x402/fetch` — Fetch wrapper for automatic 402 handling
- `viem` — Ethereum account/signing utilities

### Module Structure

```
src/x402/
├── index.ts              # Re-exports (public API)
├── client.ts             # Payment client with spending limits
├── config.ts             # Environment variable loading
├── spending-tracker.ts   # In-memory spending tracking
└── cli.ts                # CLI for testing payments
```

## Security

- **Use burner wallets**: Load only small amounts of working capital
- **Set spending limits**: Configure `X402_MAX_AUTO_APPROVE` and `X402_DAILY_LIMIT`
- **Never commit private keys**: Always use environment variables
- **Testnet first**: Use Base Sepolia (`eip155:84532`) during development

See [docs/research/x402-payments.md](research/x402-payments.md) for detailed security analysis.

## Further Reading

- [x402 Protocol Specification](https://github.com/coinbase/x402/blob/main/specs/x402-specification.md)
- [x402 Buyer Quickstart](https://docs.cdp.coinbase.com/x402/quickstart-for-buyers)
- [x402.org](https://www.x402.org/)
- [Research Document](research/x402-payments.md) — Full protocol analysis
