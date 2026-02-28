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
import type { Address, Hex, TypedData, TypedDataDefinition } from "viem";

/** The signer interface x402's EVM scheme expects. */
export interface ClientEvmSigner {
  address: Address;
  signTypedData: (
    parameters: TypedDataDefinition<TypedData | Record<string, unknown>, string>,
  ) => Promise<Hex>;
}

export interface OpenfortSignerConfig {
  apiKey: string;
  walletSecret: string;
  walletAddress?: string;
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
    // Retrieve existing wallet by address
    account = await openfort.accounts.evm.backend.get({
      address: config.walletAddress as Address,
    });
  } else {
    // Try to reuse an existing backend wallet, or create a new one
    const { accounts } = await openfort.accounts.evm.backend.list({ limit: 1 });
    if (accounts && accounts.length > 0) {
      account = accounts[0];
    } else {
      account = await openfort.accounts.evm.backend.create();
    }
  }

  return {
    address: account.address,
    signTypedData: async (parameters) => {
      return account.signTypedData(parameters);
    },
  };
}
