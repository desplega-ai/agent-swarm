/**
 * Openfort Signer for x402 Payments
 *
 * Creates a ClientEvmSigner using Openfort's backend wallet API.
 * Openfort manages the signing keys in a TEE — no raw private keys in env vars.
 *
 * Required env vars:
 *   OPENFORT_API_KEY     — Openfort API key (sk_test_ or sk_live_ prefixed)
 *   OPENFORT_WALLET_SECRET — P-256 ECDSA key for wallet auth (base64 encoded)
 *
 * Optional env vars:
 *   OPENFORT_WALLET_ADDRESS — Reuse an existing wallet instead of creating a new one
 */

import Openfort, { type EvmAccount } from "@openfort/openfort-node";
import type { ClientEvmSigner } from "@x402/evm";
import type { Address } from "viem";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

export type { ClientEvmSigner } from "@x402/evm";

export interface OpenfortSignerConfig {
  apiKey: string;
  walletSecret: string;
  walletAddress?: string;
  /** viem chain for readContract (defaults to baseSepolia) */
  chain?: Parameters<typeof createPublicClient>[0]["chain"];
}

/**
 * Create a ClientEvmSigner backed by Openfort's backend wallet.
 *
 * If `walletAddress` is provided, retrieves the existing wallet.
 * Otherwise, creates a new backend wallet (or reuses the first one found).
 */
export async function createOpenfortSigner(config: OpenfortSignerConfig): Promise<ClientEvmSigner> {
  const openfort = new Openfort(config.apiKey, {
    walletSecret: config.walletSecret,
  });

  let account: EvmAccount;

  if (config.walletAddress) {
    account = await openfort.accounts.evm.backend.get({
      address: config.walletAddress as Address,
    });
  } else {
    const { accounts } = await openfort.accounts.evm.backend.list({ limit: 1 });
    if (accounts.length > 0) {
      account = accounts[0] as EvmAccount;
    } else {
      account = await openfort.accounts.evm.backend.create();
    }
  }

  // readContract is required by ClientEvmSigner for on-chain reads (e.g. ERC-20 allowance checks)
  const publicClient = createPublicClient({
    chain: config.chain ?? baseSepolia,
    transport: http(),
  });

  return {
    address: account.address,
    signTypedData: async (message) => {
      const sig = await account.signTypedData(message);
      // Normalize v-value: Openfort produces v=0/1 (EIP-2098) but
      // USDC's transferWithAuthorization expects v=27/28 (legacy).
      // Fix the last byte of the 65-byte hex signature.
      if (sig.length === 132) {
        // 0x + 128 hex chars = 65 bytes
        const v = parseInt(sig.slice(130, 132), 16);
        if (v < 27) {
          return (sig.slice(0, 130) + (v + 27).toString(16).padStart(2, "0")) as `0x${string}`;
        }
      }
      return sig;
    },
    readContract: async (args) => {
      return publicClient.readContract(args);
    },
  };
}
