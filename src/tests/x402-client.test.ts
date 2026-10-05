import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createX402Client } from "../x402/client.ts";

// A valid test private key (DO NOT use in production — this is a well-known throwaway key)
const TEST_PRIVATE_KEY = `0x${"11".repeat(32)}`;

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

describe("createX402Client spending reservations (real x402 core client)", () => {
  const originalEnv = { ...process.env };

  // $5 USDC on Base Sepolia, signed locally by the viem signer (no network calls)
  const paymentRequired = {
    x402Version: 2,
    resource: { url: "https://paid.example/resource" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:84532",
        amount: "5000000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x4f27DC247a55EA5920F8311A25672Ed1B590792d",
        maxTimeoutSeconds: 60,
        extra: { name: "USDC", version: "2" },
      },
    ],
  } as unknown as Parameters<
    Awaited<ReturnType<typeof createX402Client>>["x402Client"]["createPaymentPayload"]
  >[0];

  beforeEach(() => {
    process.env.EVM_PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.X402_SIGNER_TYPE = "viem";
    delete process.env.X402_NETWORK;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("confirms the reservation once the payment is created", async () => {
    const client = await createX402Client({ maxAutoApprove: 5, dailyLimit: 10 });

    await client.x402Client.createPaymentPayload(paymentRequired);

    const summary = client.getSpendingSummary();
    expect(summary.todaySpent).toBe(5);
    expect(summary.reserved).toBe(0);
    expect(summary.todayCount).toBe(1);
  });

  test("releases the reservation when a later before-hook aborts", async () => {
    const client = await createX402Client({ maxAutoApprove: 5, dailyLimit: 5 });
    client.x402Client.onBeforePaymentCreation(async () => ({ abort: true, reason: "policy" }));

    await expect(client.x402Client.createPaymentPayload(paymentRequired)).rejects.toThrow("policy");

    const summary = client.getSpendingSummary();
    expect(summary.todaySpent).toBe(0);
    expect(summary.reserved).toBe(0);
    expect(summary.dailyRemaining).toBe(5);
  });

  test("releases the reservation when a later before-hook throws", async () => {
    const client = await createX402Client({ maxAutoApprove: 5, dailyLimit: 5 });
    client.x402Client.onBeforePaymentCreation(async () => {
      throw new Error("hook failed");
    });

    await expect(client.x402Client.createPaymentPayload(paymentRequired)).rejects.toThrow(
      "hook failed",
    );

    const summary = client.getSpendingSummary();
    expect(summary.reserved).toBe(0);
    expect(summary.dailyRemaining).toBe(5);
  });

  test("a failing call never settles another concurrent call's reservation", async () => {
    const client = await createX402Client({ maxAutoApprove: 5, dailyLimit: 10 });

    // Hold the second call before signing until the first has finished
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let beforeCalls = 0;
    client.x402Client.onBeforePaymentCreation(async () => {
      beforeCalls++;
      if (beforeCalls === 2) await secondGate;
    });
    // The first call to finish signing fails in a later after-hook
    let afterCalls = 0;
    client.x402Client.onAfterPaymentCreation(async () => {
      afterCalls++;
      if (afterCalls === 1) throw new Error("after-hook failed");
    });

    const first = client.x402Client.createPaymentPayload(paymentRequired);
    const second = client.x402Client.createPaymentPayload(paymentRequired);

    await expect(first).rejects.toThrow("after-hook failed");

    // The second call is still in flight: its $5 must still be held, nothing spent
    let summary = client.getSpendingSummary();
    expect(summary.todaySpent).toBe(0);
    expect(summary.reserved).toBe(5);

    releaseSecond();
    await second;

    summary = client.getSpendingSummary();
    expect(summary.todaySpent).toBe(5);
    expect(summary.reserved).toBe(0);
    expect(summary.todayCount).toBe(1);
  });

  test("concurrent calls cannot both pass the daily limit", async () => {
    const client = await createX402Client({ maxAutoApprove: 5, dailyLimit: 5 });

    const results = await Promise.allSettled([
      client.x402Client.createPaymentPayload(paymentRequired),
      client.x402Client.createPaymentPayload(paymentRequired),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const summary = client.getSpendingSummary();
    expect(summary.todaySpent).toBe(5);
    expect(summary.reserved).toBe(0);
  });
});
