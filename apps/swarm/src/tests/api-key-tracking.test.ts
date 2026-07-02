/**
 * Tests for API key rate limit tracking and rotation.
 * Covers: credential selection, DB queries, HTTP endpoints.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  clearKeyRateLimit,
  closeDb,
  getAvailableKeyIndices,
  getKeyStatuses,
  initDb,
  markKeyRateLimited,
  recordKeyRateLimitWindows,
  recordKeyUsage,
} from "../be/db";
import type { CredentialSelection } from "../utils/credentials";
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
    expect(result.isRateLimitFallback).toBe(true);
  });

  test("filters out-of-range availableIndices", () => {
    const value = "key-aaa11,key-bbb22";
    const result = selectCredential(value, [99]); // Out of range
    // Falls back to random
    expect(["key-aaa11", "key-bbb22"]).toContain(result.selected);
    expect(result.isRateLimitFallback).toBe(true);
  });

  test("isRateLimitFallback is false when indices are available", () => {
    const result = selectCredential("key-aaa11,key-bbb22", [0, 1]);
    expect(result.isRateLimitFallback).toBe(false);
  });

  test("isRateLimitFallback is false when no availability info", () => {
    const result = selectCredential("key-aaa11,key-bbb22");
    expect(result.isRateLimitFallback).toBe(false);
  });

  test("single key with empty availableIndices sets isRateLimitFallback", () => {
    const result = selectCredential("single-key", []);
    expect(result.isRateLimitFallback).toBe(true);
    expect(result.selected).toBe("single-key");
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

  test("clearKeyRateLimit clears a rate-limited key", () => {
    const until = new Date(Date.now() + 300_000).toISOString();
    recordKeyUsage("OPENAI_API_KEY", "oai01", 0, null);
    markKeyRateLimited("OPENAI_API_KEY", "oai01", 0, until);

    let statuses = getKeyStatuses("OPENAI_API_KEY");
    expect(statuses.find((s) => s.keySuffix === "oai01")!.status).toBe("rate_limited");

    const cleared = clearKeyRateLimit("OPENAI_API_KEY", "oai01");
    expect(cleared).toBe(true);

    statuses = getKeyStatuses("OPENAI_API_KEY");
    expect(statuses.find((s) => s.keySuffix === "oai01")!.status).toBe("available");
    expect(statuses.find((s) => s.keySuffix === "oai01")!.rateLimitedUntil).toBeNull();
  });

  test("clearKeyRateLimit returns false for already-available key", () => {
    recordKeyUsage("OPENAI_API_KEY", "oai02", 1, null);
    const cleared = clearKeyRateLimit("OPENAI_API_KEY", "oai02");
    expect(cleared).toBe(false);
  });

  test("recordKeyRateLimitWindows persists latest provider windows", () => {
    recordKeyRateLimitWindows("ANTHROPIC_API_KEY", "aaa11", 0, {
      seven_day: {
        status: "allowed_warning",
        utilization: 0.82,
        resetsAt: 1781334000,
        isUsingOverage: false,
        surpassedThreshold: 0.75,
        lastSeenAt: "2026-06-12T00:00:00.000Z",
      },
    });

    const key = getKeyStatuses("ANTHROPIC_API_KEY").find((s) => s.keySuffix === "aaa11");
    expect(key?.rateLimitWindows).toEqual({
      seven_day: {
        status: "allowed_warning",
        utilization: 0.82,
        resetsAt: 1781334000,
        isUsingOverage: false,
        surpassedThreshold: 0.75,
        lastSeenAt: "2026-06-12T00:00:00.000Z",
      },
    });
  });

  test("recordKeyRateLimitWindows merges with existing provider windows", () => {
    recordKeyRateLimitWindows("ANTHROPIC_API_KEY", "aaa11", 0, {
      seven_day: {
        status: "allowed_warning",
        utilization: 0.82,
        resetsAt: 1781334000,
        lastSeenAt: "2026-06-12T00:00:00.000Z",
      },
    });

    recordKeyRateLimitWindows("ANTHROPIC_API_KEY", "aaa11", 0, {
      five_hour: {
        status: "allowed",
        utilization: 0.2,
        resetsAt: 1781270000,
        lastSeenAt: "2026-06-12T01:00:00.000Z",
      },
    });

    const key = getKeyStatuses("ANTHROPIC_API_KEY").find((s) => s.keySuffix === "aaa11");
    expect(key?.rateLimitWindows).toEqual({
      seven_day: {
        status: "allowed_warning",
        utilization: 0.82,
        resetsAt: 1781334000,
        lastSeenAt: "2026-06-12T00:00:00.000Z",
      },
      five_hour: {
        status: "allowed",
        utilization: 0.2,
        resetsAt: 1781270000,
        lastSeenAt: "2026-06-12T01:00:00.000Z",
      },
    });
  });
});

// ─── Cross-keyType Failover Logic Tests ──────────────────────────────────────

describe("cross-keyType failover", () => {
  test("prefers non-rate-limited credential when both keyTypes available", () => {
    const rateLimited: CredentialSelection = {
      selected: "sk-xxx",
      index: 0,
      total: 1,
      keySuffix: "k-xxx",
      keyType: "OPENAI_API_KEY",
      isRateLimitFallback: true,
    };
    const healthy: CredentialSelection = {
      selected: "oauth-yyy",
      index: 0,
      total: 2,
      keySuffix: "h-yyy",
      keyType: "CODEX_OAUTH",
      isRateLimitFallback: false,
    };

    // Simulate the runner's primary selection logic
    let primarySelection: CredentialSelection | undefined;
    if (rateLimited && healthy) {
      if (rateLimited.isRateLimitFallback && !healthy.isRateLimitFallback) {
        primarySelection = healthy;
      } else {
        primarySelection = rateLimited;
      }
    } else {
      primarySelection = rateLimited ?? healthy;
    }

    expect(primarySelection).toBe(healthy);
    expect(primarySelection!.keyType).toBe("CODEX_OAUTH");
  });

  test("uses first credential when neither is rate-limited", () => {
    const first: CredentialSelection = {
      selected: "sk-aaa",
      index: 0,
      total: 1,
      keySuffix: "k-aaa",
      keyType: "OPENAI_API_KEY",
      isRateLimitFallback: false,
    };
    const second: CredentialSelection = {
      selected: "oauth-bbb",
      index: 0,
      total: 1,
      keySuffix: "h-bbb",
      keyType: "CODEX_OAUTH",
      isRateLimitFallback: false,
    };

    let primarySelection: CredentialSelection | undefined;
    if (first && second) {
      if (first.isRateLimitFallback && !second.isRateLimitFallback) {
        primarySelection = second;
      } else {
        primarySelection = first;
      }
    } else {
      primarySelection = first ?? second;
    }

    expect(primarySelection).toBe(first);
    expect(primarySelection!.keyType).toBe("OPENAI_API_KEY");
  });
});
