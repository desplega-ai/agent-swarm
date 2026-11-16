/**
 * P4: the API-server quota probe. Due-selection, header parsing, and the
 * 200 / 429 / 401 / 403 write paths against a real SQLite file, with an
 * injected fetch so no request leaves the process.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDbClient, getKeyStatuses, initDb, recordKeyRateLimitWindows } from "../be/db";
import {
  CLAUDE_QUOTA_KEY_TYPE,
  parseQuotaProbeHeaders,
  selectDueQuotaProbeKeys,
  sweepClaudeQuotaProbe,
} from "../http/claude-quota-probe";
import type { RateLimitWindowTelemetry } from "../utils/error-tracker";

const TEST_DB = `./test-claude-quota-probe-${Date.now()}.sqlite`;
// Real time: the route sanitizers clamp a future lastSeenAt against Date.now().
const NOW = Math.floor(Date.now() / 1000) * 1000;
const NOW_SEC = NOW / 1000;
const ago = (mins: number) => new Date(NOW - mins * 60_000).toISOString();

function fiveHour(lastSeenMinsAgo: number, resetsInSec: number, status = "allowed") {
  return {
    five_hour: {
      status,
      utilization: 0.4,
      resetsAt: NOW_SEC + resetsInSec,
      lastSeenAt: ago(lastSeenMinsAgo),
      durationMins: 300,
      source: "claude" as const,
    },
  };
}

function row(keySuffix: string, rateLimitWindows: RateLimitWindowTelemetry) {
  return { keySuffix, rateLimitWindows };
}

describe("selectDueQuotaProbeKeys", () => {
  const members = ["tok-aaaaa", "tok-bbbbb", "tok-ccccc", "tok-ddddd", "tok-eeeee"];

  test("keeps a stale, open, unblocked key and drops every other combination", () => {
    const due = selectDueQuotaProbeKeys(
      members,
      [
        row("aaaaa", fiveHour(20, 3600)), // stale + open -> due
        row("bbbbb", fiveHour(5, 3600)), // fresh -> skip
        row("ccccc", fiveHour(20, -60)), // window closed -> skip (no new window)
        row("ddddd", {
          ...fiveHour(20, 3600),
          seven_day: { status: "rejected", resetsAt: NOW_SEC + 600, lastSeenAt: ago(20) },
        }), // blocked -> skip
        // eeeee: no row, so no lastSeenAt and no open window -> skip
      ],
      NOW,
    );
    expect(due.map((d) => d.keySuffix)).toEqual(["aaaaa"]);
    expect(due[0]).toMatchObject({ keyIndex: 0, token: "tok-aaaaa" });
  });

  test("a rejected window whose reset has passed does not block", () => {
    const due = selectDueQuotaProbeKeys(
      ["tok-aaaaa"],
      [
        row("aaaaa", {
          ...fiveHour(20, 3600),
          seven_day: { status: "rejected", resetsAt: NOW_SEC - 1, lastSeenAt: ago(60) },
        }),
      ],
      NOW,
    );
    expect(due).toHaveLength(1);
  });

  test("a five_hour window without lastSeenAt time or reset is not probed", () => {
    const due = selectDueQuotaProbeKeys(
      ["tok-aaaaa", "tok-bbbbb"],
      [
        row("aaaaa", { five_hour: { status: "allowed", lastSeenAt: "not-a-date" } }),
        row("bbbbb", {
          five_hour: { status: "allowed", resetsAt: NOW_SEC + 60, lastSeenAt: "not-a-date" },
        }),
      ],
      NOW,
    );
    // aaaaa has no reset (not open); bbbbb has an open window and an unparseable lastSeenAt (stale).
    expect(due.map((d) => d.keySuffix)).toEqual(["bbbbb"]);
  });

  test("caps at 10 per tick, oldest lastSeenAt first", () => {
    const pool = Array.from({ length: 14 }, (_, i) => `tok-k${String(i).padStart(4, "0")}`);
    const statuses = pool.map((tok, i) => row(tok.slice(-5), fiveHour(16 + i, 3600)));
    const due = selectDueQuotaProbeKeys(pool, statuses, NOW);
    expect(due).toHaveLength(10);
    expect(due.map((d) => d.keyIndex)).toEqual([13, 12, 11, 10, 9, 8, 7, 6, 5, 4]);
  });
});

describe("parseQuotaProbeHeaders", () => {
  const at = new Date(NOW).toISOString();

  test("maps both windows", () => {
    const windows = parseQuotaProbeHeaders(
      new Headers({
        "anthropic-ratelimit-unified-5h-utilization": "0.82",
        "anthropic-ratelimit-unified-5h-reset": String(NOW_SEC + 3600),
        "anthropic-ratelimit-unified-5h-status": "allowed_warning",
        "anthropic-ratelimit-unified-7d-utilization": "0.31",
        "anthropic-ratelimit-unified-7d-reset": String(NOW_SEC + 86400),
        "anthropic-ratelimit-unified-7d-status": "allowed",
      }),
      200,
      at,
    );
    expect(windows).toEqual({
      five_hour: {
        status: "allowed_warning",
        utilization: 0.82,
        resetsAt: NOW_SEC + 3600,
        lastSeenAt: at,
        durationMins: 300,
        source: "poll",
      },
      seven_day: {
        status: "allowed",
        utilization: 0.31,
        resetsAt: NOW_SEC + 86400,
        lastSeenAt: at,
        durationMins: 10080,
        source: "poll",
      },
    });
  });

  test("a missing utilization header is no window, never 0", () => {
    const windows = parseQuotaProbeHeaders(
      new Headers({
        "anthropic-ratelimit-unified-5h-reset": String(NOW_SEC + 3600),
        "anthropic-ratelimit-unified-7d-utilization": "0.5",
        "anthropic-ratelimit-unified-7d-reset": String(NOW_SEC + 86400),
      }),
      200,
      at,
    );
    expect(Object.keys(windows)).toEqual(["seven_day"]);
    expect(windows.seven_day?.status).toBe("allowed");
  });

  test("no headers at all is no data", () => {
    expect(parseQuotaProbeHeaders(new Headers(), 200, at)).toEqual({});
  });

  test("429 marks the representative-claim window rejected when no status says so", () => {
    const windows = parseQuotaProbeHeaders(
      new Headers({
        "anthropic-ratelimit-unified-5h-utilization": "0.6",
        "anthropic-ratelimit-unified-5h-reset": String(NOW_SEC + 3600),
        "anthropic-ratelimit-unified-5h-status": "allowed",
        "anthropic-ratelimit-unified-7d-reset": String(NOW_SEC + 86400),
        "anthropic-ratelimit-unified-7d-status": "allowed",
        "anthropic-ratelimit-unified-representative-claim": "seven_day",
      }),
      429,
      at,
    );
    expect(windows.five_hour?.status).toBe("allowed");
    expect(windows.seven_day).toMatchObject({ status: "rejected", resetsAt: NOW_SEC + 86400 });
    expect(windows.seven_day?.utilization).toBeUndefined();
  });
});

describe("parseQuotaProbeHeaders 429 claim (review B1)", () => {
  test("429 without status headers rejects only the claimed five_hour window", () => {
    const at = new Date(NOW).toISOString();
    const windows = parseQuotaProbeHeaders(
      new Headers({
        "anthropic-ratelimit-unified-5h-utilization": "1",
        "anthropic-ratelimit-unified-5h-reset": String(NOW_SEC + 3600),
        "anthropic-ratelimit-unified-7d-utilization": "0.2",
        "anthropic-ratelimit-unified-7d-reset": String(NOW_SEC + 86400),
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
      }),
      429,
      at,
    );
    expect(windows.five_hour).toMatchObject({ status: "rejected", utilization: 1 });
    expect(windows.seven_day).toMatchObject({ status: "allowed", utilization: 0.2 });
  });

  test("429 without claim or status headers rejects every window", () => {
    const at = new Date(NOW).toISOString();
    const windows = parseQuotaProbeHeaders(
      new Headers({
        "anthropic-ratelimit-unified-5h-utilization": "0.7",
        "anthropic-ratelimit-unified-5h-reset": String(NOW_SEC + 3600),
        "anthropic-ratelimit-unified-7d-utilization": "0.2",
        "anthropic-ratelimit-unified-7d-reset": String(NOW_SEC + 86400),
      }),
      429,
      at,
    );
    expect(windows.five_hour?.status).toBe("rejected");
    expect(windows.seven_day?.status).toBe("rejected");
  });
});

describe("sweepClaudeQuotaProbe", () => {
  const POOL = ["tok-key-00001", "tok-key-00002"];
  const calls: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];

  const fetchReturning = (byToken: Record<string, Response>): typeof fetch =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization");
      calls.push({ url: String(url), auth, body: JSON.parse(String(init?.body)) });
      const token = auth?.replace(/^Bearer /, "") ?? "";
      return byToken[token] ?? new Response("{}", { status: 500 });
    }) as typeof fetch;

  const seed = async (suffix: string, index: number) =>
    recordKeyRateLimitWindows(CLAUDE_QUOTA_KEY_TYPE, suffix, index, fiveHour(30, 3600));

  const windowsOf = async (suffix: string) =>
    (await getKeyStatuses(CLAUDE_QUOTA_KEY_TYPE, "global", null)).find(
      (r) => r.keySuffix === suffix,
    );

  beforeAll(() => {
    process.env.DB_PATH = TEST_DB;
    initDb(TEST_DB);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = POOL.join(",");
  });

  beforeEach(async () => {
    calls.length = 0;
    await getDbClient().run("DELETE FROM api_key_status");
  });

  afterAll(async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) await unlink(TEST_DB + suffix).catch(() => {});
  });

  test("200: sends the 1-token quota_check and writes poll windows", async () => {
    await seed("00001", 0);
    const result = await sweepClaudeQuotaProbe({
      now: () => NOW,
      model: "claude-haiku-test",
      fetchImpl: fetchReturning({
        "tok-key-00001": new Response("{}", {
          status: 200,
          headers: {
            "anthropic-ratelimit-unified-5h-utilization": "0.9",
            "anthropic-ratelimit-unified-5h-reset": String(NOW_SEC + 1800),
            "anthropic-ratelimit-unified-5h-status": "allowed_warning",
          },
        }),
      }),
    });
    expect(result).toMatchObject({ members: 2, due: 1, probed: 1 });
    expect(result.outcomes.written).toBe(1);
    expect(calls).toEqual([
      {
        url: "https://api.anthropic.com/v1/messages",
        auth: "Bearer tok-key-00001",
        body: {
          model: "claude-haiku-test",
          max_tokens: 1,
          messages: [{ role: "user", content: "quota" }],
        },
      },
    ]);
    const stored = await windowsOf("00001");
    expect(stored?.rateLimitWindows.five_hour).toMatchObject({
      status: "allowed_warning",
      utilization: 0.9,
      resetsAt: NOW_SEC + 1800,
      source: "poll",
      lastSeenAt: new Date(NOW).toISOString(),
    });
  });

  test("429: writes a rejected window, and the next tick skips the key", async () => {
    await seed("00001", 0);
    const limited = () =>
      new Response("{}", {
        status: 429,
        headers: {
          "anthropic-ratelimit-unified-5h-utilization": "1.0",
          "anthropic-ratelimit-unified-5h-reset": String(NOW_SEC + 1200),
        },
      });
    const first = await sweepClaudeQuotaProbe({
      now: () => NOW,
      fetchImpl: fetchReturning({ "tok-key-00001": limited() }),
    });
    expect(first.outcomes.rate_limited).toBe(1);
    expect((await windowsOf("00001"))?.rateLimitWindows.five_hour).toMatchObject({
      status: "rejected",
      resetsAt: NOW_SEC + 1200,
    });

    // 20 minutes later the value is stale again, but the reset is still ahead.
    const second = await sweepClaudeQuotaProbe({
      now: () => NOW + 16 * 60_000,
      fetchImpl: fetchReturning({ "tok-key-00001": limited() }),
    });
    expect(second.due).toBe(0);
    expect(calls).toHaveLength(1);
  });

  test("401: records the key status, writes no windows", async () => {
    await seed("00001", 0);
    const before = (await windowsOf("00001"))?.rateLimitWindows;
    const result = await sweepClaudeQuotaProbe({
      now: () => NOW,
      fetchImpl: fetchReturning({ "tok-key-00001": new Response("{}", { status: 401 }) }),
    });
    expect(result.outcomes.auth_failed).toBe(1);
    const after = await windowsOf("00001");
    expect(after?.rateLimitWindows).toEqual(before!);
    expect(after?.lastValidationError).toBe("HTTP 401");
  });

  test("403: writes no windows and does not mark the key bad", async () => {
    await seed("00002", 1);
    const before = (await windowsOf("00002"))?.rateLimitWindows;
    const result = await sweepClaudeQuotaProbe({
      now: () => NOW,
      fetchImpl: fetchReturning({ "tok-key-00002": new Response("{}", { status: 403 }) }),
    });
    expect(result.outcomes.auth_failed).toBe(1);
    const after = await windowsOf("00002");
    expect(after?.rateLimitWindows).toEqual(before!);
    expect(after?.lastValidationError).toBeNull();
  });

  test("200 without headers writes nothing", async () => {
    await seed("00001", 0);
    const before = (await windowsOf("00001"))?.rateLimitWindows;
    const result = await sweepClaudeQuotaProbe({
      now: () => NOW,
      fetchImpl: fetchReturning({ "tok-key-00001": new Response("{}", { status: 200 }) }),
    });
    expect(result.outcomes.no_data).toBe(1);
    expect((await windowsOf("00001"))?.rateLimitWindows).toEqual(before!);
  });
});
