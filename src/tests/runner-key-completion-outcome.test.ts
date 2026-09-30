import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { reportKeyCompletionOutcome } from "../commands/runner";

// A fake API that records the order in which it FINISHES handling credential
// reports. The success reset is slow, so a fire-and-forget caller would let
// the later auth-failure reports land first and have their bench erased.
const handled: string[] = [];
let clearDelayMs = 0;
let server: ReturnType<typeof Bun.serve>;
let apiUrl: string;

const credential = { keyType: "CODEX_OAUTH", keySuffix: "d3Ove", keyIndex: 2 };
const authFailure =
  "[auth-error] Codex authentication failed — check OPENAI_API_KEY or ChatGPT login. Original error: workspace routing discovery unauthorized (401)";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = (await req.json()) as { clearAuthBench?: boolean };
      if (path === "/api/keys/clear-rate-limit") {
        await Bun.sleep(clearDelayMs);
        handled.push(`clear:${body.clearAuthBench === true}`);
        return Response.json({ success: true, cleared: true });
      }
      if (path === "/api/keys/report-auth-failure") {
        handled.push("auth-failure");
        return Response.json({
          success: true,
          consecutiveAuthFailures: handled.filter((h) => h === "auth-failure").length,
          benched: false,
          rateLimitedUntil: null,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  apiUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  handled.length = 0;
  clearDelayMs = 0;
});

describe("reportKeyCompletionOutcome", () => {
  test("a delayed success reset lands before later auth failures of the same login", async () => {
    clearDelayMs = 200;
    const completions = [
      { exitCode: 0, failureReason: undefined },
      { exitCode: 1, failureReason: authFailure },
      { exitCode: 1, failureReason: authFailure },
    ];
    // Same shape as checkCompletedProcesses: one awaited report per completion.
    for (const [i, c] of completions.entries()) {
      await reportKeyCompletionOutcome({
        apiUrl,
        apiKey: "test-key",
        credential,
        taskId: `00000000-0000-4000-8000-00000000000${i}`,
        ...c,
      });
    }
    expect(handled).toEqual(["clear:true", "auth-failure", "auth-failure"]);
  });

  test("returns only after the success reset is handled", async () => {
    clearDelayMs = 100;
    await reportKeyCompletionOutcome({
      apiUrl,
      apiKey: "test-key",
      credential,
      taskId: "00000000-0000-4000-8000-000000000009",
      exitCode: 0,
      failureReason: undefined,
    });
    expect(handled).toEqual(["clear:true"]);
  });

  test("a non-auth failure sends no report", async () => {
    await reportKeyCompletionOutcome({
      apiUrl,
      apiKey: "test-key",
      credential,
      taskId: "00000000-0000-4000-8000-00000000000b",
      exitCode: 1,
      failureReason: "[rate-limit] Codex API rate limit hit. Original error: 429",
    });
    expect(handled).toEqual([]);
  });

  // Last: its handler finishes after the test, so nothing may assert on `handled` later.
  test("a hung success reset is bounded by the timeout and never throws", async () => {
    clearDelayMs = 2_000;
    const started = Date.now();
    await reportKeyCompletionOutcome({
      apiUrl,
      apiKey: "test-key",
      credential,
      taskId: "00000000-0000-4000-8000-00000000000a",
      exitCode: 0,
      failureReason: undefined,
      timeoutMs: 100,
    });
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});
