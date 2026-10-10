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
  getDbClient,
  getKeyStatuses,
  getKv,
  initDb,
  markKeyRateLimited,
  recordKeyAuthFailure,
  recordKeyRateLimitWindows,
  recordKeyUsage,
  setApiKeyPlan,
} from "../be/db";
import type { CredentialSelection } from "../utils/credentials";
import {
  ModelWindowExhaustedError,
  resolveCredentialPools,
  selectCredential,
} from "../utils/credentials";

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
    const value = "example-key-aaa11,example-key-bbb22,example-key-ccc33";
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
    const value = "example-key-aaa11,example-key-bbb22,example-key-ccc33";
    for (let i = 0; i < 50; i++) {
      const result = selectCredential(value, [1]); // Only index 1 is available
      expect(result.selected).toBe("example-key-bbb22");
      expect(result.index).toBe(1);
    }
  });

  test("falls back to random when all keys are rate-limited (empty availableIndices)", () => {
    const value = "example-key-aaa11,example-key-bbb22";
    const result = selectCredential(value, []);
    expect(["example-key-aaa11", "example-key-bbb22"]).toContain(result.selected);
    expect(result.isRateLimitFallback).toBe(true);
  });

  test("filters out-of-range availableIndices", () => {
    const value = "example-key-aaa11,example-key-bbb22";
    const result = selectCredential(value, [99]); // Out of range
    // Falls back to random
    expect(["example-key-aaa11", "example-key-bbb22"]).toContain(result.selected);
    expect(result.isRateLimitFallback).toBe(true);
  });

  test("isRateLimitFallback is false when indices are available", () => {
    const result = selectCredential("example-key-aaa11,example-key-bbb22", [0, 1]);
    expect(result.isRateLimitFallback).toBe(false);
  });

  test("isRateLimitFallback is false when no availability info", () => {
    const result = selectCredential("example-key-aaa11,example-key-bbb22");
    expect(result.isRateLimitFallback).toBe(false);
  });

  test("single key with empty availableIndices sets isRateLimitFallback", () => {
    const result = selectCredential("example-single-key", []);
    expect(result.isRateLimitFallback).toBe(true);
    expect(result.selected).toBe("example-single-key");
  });

  test("keySuffix is last 5 chars of selected key", () => {
    const result = selectCredential("example-sk-ant-api03-abcde12345");
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
      ANTHROPIC_API_KEY: "example-key-aaa11,example-key-bbb22",
    };
    const selections = await resolveCredentialPools(env);
    expect(selections.length).toBe(1);
    expect(selections[0]!.total).toBe(2);
    expect(selections[0]!.keyType).toBe("ANTHROPIC_API_KEY");
    // Env should be mutated to the selected key
    expect(["example-key-aaa11", "example-key-bbb22"]).toContain(env.ANTHROPIC_API_KEY);
  });

  test("passes availableIndicesMap through", async () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: "example-key-aaa11,example-key-bbb22,example-key-ccc33",
    };
    const selections = await resolveCredentialPools(env, {
      availableIndicesMap: { ANTHROPIC_API_KEY: { availableIndices: [2] } },
    });
    expect(selections.length).toBe(1);
    expect(selections[0]!.index).toBe(2);
    expect(env.ANTHROPIC_API_KEY).toBe("example-key-ccc33");
  });

  test("single keys are tracked with index 0", async () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: "example-single-key",
    };
    const selections = await resolveCredentialPools(env);
    expect(selections.length).toBe(1);
    expect(selections[0]!.index).toBe(0);
    expect(selections[0]!.total).toBe(1);
    expect(selections[0]!.keySuffix).toBe("e-key");
    expect(selections[0]!.keyType).toBe("ANTHROPIC_API_KEY");
    expect(env.ANTHROPIC_API_KEY).toBe("example-single-key");
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

  test("recordKeyUsage creates key status record", async () => {
    await recordKeyUsage("ANTHROPIC_API_KEY", "aaa11", 0, null);
    const statuses = await getKeyStatuses("ANTHROPIC_API_KEY");
    expect(statuses.length).toBe(1);
    expect(statuses[0]!.keySuffix).toBe("aaa11");
    expect(statuses[0]!.totalUsageCount).toBe(1);
    expect(statuses[0]!.status).toBe("available");
  });

  test("recordKeyUsage increments usage count on repeated calls", async () => {
    await recordKeyUsage("ANTHROPIC_API_KEY", "aaa11", 0, null);
    await recordKeyUsage("ANTHROPIC_API_KEY", "aaa11", 0, null);
    const statuses = await getKeyStatuses("ANTHROPIC_API_KEY");
    expect(statuses[0]!.totalUsageCount).toBe(3); // 1 from first test + 2
  });

  test("markKeyRateLimited sets status and timestamp", async () => {
    const until = new Date(Date.now() + 300_000).toISOString();
    await markKeyRateLimited("ANTHROPIC_API_KEY", "aaa11", 0, until);
    const statuses = await getKeyStatuses("ANTHROPIC_API_KEY");
    expect(statuses[0]!.status).toBe("rate_limited");
    expect(statuses[0]!.rateLimitedUntil).toBe(until);
    expect(statuses[0]!.rateLimitCount).toBe(1);
  });

  test("getAvailableKeyIndices excludes rate-limited keys", async () => {
    // Key 0 is rate-limited from above, add key 1 as available
    await recordKeyUsage("ANTHROPIC_API_KEY", "bbb22", 1, null);
    const { availableIndices } = await getAvailableKeyIndices("ANTHROPIC_API_KEY", 3);
    expect(availableIndices).toContain(1);
    expect(availableIndices).toContain(2); // Never tracked, so available
    expect(availableIndices).not.toContain(0); // Rate-limited
  });

  test("getAvailableKeyIndices auto-clears expired rate limits", async () => {
    // Mark key as rate-limited until the past
    const pastDate = new Date(Date.now() - 1000).toISOString();
    await markKeyRateLimited("ANTHROPIC_API_KEY", "ccc33", 2, pastDate);

    // Should auto-clear and return as available
    const { availableIndices } = await getAvailableKeyIndices("ANTHROPIC_API_KEY", 3);
    expect(availableIndices).toContain(2);
  });

  test("getKeyStatuses filters by keyType", async () => {
    await recordKeyUsage("CLAUDE_CODE_OAUTH_TOKEN", "ooo11", 0, null);
    const anthStatuses = await getKeyStatuses("ANTHROPIC_API_KEY");
    const oauthStatuses = await getKeyStatuses("CLAUDE_CODE_OAUTH_TOKEN");
    expect(anthStatuses.every((s) => s.keyType === "ANTHROPIC_API_KEY")).toBe(true);
    expect(oauthStatuses.every((s) => s.keyType === "CLAUDE_CODE_OAUTH_TOKEN")).toBe(true);
  });

  test("markKeyRateLimited increments rateLimitCount", async () => {
    const until = new Date(Date.now() + 600_000).toISOString();
    await markKeyRateLimited("ANTHROPIC_API_KEY", "bbb22", 1, until);
    const statuses = await getKeyStatuses("ANTHROPIC_API_KEY");
    const key1 = statuses.find((s) => s.keySuffix === "bbb22");
    expect(key1!.rateLimitCount).toBe(1);

    await markKeyRateLimited("ANTHROPIC_API_KEY", "bbb22", 1, until);
    const statuses2 = await getKeyStatuses("ANTHROPIC_API_KEY");
    const key1b = statuses2.find((s) => s.keySuffix === "bbb22");
    expect(key1b!.rateLimitCount).toBe(2);
  });

  test("clearKeyRateLimit clears a rate-limited key", async () => {
    const until = new Date(Date.now() + 300_000).toISOString();
    await recordKeyUsage("OPENAI_API_KEY", "oai01", 0, null);
    await markKeyRateLimited("OPENAI_API_KEY", "oai01", 0, until);

    let statuses = await getKeyStatuses("OPENAI_API_KEY");
    expect(statuses.find((s) => s.keySuffix === "oai01")!.status).toBe("rate_limited");

    const cleared = await clearKeyRateLimit("OPENAI_API_KEY", "oai01");
    expect(cleared).toBe(true);

    statuses = await getKeyStatuses("OPENAI_API_KEY");
    expect(statuses.find((s) => s.keySuffix === "oai01")!.status).toBe("available");
    expect(statuses.find((s) => s.keySuffix === "oai01")!.rateLimitedUntil).toBeNull();
  });

  test("clearKeyRateLimit returns false for already-available key", async () => {
    await recordKeyUsage("OPENAI_API_KEY", "oai02", 1, null);
    const cleared = await clearKeyRateLimit("OPENAI_API_KEY", "oai02");
    expect(cleared).toBe(false);
  });

  const codexStatus = async (keySuffix: string) =>
    (await getKeyStatuses("CODEX_OAUTH")).find((s) => s.keySuffix === keySuffix)!;
  const DAY_MS = 24 * 60 * 60 * 1000;
  /** The fence a runner reads with its key draw, or codex-login before its credential write. */
  const readFence = async () => (await getAvailableKeyIndices("CODEX_OAUTH", 1)).authFailureFence;
  const clearWithFence = async (keySuffix: string, authFence: number, keyIndex?: number) =>
    clearKeyRateLimit("CODEX_OAUTH", keySuffix, "global", null, {
      clearAuthBench: true,
      authFence,
      keyIndex,
    });

  test("recordKeyAuthFailure: 1 failure counts but does not bench", async () => {
    const result = await recordKeyAuthFailure("CODEX_OAUTH", "cdx01", 0);
    expect(result).toEqual({ consecutiveAuthFailures: 1, benched: false, rateLimitedUntil: null });

    const row = await codexStatus("cdx01");
    expect(row.consecutiveAuthFailures).toBe(1);
    expect(row.lastAuthFailureAt).not.toBeNull();
    expect(row.status).toBe("available");
    const { availableIndices } = await getAvailableKeyIndices("CODEX_OAUTH", 3);
    expect(availableIndices).toContain(0);
  });

  test("recordKeyAuthFailure: 2 failures in a row bench for 365 days", async () => {
    const result = await recordKeyAuthFailure("CODEX_OAUTH", "cdx01", 0);
    expect(result.consecutiveAuthFailures).toBe(2);
    expect(result.benched).toBe(true);

    const row = await codexStatus("cdx01");
    expect(row.status).toBe("rate_limited");
    expect(row.rateLimitedUntil).toBe(result.rateLimitedUntil);
    expect(Math.abs(Date.parse(row.rateLimitedUntil!) - (Date.now() + 365 * DAY_MS))).toBeLessThan(
      60_000,
    );
    expect(row.lastRateLimitAt).not.toBeNull();

    const marker = await getKv("codex-auth-watch", "bench:cdx01");
    expect(marker).not.toBeNull();
    expect(marker!.value).toMatchObject({
      keyIndex: 0,
      keyType: "CODEX_OAUTH",
      benchedUntil: row.rateLimitedUntil,
      source: "report-auth-failure",
    });

    const { availableIndices } = await getAvailableKeyIndices("CODEX_OAUTH", 3);
    expect(availableIndices).not.toContain(0);
  });

  test("recordKeyAuthFailure only extends an existing longer bench", async () => {
    const farUntil = new Date(Date.now() + 400 * DAY_MS).toISOString();
    await markKeyRateLimited("CODEX_OAUTH", "cdx02", 1, farUntil);
    await recordKeyAuthFailure("CODEX_OAUTH", "cdx02", 1);
    const result = await recordKeyAuthFailure("CODEX_OAUTH", "cdx02", 1);
    expect(result.benched).toBe(true);
    expect(result.rateLimitedUntil).toBe(farUntil);
    expect((await codexStatus("cdx02")).rateLimitedUntil).toBe(farUntil);
  });

  test("a success between auth failures resets the run", async () => {
    await recordKeyAuthFailure("CODEX_OAUTH", "cdx03", 2);
    await clearWithFence("cdx03", await readFence());
    const result = await recordKeyAuthFailure("CODEX_OAUTH", "cdx03", 2);
    expect(result.benched).toBe(false);

    const row = await codexStatus("cdx03");
    expect(row.status).toBe("available");
    expect(row.consecutiveAuthFailures).toBe(1);
  });

  test("clearKeyRateLimit without clearAuthBench cannot lift an auth bench", async () => {
    const cleared = await clearKeyRateLimit("CODEX_OAUTH", "cdx01");
    expect(cleared).toBe(false);
    expect((await codexStatus("cdx01")).status).toBe("rate_limited");
  });

  test("clearKeyRateLimit with clearAuthBench but no fence cannot lift an auth bench", async () => {
    const cleared = await clearKeyRateLimit("CODEX_OAUTH", "cdx01", "global", null, {
      clearAuthBench: true,
    });
    expect(cleared).toBe(false);
    const row = await codexStatus("cdx01");
    expect(row.status).toBe("rate_limited");
    expect(row.consecutiveAuthFailures).toBe(2);
  });

  test("clearKeyRateLimit with clearAuthBench and a current fence lifts an auth bench", async () => {
    const cleared = await clearWithFence("cdx01", await readFence());
    expect(cleared).toBe(true);

    const row = await codexStatus("cdx01");
    expect(row.status).toBe("available");
    expect(row.rateLimitedUntil).toBeNull();
    expect(row.consecutiveAuthFailures).toBe(0);
    expect(await getKv("codex-auth-watch", "bench:cdx01")).toBeNull();
  });

  test("clearKeyRateLimit without clearAuthBench still clears a plain rate limit", async () => {
    const until = new Date(Date.now() + 300_000).toISOString();
    await markKeyRateLimited("CODEX_OAUTH", "cdx04", 3, until);
    const cleared = await clearKeyRateLimit("CODEX_OAUTH", "cdx04");
    expect(cleared).toBe(true);
    expect((await codexStatus("cdx04")).status).toBe("available");
  });

  test("an ordinary rate limit and its expiry do not undo an auth bench", async () => {
    await recordKeyAuthFailure("CODEX_OAUTH", "cdx05", 4);
    const benched = await recordKeyAuthFailure("CODEX_OAUTH", "cdx05", 4);
    expect(benched.benched).toBe(true);

    const expired = new Date(Date.now() - 1_000).toISOString();
    await markKeyRateLimited("CODEX_OAUTH", "cdx05", 4, expired);

    const row = await codexStatus("cdx05");
    expect(row.status).toBe("rate_limited");
    expect(row.rateLimitedUntil).toBe(benched.rateLimitedUntil);
    const { availableIndices } = await getAvailableKeyIndices("CODEX_OAUTH", 5);
    expect(availableIndices).not.toContain(4);
    expect((await codexStatus("cdx05")).status).toBe("rate_limited");
  });

  test("an expired stored auth bench does not auto-clear", async () => {
    await recordKeyAuthFailure("CODEX_OAUTH", "cdx06", 1);
    expect((await recordKeyAuthFailure("CODEX_OAUTH", "cdx06", 1)).benched).toBe(true);
    const past = new Date(Date.now() - 60_000).toISOString();
    await getDbClient().run(
      `UPDATE api_key_status SET rateLimitedUntil = ? WHERE keyType = 'CODEX_OAUTH' AND keySuffix = 'cdx06'`,
      [past],
    );

    const { availableIndices } = await getAvailableKeyIndices("CODEX_OAUTH", 5);
    expect(availableIndices).not.toContain(1);
    const row = await codexStatus("cdx06");
    expect(row.status).toBe("rate_limited");
    expect(row.rateLimitedUntil).toBe(past);
    expect(row.consecutiveAuthFailures).toBe(2);
    expect(await getKv("codex-auth-watch", "bench:cdx06")).not.toBeNull();
  });

  test("each auth failure gets a higher server-side order than the last fence", async () => {
    const before = await readFence();
    await recordKeyAuthFailure("CODEX_OAUTH", "seq01", 4);
    const afterFirst = await readFence();
    await recordKeyAuthFailure("CODEX_OAUTH", "seq02", 4);
    expect(afterFirst).toBeGreaterThan(before);
    expect(await readFence()).toBeGreaterThan(afterFirst);
  });

  test("two runners: a late success fenced before the other runner's failures keeps the bench", async () => {
    // Runner A draws the key (reads the fence) and later succeeds. Worker clocks play no
    // part: whatever A's clock says, only the server-side order decides.
    const fenceA = await readFence();
    // Runner B then fails twice on the same login and benches it.
    await recordKeyAuthFailure("CODEX_OAUTH", "cdx07", 2);
    expect((await recordKeyAuthFailure("CODEX_OAUTH", "cdx07", 2)).benched).toBe(true);
    // A's success reset lands last.
    expect(await clearWithFence("cdx07", fenceA)).toBe(false);
    let row = await codexStatus("cdx07");
    expect(row.status).toBe("rate_limited");
    expect(row.consecutiveAuthFailures).toBe(2);
    expect(await getKv("codex-auth-watch", "bench:cdx07")).not.toBeNull();

    // A success from a task drawn after the failures still lifts it.
    expect(await clearWithFence("cdx07", await readFence())).toBe(true);
    row = await codexStatus("cdx07");
    expect(row.status).toBe("available");
    expect(row.consecutiveAuthFailures).toBe(0);
  });

  test("a clock rollback (restart or skew) cannot reorder a success before later failures", async () => {
    const staleFence = await readFence();
    // The failures are recorded while every clock in the process reads an hour earlier.
    const realNow = Date.now;
    Date.now = () => realNow() - 3_600_000;
    try {
      await recordKeyAuthFailure("CODEX_OAUTH", "cdx09", 4);
      await recordKeyAuthFailure("CODEX_OAUTH", "cdx09", 4);
    } finally {
      Date.now = realNow;
    }
    expect(await readFence()).toBeGreaterThan(staleFence);
    expect(await clearWithFence("cdx09", staleFence)).toBe(false);
    const row = await codexStatus("cdx09");
    expect(row.status).toBe("rate_limited");
    expect(row.consecutiveAuthFailures).toBe(2);
  });

  test("a stale success does not reset a count below the threshold", async () => {
    const staleFence = await readFence();
    await recordKeyAuthFailure("CODEX_OAUTH", "cdx08", 3);
    await clearWithFence("cdx08", staleFence);
    expect((await codexStatus("cdx08")).consecutiveAuthFailures).toBe(1);
  });

  test("a late re-login clear keeps failures recorded after the credential write", async () => {
    // The login was benched before the re-login.
    await recordKeyAuthFailure("CODEX_OAUTH", "rel01", 1);
    await recordKeyAuthFailure("CODEX_OAUTH", "rel01", 1);
    // codex-login reads the fence, then stores the fresh credentials.
    const fence = await readFence();
    // Two tasks fail on the fresh login before the clear request lands.
    await recordKeyAuthFailure("CODEX_OAUTH", "rel01", 1);
    await recordKeyAuthFailure("CODEX_OAUTH", "rel01", 1);
    await clearWithFence("rel01", fence, 1);
    const row = await codexStatus("rel01");
    expect(row.status).toBe("rate_limited");
    expect(row.consecutiveAuthFailures).toBe(4);
    expect(await getKv("codex-auth-watch", "bench:rel01")).not.toBeNull();
  });

  test("a re-login clear lifts the bench recorded before the credential write", async () => {
    await recordKeyAuthFailure("CODEX_OAUTH", "rel02", 2);
    await recordKeyAuthFailure("CODEX_OAUTH", "rel02", 2);
    expect(await clearWithFence("rel02", await readFence(), 2)).toBe(true);
    const row = await codexStatus("rel02");
    expect(row.status).toBe("available");
    expect(row.consecutiveAuthFailures).toBe(0);
    expect(await getKv("codex-auth-watch", "bench:rel02")).toBeNull();
  });

  test("a slot re-login with a different account retires the previous login's bench", async () => {
    await recordKeyAuthFailure("CODEX_OAUTH", "old01", 0);
    await recordKeyAuthFailure("CODEX_OAUTH", "old01", 0);
    expect(await getKv("codex-auth-watch", "bench:old01")).not.toBeNull();

    const cleared = await clearWithFence("new01", await readFence(), 0);
    expect(cleared).toBe(true);
    await recordKeyUsage("CODEX_OAUTH", "new01", 0, null);

    const old = await codexStatus("old01");
    expect(old.status).toBe("available");
    expect(old.rateLimitedUntil).toBeNull();
    expect(old.consecutiveAuthFailures).toBe(0);
    expect(await getKv("codex-auth-watch", "bench:old01")).toBeNull();
    const { availableIndices } = await getAvailableKeyIndices("CODEX_OAUTH", 5);
    expect(availableIndices).toContain(0);
  });

  test("a clear without keyIndex leaves other logins at the same index alone", async () => {
    await recordKeyAuthFailure("CODEX_OAUTH", "old02", 3);
    await recordKeyAuthFailure("CODEX_OAUTH", "old02", 3);
    await clearWithFence("new02", await readFence());
    expect((await codexStatus("old02")).status).toBe("rate_limited");
  });

  test("an ordinary rate limit longer than the auth bench still applies", async () => {
    const farUntil = new Date(Date.now() + 500 * DAY_MS).toISOString();
    await markKeyRateLimited("CODEX_OAUTH", "cdx05", 4, farUntil);
    expect((await codexStatus("cdx05")).rateLimitedUntil).toBe(farUntil);
  });

  test("recordKeyRateLimitWindows persists latest provider windows", async () => {
    await recordKeyRateLimitWindows("ANTHROPIC_API_KEY", "aaa11", 0, {
      seven_day: {
        status: "allowed_warning",
        utilization: 0.82,
        resetsAt: 1781334000,
        isUsingOverage: false,
        surpassedThreshold: 0.75,
        lastSeenAt: "2026-06-12T00:00:00.000Z",
      },
    });

    const key = (await getKeyStatuses("ANTHROPIC_API_KEY")).find((s) => s.keySuffix === "aaa11");
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

  test("recordKeyRateLimitWindows merges with existing provider windows", async () => {
    await recordKeyRateLimitWindows("ANTHROPIC_API_KEY", "aaa11", 0, {
      seven_day: {
        status: "allowed_warning",
        utilization: 0.82,
        resetsAt: 1781334000,
        lastSeenAt: "2026-06-12T00:00:00.000Z",
      },
    });

    await recordKeyRateLimitWindows("ANTHROPIC_API_KEY", "aaa11", 0, {
      five_hour: {
        status: "allowed",
        utilization: 0.2,
        resetsAt: 1781270000,
        lastSeenAt: "2026-06-12T01:00:00.000Z",
      },
    });

    const key = (await getKeyStatuses("ANTHROPIC_API_KEY")).find((s) => s.keySuffix === "aaa11");
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

  describe("getAvailableKeyIndices — model-scoped window filtering", () => {
    const KEY_TYPE = "CLAUDE_CODE_OAUTH_TOKEN";

    test("model=fable omits an index with an active Fable block and reports it in modelBlockedIndices", async () => {
      await recordKeyUsage(KEY_TYPE, "fbl01", 0, null);
      const futureResetsAtSec = Math.floor(Date.now() / 1000) + 3600;
      await recordKeyRateLimitWindows(KEY_TYPE, "fbl01", 0, {
        seven_day_overage_included: {
          status: "rejected",
          resetsAt: futureResetsAtSec,
          lastSeenAt: new Date().toISOString(),
        },
      });

      const result = await getAvailableKeyIndices(KEY_TYPE, 1, "global", null, "fable");
      expect(result.availableIndices).not.toContain(0);
      expect(result.modelBlockedIndices).toEqual([0]);
      expect(result.earliestModelResetAt).toBe(new Date(futureResetsAtSec * 1000).toISOString());
    });

    test("model=opus includes the same index (block is Fable-only)", async () => {
      const result = await getAvailableKeyIndices(KEY_TYPE, 1, "global", null, "opus");
      expect(result.availableIndices).toContain(0);
      expect(result.modelBlockedIndices).toEqual([]);
    });

    test("no model param includes the index (legacy behavior, no filtering)", async () => {
      const result = await getAvailableKeyIndices(KEY_TYPE, 1, "global", null);
      expect(result.availableIndices).toContain(0);
      expect(result.modelBlockedIndices).toEqual([]);
      expect(result.earliestModelResetAt).toBeNull();
    });

    test("a row with resetsAt in the past is included for model=fable", async () => {
      const pastResetsAtSec = Math.floor(Date.now() / 1000) - 3600;
      await recordKeyRateLimitWindows(KEY_TYPE, "fbl01", 0, {
        seven_day_overage_included: {
          status: "rejected",
          resetsAt: pastResetsAtSec,
          lastSeenAt: new Date().toISOString(),
        },
      });

      const result = await getAvailableKeyIndices(KEY_TYPE, 1, "global", null, "fable");
      expect(result.availableIndices).toContain(0);
      expect(result.modelBlockedIndices).toEqual([]);
    });

    test("a key-wide rate_limited status and an active model block coexist without double-listing", async () => {
      await recordKeyUsage(KEY_TYPE, "fbl02", 1, null);
      const until = new Date(Date.now() + 300_000).toISOString();
      await markKeyRateLimited(KEY_TYPE, "fbl02", 1, until);
      const futureResetsAtSec = Math.floor(Date.now() / 1000) + 3600;
      await recordKeyRateLimitWindows(KEY_TYPE, "fbl02", 1, {
        seven_day_overage_included: {
          status: "rejected",
          resetsAt: futureResetsAtSec,
          lastSeenAt: new Date().toISOString(),
        },
      });

      const result = await getAvailableKeyIndices(KEY_TYPE, 2, "global", null, "fable");
      // Key-wide blocked: absent from availableIndices, and not double-reported in modelBlockedIndices.
      expect(result.availableIndices).not.toContain(1);
      expect(result.modelBlockedIndices).not.toContain(1);
    });

    test("concurrent Fable and Opus rejections for one key both survive", async () => {
      // Own scope so rows from the tests above do not share keyIndex 0.
      const scopeId = "race-concurrent";
      const futureResetsAtSec = Math.floor(Date.now() / 1000) + 3600;
      const lastSeenAt = new Date().toISOString();
      await Promise.all([
        recordKeyRateLimitWindows(
          KEY_TYPE,
          "rac01",
          0,
          {
            seven_day_overage_included: {
              status: "rejected",
              resetsAt: futureResetsAtSec,
              lastSeenAt,
            },
          },
          "agent",
          scopeId,
        ),
        recordKeyRateLimitWindows(
          KEY_TYPE,
          "rac01",
          0,
          { seven_day_opus: { status: "rejected", resetsAt: futureResetsAtSec, lastSeenAt } },
          "agent",
          scopeId,
        ),
      ]);

      const [key] = await getKeyStatuses(KEY_TYPE, "agent", scopeId);
      expect(Object.keys(key?.rateLimitWindows ?? {}).sort()).toEqual([
        "seven_day_opus",
        "seven_day_overage_included",
      ]);
      const fable = await getAvailableKeyIndices(KEY_TYPE, 1, "agent", scopeId, "fable");
      expect(fable.availableIndices).toEqual([]);
      const opus = await getAvailableKeyIndices(KEY_TYPE, 1, "agent", scopeId, "opus");
      expect(opus.availableIndices).toEqual([]);
    });

    test("an older allowed snapshot after a terminal rejection does not reopen the window", async () => {
      const scopeId = "race-freshness";
      const futureResetsAtSec = Math.floor(Date.now() / 1000) + 3600;
      const rejectedAt = new Date().toISOString();
      const olderSnapshotAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      await recordKeyRateLimitWindows(
        KEY_TYPE,
        "rac02",
        0,
        {
          seven_day_overage_included: {
            status: "rejected",
            resetsAt: futureResetsAtSec,
            lastSeenAt: rejectedAt,
          },
        },
        "agent",
        scopeId,
      );
      // Another worker's session reports telemetry read before the rejection.
      await recordKeyRateLimitWindows(
        KEY_TYPE,
        "rac02",
        0,
        {
          seven_day_overage_included: {
            status: "allowed",
            utilization: 0.4,
            resetsAt: futureResetsAtSec,
            lastSeenAt: olderSnapshotAt,
          },
          five_hour: { status: "allowed", utilization: 0.1, lastSeenAt: olderSnapshotAt },
        },
        "agent",
        scopeId,
      );

      const [key] = await getKeyStatuses(KEY_TYPE, "agent", scopeId);
      expect(key?.rateLimitWindows.seven_day_overage_included?.status).toBe("rejected");
      // The older payload's other windows still land.
      expect(key?.rateLimitWindows.five_hour?.status).toBe("allowed");
      const fable = await getAvailableKeyIndices(KEY_TYPE, 1, "agent", scopeId, "fable");
      expect(fable.availableIndices).toEqual([]);

      // A snapshot observed after the rejection is an explicit recovery.
      await recordKeyRateLimitWindows(
        KEY_TYPE,
        "rac02",
        0,
        {
          seven_day_overage_included: {
            status: "allowed",
            utilization: 0.1,
            resetsAt: futureResetsAtSec,
            lastSeenAt: new Date(Date.now() + 1000).toISOString(),
          },
        },
        "agent",
        scopeId,
      );
      const recovered = await getAvailableKeyIndices(KEY_TYPE, 1, "agent", scopeId, "fable");
      expect(recovered.availableIndices).toEqual([0]);
    });

    describe("seat filtering", () => {
      // Own scope so the rows above do not leak into these counts.
      const scope = "agent";
      const scopeId = "seat-filter";

      beforeAll(async () => {
        await recordKeyUsage(KEY_TYPE, "seat0", 0, null, scope, scopeId);
        await setApiKeyPlan(KEY_TYPE, "seat0", "claude_team_standard");
        await recordKeyUsage(KEY_TYPE, "seat1", 1, null, scope, scopeId);
      });

      test("a claude_team_standard key is seat-blocked for fable", async () => {
        const result = await getAvailableKeyIndices(KEY_TYPE, 2, scope, scopeId, "fable");
        expect(result.availableIndices).toEqual([1]);
        expect(result.seatBlockedIndices).toEqual([0]);
      });

      test("the same key is available for opus and for no model", async () => {
        const opus = await getAvailableKeyIndices(KEY_TYPE, 2, scope, scopeId, "opus");
        expect(opus.availableIndices).toEqual([0, 1]);
        expect(opus.seatBlockedIndices).toEqual([]);
        const none = await getAvailableKeyIndices(KEY_TYPE, 2, scope, scopeId);
        expect(none.availableIndices).toEqual([0, 1]);
        expect(none.seatBlockedIndices).toEqual([]);
      });

      test("a key with no plan is available for fable", async () => {
        const result = await getAvailableKeyIndices(KEY_TYPE, 2, scope, scopeId, "fable");
        expect(result.availableIndices).toContain(1);
        expect(result.seatBlockedIndices).not.toContain(1);
      });

      test("a rate-limited standard-seat key stays seat-blocked", async () => {
        const otherScopeId = "seat-filter-rl";
        await recordKeyUsage(KEY_TYPE, "seat2", 0, null, scope, otherScopeId);
        await setApiKeyPlan(KEY_TYPE, "seat2", "claude_team_standard");
        await markKeyRateLimited(
          KEY_TYPE,
          "seat2",
          0,
          new Date(Date.now() + 3600_000).toISOString(),
          scope,
          otherScopeId,
        );
        const result = await getAvailableKeyIndices(KEY_TYPE, 1, scope, otherScopeId, "fable");
        expect(result.availableIndices).toEqual([]);
        expect(result.seatBlockedIndices).toEqual([0]);
        expect(result.modelBlockedIndices).toEqual([]);

        // Admission must not fall back to the key-wide-blocked seat.
        await expect(
          resolveCredentialPools(
            { CLAUDE_CODE_OAUTH_TOKEN: "tok-seat2" },
            {
              provider: "claude",
              model: "claude-fable-5-1",
              availableIndicesMap: { CLAUDE_CODE_OAUTH_TOKEN: result },
              enforceModelCapacity: true,
            },
          ),
        ).rejects.toBeInstanceOf(ModelWindowExhaustedError);
      });

      test("a Fable-window-blocked standard-seat key stays seat-blocked", async () => {
        const otherScopeId = "seat-filter-window";
        await recordKeyUsage(KEY_TYPE, "seat3", 0, null, scope, otherScopeId);
        await setApiKeyPlan(KEY_TYPE, "seat3", "claude_team_standard");
        await recordKeyRateLimitWindows(
          KEY_TYPE,
          "seat3",
          0,
          {
            seven_day_overage_included: {
              status: "rejected",
              resetsAt: Math.floor(Date.now() / 1000) + 3600,
              lastSeenAt: new Date().toISOString(),
            },
          },
          scope,
          otherScopeId,
        );
        const result = await getAvailableKeyIndices(KEY_TYPE, 1, scope, otherScopeId, "fable");
        expect(result.availableIndices).toEqual([]);
        expect(result.modelBlockedIndices).toEqual([0]);
        expect(result.seatBlockedIndices).toEqual([0]);

        // The window-block fallback policy never applies to a seat block.
        await expect(
          resolveCredentialPools(
            { CLAUDE_CODE_OAUTH_TOKEN: "tok-seat3", MODEL_WINDOW_EXHAUSTED_POLICY: "fallback" },
            {
              provider: "claude",
              model: "claude-fable-5-1",
              availableIndicesMap: { CLAUDE_CODE_OAUTH_TOKEN: result },
              enforceModelCapacity: true,
            },
          ),
        ).rejects.toBeInstanceOf(ModelWindowExhaustedError);
      });

      test("earliestModelResetAt stays null when only seat blocks exist", async () => {
        const result = await getAvailableKeyIndices(KEY_TYPE, 2, scope, scopeId, "fable");
        expect(result.seatBlockedIndices).toEqual([0]);
        expect(result.earliestModelResetAt).toBeNull();
      });
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
