/**
 * x402 Payment Configuration
 *
 * Environment variables and defaults for x402 payment capability.
 *
 * Signer types:
 *   "openfort" (default when OPENFORT_API_KEY is set) — Openfort managed backend wallet
 *   "viem"     (fallback) — raw EVM private key via viem's privateKeyToAccount
 *
 * Common env vars:
 *   X402_MAX_AUTO_APPROVE — Max USD per request (default: 1.00)
 *   X402_DAILY_LIMIT      — Daily USD limit (default: 10.00)
 *   X402_NETWORK          — CAIP-2 network ID (default: eip155:84532 Base Sepolia)
 *   X402_SIGNER_TYPE      — "openfort" or "viem" (auto-detected if not set)
 *
 * Openfort env vars:
 *   OPENFORT_API_KEY         — Openfort API key (sk_test_ or sk_live_ prefixed)
 *   OPENFORT_WALLET_SECRET   — P-256 ECDSA key for wallet auth (base64 encoded)
 *   OPENFORT_WALLET_ADDRESS  — (Optional) Reuse existing wallet address
 *
 * Viem env vars:
 *   EVM_PRIVATE_KEY — Raw wallet private key (0x-prefixed hex)
 */

export type SignerType = "openfort" | "viem";

export interface X402Config {
  /** Which signer backend to use */
  signerType: SignerType;
  /** Maximum amount (in USD) to auto-approve per request. Default: $1.00 */
  maxAutoApprove: number;
  /** Daily spending limit in USD. Default: $10.00 */
  dailyLimit: number;
  /** Network to use (CAIP-2 format). Default: eip155:84532 (Base Sepolia) */
  network: string;

  // Openfort-specific
  openfortApiKey?: string;
  openfortWalletSecret?: string;
  openfortWalletAddress?: string;

  // Viem-specific
  evmPrivateKey?: `0x${string}`;
}

/** Safe subset of config without sensitive fields. */
export type X402SafeConfig = Omit<
  X402Config,
  "evmPrivateKey" | "openfortApiKey" | "openfortWalletSecret"
>;

const DEFAULT_MAX_AUTO_APPROVE = 1.0;
const DEFAULT_DAILY_LIMIT = 10.0;
const DEFAULT_NETWORK = "eip155:84532"; // Base Sepolia (testnet)

/**
 * Load x402 configuration from environment variables.
 *
 * Auto-detects signer type:
 *   - If OPENFORT_API_KEY is set → uses "openfort"
 *   - If EVM_PRIVATE_KEY is set → uses "viem"
 *   - If neither → throws
 */
export function loadX402Config(): X402Config {
  const maxAutoApprove = Number.parseFloat(
    process.env.X402_MAX_AUTO_APPROVE || String(DEFAULT_MAX_AUTO_APPROVE),
  );
  const dailyLimit = Number.parseFloat(process.env.X402_DAILY_LIMIT || String(DEFAULT_DAILY_LIMIT));

  if (Number.isNaN(maxAutoApprove) || maxAutoApprove <= 0) {
    throw new Error("X402_MAX_AUTO_APPROVE must be a positive number.");
  }
  if (Number.isNaN(dailyLimit) || dailyLimit <= 0) {
    throw new Error("X402_DAILY_LIMIT must be a positive number.");
  }

  const network = process.env.X402_NETWORK || DEFAULT_NETWORK;

  // Determine signer type
  const explicitType = process.env.X402_SIGNER_TYPE as SignerType | undefined;
  const hasOpenfort = !!process.env.OPENFORT_API_KEY;
  const hasViem = !!process.env.EVM_PRIVATE_KEY;

  let signerType: SignerType;
  if (explicitType) {
    if (explicitType !== "openfort" && explicitType !== "viem") {
      throw new Error('X402_SIGNER_TYPE must be "openfort" or "viem".');
    }
    signerType = explicitType;
  } else if (hasOpenfort) {
    signerType = "openfort";
  } else if (hasViem) {
    signerType = "viem";
  } else {
    throw new Error(
      "x402 payment requires either Openfort credentials (OPENFORT_API_KEY + OPENFORT_WALLET_SECRET) " +
        "or a raw private key (EVM_PRIVATE_KEY). Set one of these to enable payments.",
    );
  }

  const config: X402Config = {
    signerType,
    maxAutoApprove,
    dailyLimit,
    network,
  };

  if (signerType === "openfort") {
    config.openfortApiKey = process.env.OPENFORT_API_KEY;
    config.openfortWalletSecret = process.env.OPENFORT_WALLET_SECRET;
    config.openfortWalletAddress = process.env.OPENFORT_WALLET_ADDRESS;

    if (!config.openfortApiKey) {
      throw new Error("OPENFORT_API_KEY is required when using openfort signer.");
    }
    if (!config.openfortWalletSecret) {
      throw new Error("OPENFORT_WALLET_SECRET is required when using openfort signer.");
    }
  } else {
    const evmPrivateKey = process.env.EVM_PRIVATE_KEY;
    if (!evmPrivateKey) {
      throw new Error("EVM_PRIVATE_KEY is required when using viem signer.");
    }
    if (!evmPrivateKey.startsWith("0x")) {
      throw new Error("EVM_PRIVATE_KEY must start with '0x'.");
    }
    config.evmPrivateKey = evmPrivateKey as `0x${string}`;
  }

  return config;
}
