/**
 * x402 Payment Module
 *
 * Gives agents the ability to make x402 payments when calling external APIs.
 * Uses USDC on Base (or Base Sepolia for testing) with automatic 402 handling.
 *
 * Supports two signer backends:
 *   - Openfort (default) — managed backend wallet, keys in TEE
 *   - viem (fallback) — raw EVM_PRIVATE_KEY for local signing
 *
 * @example
 * ```typescript
 * import { createX402Fetch, createX402Client } from "@/x402";
 *
 * // Simple: just get a paid fetch
 * const paidFetch = await createX402Fetch();
 * const response = await paidFetch("https://api.example.com/paid-endpoint");
 *
 * // Advanced: full client with spending tracking
 * const client = await createX402Client();
 * const response = await client.fetch("https://api.example.com/paid-endpoint");
 * console.log(client.getSpendingSummary());
 * ```
 */

export {
  createX402Client,
  createX402Fetch,
  type X402PaymentClient,
} from "./client.ts";
export { loadX402Config, type SignerType, type X402Config, type X402SafeConfig } from "./config.ts";
export {
  type ClientEvmSigner,
  createOpenfortSigner,
  type OpenfortSignerConfig,
} from "./openfort-signer.ts";
export { type SpendingRecord, SpendingTracker } from "./spending-tracker.ts";
