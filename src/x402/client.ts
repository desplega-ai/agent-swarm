/**
 * x402 Payment Client
 *
 * A reusable payment client that wraps fetch() with automatic x402 payment handling
 * and configurable spending limits.
 *
 * Supports two signer backends:
 *   - Openfort (default) — managed backend wallet, no raw keys in env
 *   - viem — raw EVM_PRIVATE_KEY for local signing
 *
 * Usage:
 *   import { createX402Fetch, createX402Client } from "@/x402";
 *
 *   // Quick: get a paid fetch function
 *   const paidFetch = await createX402Fetch();
 *   const response = await paidFetch("https://api.example.com/paid-endpoint");
 *
 *   // Advanced: get the full client with spending info
 *   const client = await createX402Client();
 *   const response = await client.fetch("https://api.example.com/paid-endpoint");
 *   console.log(client.getSpendingSummary());
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { x402Client } from "@x402/core/client";
import type { ClientEvmSigner } from "@x402/evm";
import { toClientEvmSigner } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { loadX402Config, type X402Config, type X402SafeConfig } from "./config.ts";
import { createOpenfortSigner } from "./openfort-signer.ts";
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
  /** The wallet address used for payments */
  walletAddress: `0x${string}`;
  /** Safe config subset (no secrets) */
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
 * Create a signer based on the config's signerType.
 */
async function buildSigner(
  config: X402Config,
): Promise<{ signer: ClientEvmSigner; walletAddress: `0x${string}` }> {
  if (config.signerType === "openfort") {
    if (!config.openfortApiKey || !config.openfortWalletSecret) {
      throw new Error("Openfort signer requires OPENFORT_API_KEY and OPENFORT_WALLET_SECRET.");
    }

    const chain = getChainForNetwork(config.network);
    const signer = await createOpenfortSigner({
      apiKey: config.openfortApiKey,
      walletSecret: config.openfortWalletSecret,
      walletAddress: config.openfortWalletAddress,
      chain,
    });

    return { signer, walletAddress: signer.address };
  }

  // viem signer (raw private key)
  if (!config.evmPrivateKey) {
    throw new Error("Viem signer requires EVM_PRIVATE_KEY.");
  }

  const account = privateKeyToAccount(config.evmPrivateKey);
  const chain = getChainForNetwork(config.network);
  const publicClient = createPublicClient({ chain, transport: http() });
  const signer = toClientEvmSigner(account, publicClient);

  return { signer, walletAddress: account.address };
}

/**
 * Create a full x402 payment client with spending controls.
 *
 * NOTE: This is async because Openfort signer requires API calls to create/retrieve wallets.
 *
 * @param configOverrides - Optional config overrides (otherwise loaded from env vars)
 * @returns An X402PaymentClient with fetch, spending tracker, and config
 */
export async function createX402Client(
  configOverrides?: Partial<X402Config>,
): Promise<X402PaymentClient> {
  const envConfig = loadX402Config();
  const config = { ...envConfig, ...configOverrides };

  // Build the signer (async for Openfort, instant for viem)
  const { signer, walletAddress } = await buildSigner(config);

  // Create and configure x402 client
  const client = new x402Client();
  // @x402/core >= 2.31 caps each payment at $1 by default. SpendingTracker below
  // already enforces maxAutoApprove and the daily limit, so drop only the USD cap
  // and keep the core's default-asset allowlist.
  client.setSpendControls({ maxAmountPerPayment: false });
  registerExactEvmScheme(client, { signer });

  // Create spending tracker
  const spendingTracker = new SpendingTracker(config.maxAutoApprove, config.dailyLimit);

  // Spending limits: reserve before the payment is created, then confirm it once
  // created or release it if creation fails. `reserve()` checks the limits and
  // holds the amount synchronously, so concurrent payments in this process can't
  // all pass the daily check against the same remaining budget.
  // NOTE: totals are still in memory, so they reset on restart and are not shared
  // across processes.
  //
  // Each createPaymentPayload() call gets its own reservation slot. Settling the
  // reservation around the whole call (rather than in the after/failure hooks)
  // means a later before-hook that aborts or throws still releases it, and one
  // call can never confirm or release another concurrent call's reservation.
  const invocation = new AsyncLocalStorage<{ reservationId?: string }>();

  client.onBeforePaymentCreation(async (context) => {
    // The hook is typed for v2, but x402 v1 requirements reach it too: v1 names the
    // price `maxAmountRequired` (v2: `amount`) and carries `resource` as a URL string.
    // Pick the field by protocol version: a v1 scheme signs `maxAmountRequired` and
    // ignores any `amount` sent alongside it, so a fallback chain is bypassable.
    const version = context.paymentRequired.x402Version;
    const requirements = context.selectedRequirements as {
      amount?: unknown;
      maxAmountRequired?: unknown;
      resource?: unknown;
    };
    const url =
      context.paymentRequired.resource?.url ||
      (typeof requirements.resource === "string" ? requirements.resource : "") ||
      "unknown";

    const rawAmount =
      version === 1
        ? requirements.maxAmountRequired
        : version === 2
          ? requirements.amount
          : undefined;
    const amountUsd = usdcToUsd(rawAmount);
    if (amountUsd === null) {
      return {
        abort: true,
        reason: `Payment requirements (x402 v${version}) carry no parseable amount, refusing to pay. URL: ${url}`,
      };
    }

    const result = spendingTracker.reserve(amountUsd, url);

    if (!result.ok) {
      return { abort: true, reason: result.reason };
    }
    const slot = invocation.getStore();
    if (slot) {
      slot.reservationId = result.id;
    } else {
      // Not reached through createPaymentPayload below; count it rather than leak a hold
      spendingTracker.confirm(result.id);
    }
  });

  const createPaymentPayload = client.createPaymentPayload.bind(client);
  client.createPaymentPayload = async (paymentRequired) => {
    const slot: { reservationId?: string } = {};
    try {
      const payload = await invocation.run(slot, () => createPaymentPayload(paymentRequired));
      if (slot.reservationId !== undefined) spendingTracker.confirm(slot.reservationId);
      return payload;
    } catch (error) {
      if (slot.reservationId !== undefined) spendingTracker.release(slot.reservationId);
      throw error;
    }
  };

  // Wrap fetch with payment handling
  const paidFetch = wrapFetchWithPayment(globalThis.fetch, client);

  // Expose a safe config subset — never leak secrets
  const {
    evmPrivateKey: _key,
    openfortApiKey: _apiKey,
    openfortWalletSecret: _secret,
    ...safeConfig
  } = config;

  return {
    fetch: paidFetch as (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
    x402Client: client,
    spendingTracker,
    getSpendingSummary: () => spendingTracker.getSummary(),
    walletAddress,
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
export async function createX402Fetch(
  configOverrides?: Partial<X402Config>,
): Promise<(input: string | URL | Request, init?: RequestInit) => Promise<Response>> {
  return (await createX402Client(configOverrides)).fetch;
}

/**
 * Convert a USDC raw value (smallest unit, 6 decimals) to USD: 1000000 = $1.00.
 * Returns null unless the value is a non-negative integer string, so a missing or
 * malformed amount blocks the payment instead of counting as $0.
 */
function usdcToUsd(rawValue: unknown): number | null {
  if (typeof rawValue !== "string" || !/^\d+$/.test(rawValue)) return null;
  return Number(BigInt(rawValue)) / 1_000_000;
}
