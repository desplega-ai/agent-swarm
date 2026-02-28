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
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  test("throws when EVM_PRIVATE_KEY is not set", () => {
    expect(() => loadX402Config()).toThrow("EVM_PRIVATE_KEY environment variable is required");
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

    expect(config.evmPrivateKey).toBe(
      "0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678",
    );
    expect(config.maxAutoApprove).toBe(1.0);
    expect(config.dailyLimit).toBe(10.0);
    expect(config.network).toBe("eip155:84532");
  });

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
