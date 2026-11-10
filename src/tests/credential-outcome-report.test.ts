import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { reportCredentialOutcomeThenFinish } from "../commands/credential-outcome-report";
import { type ApiConfig, ensureTaskFinished } from "../commands/runner";
import type { ProviderResult } from "../providers/types";
import { resolveCredentialPools } from "../utils/credentials";

/**
 * Completion-path regression for a `credits_required` seat mismatch. The
 * runner finishes every task through `reportCredentialOutcomeThenFinish`,
 * so this drives the same function with the runner's real
 * `ensureTaskFinished` as the finish step. It asserts that a delayed seat
 * report lands before `POST /api/tasks/:id/finish`, and that no key-wide
 * `/api/keys/report-rate-limit` is sent.
 */

interface RecordedRequest {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  at: number;
}

const SEAT_REPORT_DELAY_MS = 150;
let requests: RecordedRequest[] = [];
let seatReportRespondedAt: number | undefined;
let keyReportRespondedAt: number | undefined;
let originalFetch: typeof fetch;
let failKeyReport = false;

beforeAll(() => {
  originalFetch = globalThis.fetch;
  // Records each request when the fetch starts, so a fire-and-forget report
  // is visible to the assertions even if nobody awaits it.
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    const rawBody = typeof init?.body === "string" ? init.body : "";
    requests.push({ method, path, body: rawBody ? JSON.parse(rawBody) : null, at: Date.now() });

    if (path === "/api/keys/report-seat-mismatch") {
      await Bun.sleep(SEAT_REPORT_DELAY_MS);
      seatReportRespondedAt = Date.now();
      return Response.json({ success: true, message: "recorded" });
    }
    if (path === "/api/keys/report-rate-limit") {
      if (failKeyReport) return Response.json({ error: "db busy" }, { status: 503 });
      await Bun.sleep(SEAT_REPORT_DELAY_MS);
      keyReportRespondedAt = Date.now();
      return Response.json({ success: true });
    }
    if (method === "POST" && /^\/api\/tasks\/[^/]+\/finish$/.test(path)) {
      return Response.json({ success: true, task: { status: "failed" } });
    }
    return Response.json({ success: true });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  requests = [];
  seatReportRespondedAt = undefined;
  keyReportRespondedAt = undefined;
  failKeyReport = false;
});

const apiConfig: ApiConfig = {
  apiUrl: "http://credential-outcome-report.test",
  apiKey: "example-test-key",
  agentId: "00000000-0000-4000-8000-000000000001",
};

const credentialInfo = { keyType: "CLAUDE_CODE_OAUTH_TOKEN", keySuffix: "TJAAA", keyIndex: 3 };

async function completeTask(taskId: string, result: ProviderResult, model: string) {
  const modelWindowBlocks = new Map<string, number>();
  await reportCredentialOutcomeThenFinish(
    {
      apiUrl: apiConfig.apiUrl,
      apiKey: apiConfig.apiKey,
      credentialInfo,
      result,
      failureReason: result.failureReason,
      model,
      codexCreditsExhaustedCooldownMs: 2 * 60 * 60 * 1000,
      modelWindowBlocks,
    },
    () =>
      ensureTaskFinished(
        apiConfig,
        "worker",
        taskId,
        result.exitCode,
        result.failureReason,
        undefined,
        "claude",
      ),
  );
  return { modelWindowBlocks };
}

describe("reportCredentialOutcomeThenFinish — credits_required seat mismatch", () => {
  const cases: Array<{ name: string; result: Omit<ProviderResult, "exitCode" | "isError"> }> = [
    {
      name: "failure text",
      result: {
        sessionId: "session-1",
        failureReason: "Fable 5.1 requires usage credits. Switch to another model to continue.",
      },
    },
    {
      name: "structured credits_required event",
      result: {
        sessionId: "session-2",
        failureReason: "Claude process exited with code 1",
        creditsRequired: {
          observedAt: new Date().toISOString(),
          overageDisabledReason: "member_zero_credit_limit",
        },
      },
    },
  ];

  for (const { name, result } of cases) {
    test(`${name}: seat report lands before /finish and no key-wide report is sent`, async () => {
      const taskId = "11111111-1111-4111-8111-111111111111";
      const { modelWindowBlocks } = await completeTask(
        taskId,
        { exitCode: 1, isError: true, ...result },
        "claude-fable-5-1",
      );

      const seatReports = requests.filter((r) => r.path === "/api/keys/report-seat-mismatch");
      expect(seatReports).toHaveLength(1);
      expect(seatReports[0]?.method).toBe("POST");
      expect(seatReports[0]?.body).toEqual({
        keyType: "CLAUDE_CODE_OAUTH_TOKEN",
        keySuffix: "TJAAA",
        keyIndex: 3,
        model: "fable",
      });

      const finish = requests.find((r) => r.path === `/api/tasks/${taskId}/finish`);
      expect(finish).toBeDefined();
      expect(seatReportRespondedAt).toBeDefined();
      expect(finish!.at).toBeGreaterThanOrEqual(seatReportRespondedAt!);

      expect(requests.some((r) => r.path === "/api/keys/report-rate-limit")).toBe(false);
      expect(modelWindowBlocks.size).toBe(0);
    });
  }
});

describe("reportCredentialOutcomeThenFinish — seat mismatch after a key-wide rejection", () => {
  test("the earlier key-wide rejection is still reported next to the seat report", async () => {
    const taskId = "22222222-2222-4222-8222-222222222222";
    const rateLimitResetAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    await completeTask(
      taskId,
      {
        exitCode: 1,
        isError: true,
        sessionId: "session-3",
        failureReason: "Claude process exited with code 1",
        rateLimitResetAt,
        creditsRequired: {
          observedAt: new Date().toISOString(),
          overageDisabledReason: "member_zero_credit_limit",
        },
      },
      "claude-fable-5-1",
    );

    expect(requests.filter((r) => r.path === "/api/keys/report-seat-mismatch")).toHaveLength(1);
    const keyReports = requests.filter((r) => r.path === "/api/keys/report-rate-limit");
    expect(keyReports).toHaveLength(1);
    expect(keyReports[0]?.body).toMatchObject({ keyIndex: 3, rateLimitedUntil: rateLimitResetAt });
  });
});

describe("reportCredentialOutcomeThenFinish — key-wide rate limit", () => {
  test("the key's bench lands before the finish step, which may resume on another key", async () => {
    const taskId = "33333333-3333-4333-8333-333333333333";
    await completeTask(
      taskId,
      {
        exitCode: 1,
        isError: true,
        sessionId: "session-4",
        failureReason: "You've hit your weekly limit · resets 5pm (UTC)",
      },
      "claude-opus-5-5",
    );

    expect(requests.filter((r) => r.path === "/api/keys/report-rate-limit")).toHaveLength(1);
    const finish = requests.find((r) => r.path === `/api/tasks/${taskId}/finish`);
    expect(finish).toBeDefined();
    expect(keyReportRespondedAt).toBeDefined();
    expect(finish!.at).toBeGreaterThanOrEqual(keyReportRespondedAt!);
  });
});

describe("reportCredentialOutcomeThenFinish — lost key bench write", () => {
  test("logs the failed write and keeps the failed key out of the resume's draw", async () => {
    failKeyReport = true;
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { modelWindowBlocks } = await completeTask(
        "44444444-4444-4444-8444-444444444444",
        {
          exitCode: 1,
          isError: true,
          sessionId: "session-5",
          failureReason: "You've hit your weekly limit · resets 5pm (UTC)",
        },
        "claude-opus-5-5",
      );
      const logged = (spy: typeof log) => spy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged(log)).not.toContain("Reported key");
      expect(logged(warn)).toContain("Failed to report key ...TJAAA as rate-limited: HTTP 503");

      // The resume draws from a pool where the API still lists every key, and
      // again where the availability read failed too. Neither may pick key 3.
      const pool = ["t-AAAAA", "t-BBBBB", "t-CCCCC", "t-TJAAA"];
      for (const availableIndicesMap of [
        { [credentialInfo.keyType]: { availableIndices: [0, 1, 2, 3] } },
        {},
      ]) {
        for (let draw = 0; draw < 40; draw++) {
          const env: Record<string, string | undefined> = {
            [credentialInfo.keyType]: pool.join(","),
          };
          const [selection] = await resolveCredentialPools(env, {
            provider: "claude",
            model: "claude-opus-5-5",
            availableIndicesMap,
            localBlocks: modelWindowBlocks,
          });
          expect(selection?.index).not.toBe(3);
        }
      }
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });
});

test.each(["account", "removal"])("reports %s without window measurements", async (kind) => {
  const observedAt = new Date().toISOString();
  const result: ProviderResult = {
    exitCode: 0,
    isError: false,
    ...(kind === "account"
      ? { providerAccount: { source: "codex", observedAt, ordinaryUsageAllowed: false } as const }
      : {
          rateLimitReplacements: [
            { source: "codex", limitId: "codex", observedAt, slots: ["primary", "secondary"] },
          ] as ProviderResult["rateLimitReplacements"],
        }),
  };
  await completeTask(`quota-${kind}`, result, "gpt-test");
  const report = requests.find((r) => r.path === "/api/keys/report-rate-limit-windows");
  expect(report?.body?.windows).toEqual({});
  expect(report?.body?.[kind === "account" ? "account" : "replace"]).toBeDefined();
  expect(requests.some((r) => r.path === "/api/keys/report-rate-limit")).toBe(false);
});
