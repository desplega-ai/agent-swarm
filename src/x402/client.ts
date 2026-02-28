/**
 * x402 Payment Client
 *
 * A reusable payment client that wraps fetch() with automatic x402 payment handling
 * and configurable spending limits.
 *
 * Usage:
 *   import { createX402Fetch, createX402Client } from "@/x402";
 *
 *   // Quick: get a paid fetch function
 *   const paidFetch = createX402Fetch();
 *   const response = await paidFetch("https://api.example.com/paid-endpoint");
 *
 *   // Advanced: get the full client with spending info
 *   const client = createX402Client();
 *   const response = await client.fetch("https://api.example.com/paid-endpoint");
 *   console.log(client.getSpendingSummary());
 */

import { x402Client } from "@x402/core/client";
import { toClientEvmSigner } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { loadX402Config, type X402Config, type X402SafeConfig } from "./config.ts";
import { SpendingTracker } from "./spending-tracker.ts";

export interface X402PaymentClient {
  /** A fetch function that automatically handles x402 402 responses */
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** The underlying x402Client instance */
  x402Client: x402Client;
  /** The spending tracker for monitoring limits */
  spendingTracker: SpendingTracker;
  /** Get a summary of today's spending */
  getSpendingSummary: () => ReturnType<SpendingTracker["getSummary"]>;
  /** The wallet address derived from the private key */
  walletAddress: `0x${string}`;
  /** Safe config subset (no private key) */
  config: X402SafeConfig;
}

/**
 * Map CAIP-2 network ID to viem chain config.
 */
function getChainForNetwork(network: string) {
  if (network === "eip155:8453") return base;
  return baseSepolia; // Default to testnet
}

/**
 * Create a full x402 payment client with spending controls.
 *
 * @param configOverrides - Optional config overrides (otherwise loaded from env vars)
 * @returns An X402PaymentClient with fetch, spending tracker, and config
 */
export function createX402Client(configOverrides?: Partial<X402Config>): X402PaymentClient {
  const envConfig = loadX402Config();
  const config = { ...envConfig, ...configOverrides };

  // Create account from private key
  const account = privateKeyToAccount(config.evmPrivateKey);

  // Create a public client for readContract capability
  const chain = getChainForNetwork(config.network);
  const publicClient = createPublicClient({
    chain,
    transport: http(),
  });

  // Compose a ClientEvmSigner with readContract support
  const signer = toClientEvmSigner(account, publicClient);

  // Create and configure x402 client
  const client = new x402Client();
  registerExactEvmScheme(client, { signer });

  // Create spending tracker
  const spendingTracker = new SpendingTracker(config.maxAutoApprove, config.dailyLimit);

  // Register a spending-limit hook that blocks over-budget payments.
  // NOTE: This check has a TOCTOU race — concurrent requests could both pass the
  // limit check before either records its payment. Acceptable for agent workloads
  // (typically sequential), but not suitable for high-concurrency scenarios.
  client.onBeforePaymentCreation(async (context) => {
    const { selectedRequirements } = context;

    // V2 PaymentRequirements uses `amount` (smallest unit, e.g. "10000" for $0.01 USDC)
    const rawValue = selectedRequirements.amount;
    const amountUsd = usdcToUsd(rawValue);

    const url = context.paymentRequired.resource?.url || "unknown";
    const blockReason = spendingTracker.checkSpendingLimit(amountUsd, url);

    if (blockReason) {
      return { abort: true, reason: blockReason };
    }
  });

  // Track successful payments
  client.onAfterPaymentCreation(async (context) => {
    const rawValue = context.selectedRequirements.amount;
    const amountUsd = usdcToUsd(rawValue);
    const url = context.paymentRequired.resource?.url || "unknown";
    spendingTracker.recordPayment(amountUsd, url);
  });

  // Wrap fetch with payment handling
  const paidFetch = wrapFetchWithPayment(globalThis.fetch, client);

  // Expose a safe config subset — never leak the private key
  const { evmPrivateKey: _key, ...safeConfig } = config;

  return {
    fetch: paidFetch as (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
    x402Client: client,
    spendingTracker,
    getSpendingSummary: () => spendingTracker.getSummary(),
    walletAddress: account.address,
    config: safeConfig,
  };
}

/**
 * Create a simple paid fetch function.
 * This is the easiest way to get started — just replace `fetch` with this.
 *
 * @param configOverrides - Optional config overrides
 * @returns A fetch function that automatically handles x402 payments
 */
export function createX402Fetch(
  configOverrides?: Partial<X402Config>,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return createX402Client(configOverrides).fetch;
}

/**
 * Convert USDC raw value (6 decimals) to USD.
 * USDC uses 6 decimal places, so 1000000 = $1.00
 */
function usdcToUsd(rawValue: string): number {
  try {
    return Number(BigInt(rawValue)) / 1_000_000;
  } catch {
    // If the value can't be parsed as BigInt, fall back to parseFloat
    const parsed = Number.parseFloat(rawValue);
    if (Number.isNaN(parsed)) return 0;
    return parsed / 1_000_000;
  }
}
