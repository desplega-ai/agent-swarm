/**
 * x402 Payment Configuration
 *
 * Environment variables and defaults for x402 payment capability.
 */

export interface X402Config {
  /** EVM private key for signing payments (hex string starting with 0x) */
  evmPrivateKey: `0x${string}`;
  /** Maximum amount (in USD) to auto-approve per request. Default: $1.00 */
  maxAutoApprove: number;
  /** Daily spending limit in USD. Default: $10.00 */
  dailyLimit: number;
  /** Facilitator URL for payment verification/settlement */
  facilitatorUrl: string;
  /** Network to use (CAIP-2 format). Default: eip155:84532 (Base Sepolia) */
  network: string;
}

const DEFAULT_MAX_AUTO_APPROVE = 1.0;
const DEFAULT_DAILY_LIMIT = 10.0;
const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";
const DEFAULT_NETWORK = "eip155:84532"; // Base Sepolia (testnet)

/**
 * Load x402 configuration from environment variables.
 *
 * Required env vars:
 *   EVM_PRIVATE_KEY — wallet private key (0x-prefixed hex)
 *
 * Optional env vars:
 *   X402_MAX_AUTO_APPROVE — max USD per request (default: 1.00)
 *   X402_DAILY_LIMIT — daily USD limit (default: 10.00)
 *   X402_FACILITATOR_URL — facilitator endpoint (default: https://x402.org/facilitator)
 *   X402_NETWORK — CAIP-2 network ID (default: eip155:84532)
 */
export function loadX402Config(): X402Config {
  const evmPrivateKey = process.env.EVM_PRIVATE_KEY;
  if (!evmPrivateKey) {
    throw new Error(
      "EVM_PRIVATE_KEY environment variable is required for x402 payments. " +
        "Set it to your wallet's private key (0x-prefixed hex string).",
    );
  }

  if (!evmPrivateKey.startsWith("0x")) {
    throw new Error("EVM_PRIVATE_KEY must start with '0x'.");
  }

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

  return {
    evmPrivateKey: evmPrivateKey as `0x${string}`,
    maxAutoApprove,
    dailyLimit,
    facilitatorUrl: process.env.X402_FACILITATOR_URL || DEFAULT_FACILITATOR_URL,
    network: process.env.X402_NETWORK || DEFAULT_NETWORK,
  };
}
