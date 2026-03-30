/**
 * Tests for API key rate limit tracking and rotation.
 * Covers: credential selection, DB queries, HTTP endpoints.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  getAvailableKeyIndices,
  getKeyStatuses,
  initDb,
  markKeyRateLimited,
  recordKeyUsage,
} from "../be/db";
import { resolveCredentialPools, selectCredential } from "../utils/credentials";

// ─── Credential Selection Unit Tests ────────────────────────────────────────

describe("selectCredential", () => {
  test("single value returns it as-is", () => {
    const result = selectCredential("sk-ant-123456789");
    expect(result.selected).toBe("sk-ant-123456789");
    expect(result.index).toBe(0);
    expect(result.total).toBe(1);
    expect(result.keySuffix).toBe("56789");
  });

  test("comma-separated picks one randomly", () => {
    const value = "key-aaa11,key-bbb22,key-ccc33";
    const results = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const result = selectCredential(value);
      results.add(result.selected);
      expect(result.total).toBe(3);
      expect(result.index).toBeGreaterThanOrEqual(0);
      expect(result.index).toBeLessThan(3);
      expect(result.keySuffix.length).toBe(5);
    }
    // Should eventually pick more than one key
    expect(results.size).toBeGreaterThan(1);
  });

  test("respects availableIndices for rate-limit-aware selection", () => {
    const value = "key-aaa11,key-bbb22,key-ccc33";
    for (let i = 0; i < 50; i++) {
      const result = selectCredential(value, [1]); // Only index 1 is available
      expect(result.selected).toBe("key-bbb22");
      expect(result.index).toBe(1);
    }
  });

  test("falls back to random when all keys are rate-limited (empty availableIndices)", () => {
    const value = "key-aaa11,key-bbb22";
    const result = selectCredential(value, []);
    expect(["key-aaa11", "key-bbb22"]).toContain(result.selected);
  });

  test("filters out-of-range availableIndices", () => {
    const value = "key-aaa11,key-bbb22";
    const result = selectCredential(value, [99]); // Out of range
    // Falls back to random
    expect(["key-aaa11", "key-bbb22"]).toContain(result.selected);
  });

  test("keySuffix is last 5 chars of selected key", () => {
    const result = selectCredential("sk-ant-api03-abcde12345");
    expect(result.keySuffix).toBe("12345");
  });

  test("keyType defaults to ANTHROPIC_API_KEY", () => {
    const result = selectCredential("sk-ant-123456789");
    expect(result.keyType).toBe("ANTHROPIC_API_KEY");
  });

  test("keyType is passed through when specified", () => {
    const result = selectCredential("oauth-token-abc", undefined, "CLAUDE_CODE_OAUTH_TOKEN");
    expect(result.keyType).toBe("CLAUDE_CODE_OAUTH_TOKEN");
  });
});

describe("resolveCredentialPools", () => {
  test("returns selections for pool vars", async () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: "key-aaa11,key-bbb22",
    };
    const selections = await resolveCredentialPools(env);
    expect(selections.length).toBe(1);
    expect(selections[0]!.total).toBe(2);
    expect(selections[0]!.keyType).toBe("ANTHROPIC_API_KEY");
    // Env should be mutated to the selected key
    expect(["key-aaa11", "key-bbb22"]).toContain(env.ANTHROPIC_API_KEY);
  });

  test("passes availableIndicesMap through", async () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: "key-aaa11,key-bbb22,key-ccc33",
    };
    const selections = await resolveCredentialPools(env, {
      availableIndicesMap: { ANTHROPIC_API_KEY: [2] },
    });
    expect(selections.length).toBe(1);
    expect(selections[0]!.index).toBe(2);
    expect(env.ANTHROPIC_API_KEY).toBe("key-ccc33");
  });

  test("single keys are tracked with index 0", async () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: "single-key",
    };
    const selections = await resolveCredentialPools(env);
    expect(selections.length).toBe(1);
    expect(selections[0]!.index).toBe(0);
    expect(selections[0]!.total).toBe(1);
    expect(selections[0]!.keySuffix).toBe("e-key");
    expect(selections[0]!.keyType).toBe("ANTHROPIC_API_KEY");
    expect(env.ANTHROPIC_API_KEY).toBe("single-key");
  });
});

// ─── DB Query Tests ─────────────────────────────────────────────────────────

const TEST_DB = `./test-api-key-tracking-${Date.now()}.sqlite`;

describe("API key tracking DB queries", () => {
  beforeAll(() => {
    process.env.DB_PATH = TEST_DB;
    initDb(TEST_DB);
  });

  afterAll(async () => {
    closeDb();
    await unlink(TEST_DB).catch(() => {});
    await unlink(`${TEST_DB}-wal`).catch(() => {});
    await unlink(`${TEST_DB}-shm`).catch(() => {});
  });

  test("recordKeyUsage creates key status record", () => {
    recordKeyUsage("ANTHROPIC_API_KEY", "aaa11", 0, null);
    const statuses = getKeyStatuses("ANTHROPIC_API_KEY");
    expect(statuses.length).toBe(1);
    expect(statuses[0]!.keySuffix).toBe("aaa11");
    expect(statuses[0]!.totalUsageCount).toBe(1);
    expect(statuses[0]!.status).toBe("available");
  });

  test("recordKeyUsage increments usage count on repeated calls", () => {
    recordKeyUsage("ANTHROPIC_API_KEY", "aaa11", 0, null);
    recordKeyUsage("ANTHROPIC_API_KEY", "aaa11", 0, null);
    const statuses = getKeyStatuses("ANTHROPIC_API_KEY");
    expect(statuses[0]!.totalUsageCount).toBe(3); // 1 from first test + 2
  });

  test("markKeyRateLimited sets status and timestamp", () => {
    const until = new Date(Date.now() + 300_000).toISOString();
    markKeyRateLimited("ANTHROPIC_API_KEY", "aaa11", 0, until);
    const statuses = getKeyStatuses("ANTHROPIC_API_KEY");
    expect(statuses[0]!.status).toBe("rate_limited");
    expect(statuses[0]!.rateLimitedUntil).toBe(until);
    expect(statuses[0]!.rateLimitCount).toBe(1);
  });

  test("getAvailableKeyIndices excludes rate-limited keys", () => {
    // Key 0 is rate-limited from above, add key 1 as available
    recordKeyUsage("ANTHROPIC_API_KEY", "bbb22", 1, null);
    const available = getAvailableKeyIndices("ANTHROPIC_API_KEY", 3);
    expect(available).toContain(1);
    expect(available).toContain(2); // Never tracked, so available
    expect(available).not.toContain(0); // Rate-limited
  });

  test("getAvailableKeyIndices auto-clears expired rate limits", () => {
    // Mark key as rate-limited until the past
    const pastDate = new Date(Date.now() - 1000).toISOString();
    markKeyRateLimited("ANTHROPIC_API_KEY", "ccc33", 2, pastDate);

    // Should auto-clear and return as available
    const available = getAvailableKeyIndices("ANTHROPIC_API_KEY", 3);
    expect(available).toContain(2);
  });

  test("getKeyStatuses filters by keyType", () => {
    recordKeyUsage("CLAUDE_CODE_OAUTH_TOKEN", "ooo11", 0, null);
    const anthStatuses = getKeyStatuses("ANTHROPIC_API_KEY");
    const oauthStatuses = getKeyStatuses("CLAUDE_CODE_OAUTH_TOKEN");
    expect(anthStatuses.every((s) => s.keyType === "ANTHROPIC_API_KEY")).toBe(true);
    expect(oauthStatuses.every((s) => s.keyType === "CLAUDE_CODE_OAUTH_TOKEN")).toBe(true);
  });

  test("markKeyRateLimited increments rateLimitCount", () => {
    const until = new Date(Date.now() + 600_000).toISOString();
    markKeyRateLimited("ANTHROPIC_API_KEY", "bbb22", 1, until);
    const statuses = getKeyStatuses("ANTHROPIC_API_KEY");
    const key1 = statuses.find((s) => s.keySuffix === "bbb22");
    expect(key1!.rateLimitCount).toBe(1);

    markKeyRateLimited("ANTHROPIC_API_KEY", "bbb22", 1, until);
    const statuses2 = getKeyStatuses("ANTHROPIC_API_KEY");
    const key1b = statuses2.find((s) => s.keySuffix === "bbb22");
    expect(key1b!.rateLimitCount).toBe(2);
  });
});
