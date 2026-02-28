import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadX402Config } from "../x402/config.ts";

describe("loadX402Config", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear x402-related env vars before each test
    delete process.env.EVM_PRIVATE_KEY;
    delete process.env.X402_MAX_AUTO_APPROVE;
    delete process.env.X402_DAILY_LIMIT;
    delete process.env.X402_NETWORK;
    delete process.env.X402_SIGNER_TYPE;
    delete process.env.OPENFORT_API_KEY;
    delete process.env.OPENFORT_WALLET_SECRET;
    delete process.env.OPENFORT_WALLET_ADDRESS;
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  test("throws when no signer credentials are set", () => {
    expect(() => loadX402Config()).toThrow("x402 payment requires either Openfort credentials");
  });

  // --- Viem signer tests ---

  test("auto-detects viem signer when EVM_PRIVATE_KEY is set", () => {
    process.env.EVM_PRIVATE_KEY =
      "0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678";

    const config = loadX402Config();
    expect(config.signerType).toBe("viem");
    expect(config.evmPrivateKey).toBe(
      "0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678",
    );
  });

  test("throws when EVM_PRIVATE_KEY does not start with 0x", () => {
    process.env.EVM_PRIVATE_KEY =
      "deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678";
    expect(() => loadX402Config()).toThrow("EVM_PRIVATE_KEY must start with '0x'");
  });

  test("returns config with defaults when only EVM_PRIVATE_KEY is set", () => {
    process.env.EVM_PRIVATE_KEY =
      "0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678";

    const config = loadX402Config();

    expect(config.signerType).toBe("viem");
    expect(config.maxAutoApprove).toBe(1.0);
    expect(config.dailyLimit).toBe(10.0);
    expect(config.network).toBe("eip155:84532");
  });

  // --- Openfort signer tests ---

  test("auto-detects openfort signer when OPENFORT_API_KEY is set", () => {
    process.env.OPENFORT_API_KEY = "sk_test_abc123";
    process.env.OPENFORT_WALLET_SECRET = "base64secret";

    const config = loadX402Config();
    expect(config.signerType).toBe("openfort");
    expect(config.openfortApiKey).toBe("sk_test_abc123");
    expect(config.openfortWalletSecret).toBe("base64secret");
  });

  test("openfort takes priority over viem when both are set", () => {
    process.env.OPENFORT_API_KEY = "sk_test_abc123";
    process.env.OPENFORT_WALLET_SECRET = "base64secret";
    process.env.EVM_PRIVATE_KEY =
      "0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678";

    const config = loadX402Config();
    expect(config.signerType).toBe("openfort");
  });

  test("throws when openfort signer is selected but OPENFORT_WALLET_SECRET is missing", () => {
    process.env.OPENFORT_API_KEY = "sk_test_abc123";
    expect(() => loadX402Config()).toThrow("OPENFORT_WALLET_SECRET is required");
  });

  test("includes OPENFORT_WALLET_ADDRESS when set", () => {
    process.env.OPENFORT_API_KEY = "sk_test_abc123";
    process.env.OPENFORT_WALLET_SECRET = "base64secret";
    process.env.OPENFORT_WALLET_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";

    const config = loadX402Config();
    expect(config.openfortWalletAddress).toBe("0x1234567890abcdef1234567890abcdef12345678");
  });

  // --- Explicit signer type ---

  test("respects explicit X402_SIGNER_TYPE=viem", () => {
    process.env.X402_SIGNER_TYPE = "viem";
    process.env.EVM_PRIVATE_KEY =
      "0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678";
    process.env.OPENFORT_API_KEY = "sk_test_abc123";

    const config = loadX402Config();
    expect(config.signerType).toBe("viem");
  });

  test("throws on invalid X402_SIGNER_TYPE", () => {
    process.env.X402_SIGNER_TYPE = "invalid";
    process.env.EVM_PRIVATE_KEY =
      "0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678";
    expect(() => loadX402Config()).toThrow('X402_SIGNER_TYPE must be "openfort" or "viem"');
  });

  // --- Spending limit tests ---

  test("parses custom X402_MAX_AUTO_APPROVE", () => {
    process.env.EVM_PRIVATE_KEY =
      "0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678";
    process.env.X402_MAX_AUTO_APPROVE = "5.50";

    const config = loadX402Config();
    expect(config.maxAutoApprove).toBe(5.5);
  });

  test("parses custom X402_DAILY_LIMIT", () => {
    process.env.EVM_PRIVATE_KEY =
      "0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678";
    process.env.X402_DAILY_LIMIT = "25.00";

    const config = loadX402Config();
    expect(config.dailyLimit).toBe(25.0);
  });

  test("uses custom X402_NETWORK", () => {
    process.env.EVM_PRIVATE_KEY =
      "0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678";
    process.env.X402_NETWORK = "eip155:8453";

    const config = loadX402Config();
    expect(config.network).toBe("eip155:8453");
  });

  test("throws when X402_MAX_AUTO_APPROVE is not a valid number", () => {
    process.env.EVM_PRIVATE_KEY =
      "0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678";
    process.env.X402_MAX_AUTO_APPROVE = "abc";

    expect(() => loadX402Config()).toThrow("X402_MAX_AUTO_APPROVE must be a positive number");
  });

  test("throws when X402_MAX_AUTO_APPROVE is zero", () => {
    process.env.EVM_PRIVATE_KEY =
      "0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678";
    process.env.X402_MAX_AUTO_APPROVE = "0";

    expect(() => loadX402Config()).toThrow("X402_MAX_AUTO_APPROVE must be a positive number");
  });

  test("throws when X402_MAX_AUTO_APPROVE is negative", () => {
    process.env.EVM_PRIVATE_KEY =
      "0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678";
    process.env.X402_MAX_AUTO_APPROVE = "-1";

    expect(() => loadX402Config()).toThrow("X402_MAX_AUTO_APPROVE must be a positive number");
  });

  test("throws when X402_DAILY_LIMIT is not a valid number", () => {
    process.env.EVM_PRIVATE_KEY =
      "0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678";
    process.env.X402_DAILY_LIMIT = "not-a-number";

    expect(() => loadX402Config()).toThrow("X402_DAILY_LIMIT must be a positive number");
  });

  test("throws when X402_DAILY_LIMIT is zero", () => {
    process.env.EVM_PRIVATE_KEY =
      "0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678";
    process.env.X402_DAILY_LIMIT = "0";

    expect(() => loadX402Config()).toThrow("X402_DAILY_LIMIT must be a positive number");
  });
});
