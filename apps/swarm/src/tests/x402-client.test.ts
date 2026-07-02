import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createX402Client } from "../x402/client.ts";

// A valid test private key (DO NOT use in production — this is a well-known throwaway key)
const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

describe("createX402Client", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.EVM_PRIVATE_KEY;
    delete process.env.X402_MAX_AUTO_APPROVE;
    delete process.env.X402_DAILY_LIMIT;
    delete process.env.X402_NETWORK;
    delete process.env.X402_SIGNER_TYPE;
    delete process.env.OPENFORT_API_KEY;
    delete process.env.OPENFORT_WALLET_SECRET;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("creates client with viem signer and config overrides", async () => {
    process.env.EVM_PRIVATE_KEY = TEST_PRIVATE_KEY;

    const client = await createX402Client({
      maxAutoApprove: 2.5,
      dailyLimit: 25.0,
    });

    expect(client.fetch).toBeFunction();
    expect(client.x402Client).toBeDefined();
    expect(client.spendingTracker).toBeDefined();
    expect(client.getSpendingSummary).toBeFunction();
    expect(client.walletAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  test("derives a consistent wallet address from private key", async () => {
    process.env.EVM_PRIVATE_KEY = TEST_PRIVATE_KEY;

    const client1 = await createX402Client();
    const client2 = await createX402Client();

    expect(client1.walletAddress).toBe(client2.walletAddress);
  });

  test("safe config excludes secrets", async () => {
    process.env.EVM_PRIVATE_KEY = TEST_PRIVATE_KEY;

    const client = await createX402Client();

    // config should NOT contain sensitive fields
    expect(client.config).not.toHaveProperty("evmPrivateKey");
    expect(client.config).not.toHaveProperty("openfortApiKey");
    expect(client.config).not.toHaveProperty("openfortWalletSecret");
    expect(client.config.maxAutoApprove).toBe(1.0);
    expect(client.config.dailyLimit).toBe(10.0);
    expect(client.config.network).toBe("eip155:84532");
    expect(client.config.signerType).toBe("viem");
  });

  test("spending summary reflects tracker state", async () => {
    process.env.EVM_PRIVATE_KEY = TEST_PRIVATE_KEY;

    const client = await createX402Client();
    const summary = client.getSpendingSummary();

    expect(summary.todaySpent).toBe(0);
    expect(summary.todayCount).toBe(0);
    expect(summary.maxPerRequest).toBe(1.0);
    expect(summary.dailyLimit).toBe(10.0);
    expect(summary.dailyRemaining).toBe(10.0);
  });

  test("applies config overrides over env defaults", async () => {
    process.env.EVM_PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.X402_MAX_AUTO_APPROVE = "3.0";
    process.env.X402_DAILY_LIMIT = "30.0";

    const client = await createX402Client({
      maxAutoApprove: 7.0,
      dailyLimit: 70.0,
    });

    expect(client.config.maxAutoApprove).toBe(7.0);
    expect(client.config.dailyLimit).toBe(70.0);
  });

  test("uses Base Sepolia by default (testnet)", async () => {
    process.env.EVM_PRIVATE_KEY = TEST_PRIVATE_KEY;

    const client = await createX402Client();
    expect(client.config.network).toBe("eip155:84532");
  });

  test("throws when no signer credentials are set", async () => {
    await expect(createX402Client()).rejects.toThrow(
      "x402 payment requires either Openfort credentials",
    );
  });

  test("auto-detects viem signer when EVM_PRIVATE_KEY is set", async () => {
    process.env.EVM_PRIVATE_KEY = TEST_PRIVATE_KEY;

    const client = await createX402Client();
    expect(client.config.signerType).toBe("viem");
  });

  test("respects explicit X402_SIGNER_TYPE=viem", async () => {
    process.env.EVM_PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.X402_SIGNER_TYPE = "viem";

    const client = await createX402Client();
    expect(client.config.signerType).toBe("viem");
  });
});
