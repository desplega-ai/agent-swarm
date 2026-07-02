# x402 Payment Module

> **Alpha / Opt-in** — This module is experimental and not wired into any core swarm path. Import it explicitly if you need x402 payment support.

Gives agents the ability to make [x402](https://github.com/coinbase/x402) payments when calling external APIs that return HTTP 402 responses. Uses USDC on Base (or Base Sepolia for testing) with automatic payment handling.

## Status

This module is **not imported by any core swarm code**. It is an opt-in integration — include it only when you need automatic micropayment support in an agent task.

Knip and other dead-code scanners will flag this directory as unused because there are no production-code imports; that is expected.

## Signer backends

| Backend | When to use | Required env vars |
|---------|-------------|-------------------|
| Openfort (default) | Managed wallet, keys in TEE | `OPENFORT_API_KEY`, `OPENFORT_WALLET_SECRET` |
| viem | Raw EVM private key (local/dev) | `EVM_PRIVATE_KEY` |

## Opt-in usage

```typescript
import { createX402Fetch, createX402Client } from "@/x402";

// Simple: drop-in replacement for fetch
const paidFetch = await createX402Fetch();
const response = await paidFetch("https://api.example.com/paid-endpoint");

// Advanced: full client with spending tracking
const client = await createX402Client();
const response = await client.fetch("https://api.example.com/paid-endpoint");
console.log(client.getSpendingSummary());
```

## Env vars

| Variable | Required | Description |
|----------|----------|-------------|
| `X402_SIGNER_TYPE` | No | `openfort` (default) or `viem` |
| `X402_NETWORK` | No | `eip155:8453` (Base mainnet, default) or `eip155:84532` (Base Sepolia) |
| `X402_MAX_AUTO_APPROVE_USD` | No | Per-request auto-approve ceiling in USD |
| `X402_DAILY_LIMIT_USD` | No | Daily spending cap in USD |
| `OPENFORT_API_KEY` | Openfort only | Openfort API key |
| `OPENFORT_WALLET_SECRET` | Openfort only | Openfort wallet secret |
| `OPENFORT_WALLET_ADDRESS` | No | Pre-existing wallet address (optional) |
| `EVM_PRIVATE_KEY` | viem only | Raw 32-byte hex private key |

## Architecture

```
src/x402/
  index.ts            # Public exports
  client.ts           # X402PaymentClient — wraps fetch with payment handling
  config.ts           # Env-var loader and config types
  openfort-signer.ts  # Openfort managed-wallet signer adapter
  spending-tracker.ts # Per-request and daily spending limits
  cli.ts              # CLI helper for inspecting wallet / config
```

## Dependencies

`@x402/core`, `@x402/evm`, `@x402/fetch`, `viem`, `@openfort/openfort-node` are intentionally kept in `package.json` — they belong to this opt-in module.

## References

- [x402 protocol](https://github.com/coinbase/x402)
- [Openfort docs](https://openfort.xyz/docs)
