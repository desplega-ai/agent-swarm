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
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("creates client with config overrides", () => {
    process.env.EVM_PRIVATE_KEY = TEST_PRIVATE_KEY;

    const client = createX402Client({
      maxAutoApprove: 2.5,
      dailyLimit: 25.0,
    });

    expect(client.fetch).toBeFunction();
    expect(client.x402Client).toBeDefined();
    expect(client.spendingTracker).toBeDefined();
    expect(client.getSpendingSummary).toBeFunction();
    expect(client.walletAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  test("derives a consistent wallet address from private key", () => {
    process.env.EVM_PRIVATE_KEY = TEST_PRIVATE_KEY;

    const client1 = createX402Client();
    const client2 = createX402Client();

    expect(client1.walletAddress).toBe(client2.walletAddress);
  });

  test("safe config excludes private key", () => {
    process.env.EVM_PRIVATE_KEY = TEST_PRIVATE_KEY;

    const client = createX402Client();

    // config should NOT contain evmPrivateKey
    expect(client.config).not.toHaveProperty("evmPrivateKey");
    expect(client.config.maxAutoApprove).toBe(1.0);
    expect(client.config.dailyLimit).toBe(10.0);
    expect(client.config.network).toBe("eip155:84532");
  });

  test("spending summary reflects tracker state", () => {
    process.env.EVM_PRIVATE_KEY = TEST_PRIVATE_KEY;

    const client = createX402Client();
    const summary = client.getSpendingSummary();

    expect(summary.todaySpent).toBe(0);
    expect(summary.todayCount).toBe(0);
    expect(summary.maxPerRequest).toBe(1.0);
    expect(summary.dailyLimit).toBe(10.0);
    expect(summary.dailyRemaining).toBe(10.0);
  });

  test("applies config overrides over env defaults", () => {
    process.env.EVM_PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.X402_MAX_AUTO_APPROVE = "3.0";
    process.env.X402_DAILY_LIMIT = "30.0";

    const client = createX402Client({
      maxAutoApprove: 7.0,
      dailyLimit: 70.0,
    });

    expect(client.config.maxAutoApprove).toBe(7.0);
    expect(client.config.dailyLimit).toBe(70.0);
  });

  test("uses Base Sepolia by default (testnet)", () => {
    process.env.EVM_PRIVATE_KEY = TEST_PRIVATE_KEY;

    const client = createX402Client();
    expect(client.config.network).toBe("eip155:84532");
  });

  test("throws when EVM_PRIVATE_KEY is missing and no override", () => {
    expect(() => createX402Client()).toThrow("EVM_PRIVATE_KEY environment variable is required");
  });
});
