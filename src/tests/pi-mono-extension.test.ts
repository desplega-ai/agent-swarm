/**
 * Unit tests for `summarizeSessionForPi` in `src/providers/pi-mono-extension.ts`.
 *
 * Plan: thoughts/taras/plans/2026-05-10-fix-session-summarization-workers.md
 * → Phase 1 § "Test coverage"
 *
 * Uses explicit dependency injection (the `deps` parameter on
 * `summarizeSessionForPi`) instead of `bun:test`'s `mock.module()` because the
 * latter installs a process-wide override that leaks across test files in the
 * same `bun test` run (`buildRatingsFromLlm` siblings + Phase-0 internal-ai
 * tests would break).
 *
 * Mocks:
 *   - `runSummarize`           — captures args + returns canned result
 *   - `fetchRetrievalsForTask` — returns canned retrievals
 *   - `postRatings`            — captures args, asserts `events:` key
 *   - `buildRatingsFromLlm`    — minimal pass-through unless overridden
 *   - `globalThis.fetch`       — captures `/api/memory/index` POSTs
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SummarizeSessionForPiDeps, SwarmHooksConfig } from "../providers/pi-mono-extension";
import { summarizeSessionForPi } from "../providers/pi-mono-extension";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeConfig(): SwarmHooksConfig {
  return {
    apiUrl: "http://localhost:3013",
    apiKey: "test-key",
    agentId: "agent-pi-1",
    taskId: "task-pi-1",
    isLead: false,
  };
}

/** Build a transcript with > 100 chars so the degenerate gate doesn't trip. */
function longTranscript(extra = "") {
  return "User: do a thing\nAssistant: doing thing\nTool[write]: ok\n".repeat(5) + extra;
}

/**
 * Write a temp file under /tmp containing `content`. The SUT's
 * `Bun.file(sessionFile).text()` reads it back without further mocking.
 */
async function writeTempTranscript(content: string): Promise<string> {
  const path = `/tmp/pi-mono-test-transcript-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
  await Bun.write(path, content);
  return path;
}

// ── test state ────────────────────────────────────────────────────────────────

type RunSummarizeArgs = Parameters<NonNullable<SummarizeSessionForPiDeps["runSummarize"]>>[0];
type RunSummarizeResult = Awaited<
  ReturnType<NonNullable<SummarizeSessionForPiDeps["runSummarize"]>>
>;
type FetchRetrievalsArgs = Parameters<
  NonNullable<SummarizeSessionForPiDeps["fetchRetrievalsForTask"]>
>[0];
type FetchRetrievalsResult = Awaited<
  ReturnType<NonNullable<SummarizeSessionForPiDeps["fetchRetrievalsForTask"]>>
>;
type PostRatingsArgs = Parameters<NonNullable<SummarizeSessionForPiDeps["postRatings"]>>[0];

const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
type FetchHandlerResp = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
};
let fetchHandler: ((url: string, init?: RequestInit) => Promise<FetchHandlerResp>) | null = null;
const consoleErrors: unknown[][] = [];

const origFetch = globalThis.fetch;
const origConsoleError = console.error;

beforeEach(() => {
  fetchCalls.length = 0;
  consoleErrors.length = 0;
  fetchHandler = null;
  // Default fetch: 202 for /api/memory/index, 200 otherwise (so non-test fetches
  // like fetchTaskDetails don't crash with an undefined handler).
  fetchHandler = async (url) => {
    if (url.includes("/api/memory/index")) {
      return {
        ok: true,
        status: 202,
        text: async () => "",
        json: async () => ({ queued: true, memoryIds: ["mem-1"] }),
      };
    }
    return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
  };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    fetchCalls.push({ url: urlStr, init });
    if (!fetchHandler) return new Response("{}", { status: 200 });
    return fetchHandler(urlStr, init) as unknown as Response;
  }) as typeof fetch;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args);
  };
  delete process.env.MEMORY_RATERS;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  console.error = origConsoleError;
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("summarizeSessionForPi", () => {
  test("happy path — long transcript + valid summary → POSTs to /api/memory/index", async () => {
    const transcript = longTranscript("Some real-looking work here\n");
    const sessionFile = await writeTempTranscript(transcript);

    let lastRunSummarizeArgs: RunSummarizeArgs | null = null;
    const deps: SummarizeSessionForPiDeps = {
      runSummarize: async (args) => {
        lastRunSummarizeArgs = args;
        return {
          summary: "Learned X about Y — concrete reusable fact.",
          ratings: [],
        } as RunSummarizeResult;
      },
    };

    await summarizeSessionForPi(makeConfig(), sessionFile, deps);

    expect(lastRunSummarizeArgs).not.toBeNull();
    expect(lastRunSummarizeArgs!.harness).toBe("pi");
    expect(lastRunSummarizeArgs!.taskContext.sourceTaskId).toBe("task-pi-1");
    expect(lastRunSummarizeArgs!.taskContext.agentId).toBe("agent-pi-1");
    expect(lastRunSummarizeArgs!.apiUrl).toBe("http://localhost:3013");
    expect(lastRunSummarizeArgs!.apiKey).toBe("test-key");

    const indexCalls = fetchCalls.filter((c) => c.url.endsWith("/api/memory/index"));
    expect(indexCalls.length).toBe(1);
    const body = JSON.parse(indexCalls[0]!.init?.body as string) as Record<string, unknown>;
    expect(body.scope).toBe("agent");
    expect(body.source).toBe("session_summary");
    expect(body.sourceTaskId).toBe("task-pi-1");
    expect(body.agentId).toBe("agent-pi-1");
    expect(body.name).toBe("session-summary");
    expect(body.content).toBe("Learned X about Y — concrete reusable fact.");

    expect(consoleErrors.length).toBe(0);
  });

  test("empty transcript (≤100 chars) → no POST, no error", async () => {
    const sessionFile = await writeTempTranscript("short");

    const deps: SummarizeSessionForPiDeps = {
      runSummarize: async () => {
        throw new Error("should not be called");
      },
    };
    await summarizeSessionForPi(makeConfig(), sessionFile, deps);

    expect(fetchCalls.length).toBe(0);
    expect(consoleErrors.length).toBe(0);
  });

  test("no sessionFile → no POST, no error", async () => {
    const deps: SummarizeSessionForPiDeps = {
      runSummarize: async () => {
        throw new Error("should not be called");
      },
    };
    await summarizeSessionForPi(makeConfig(), undefined, deps);

    expect(fetchCalls.length).toBe(0);
    expect(consoleErrors.length).toBe(0);
  });

  test("no credentials (runSummarize returns null) → no POST, no error log", async () => {
    const sessionFile = await writeTempTranscript(longTranscript());

    const deps: SummarizeSessionForPiDeps = {
      runSummarize: async () => null,
    };
    await summarizeSessionForPi(makeConfig(), sessionFile, deps);

    const indexCalls = fetchCalls.filter((c) => c.url.endsWith("/api/memory/index"));
    expect(indexCalls.length).toBe(0);
    // wrapper logs internally; the pi wrapper itself should not log on null return
    expect(consoleErrors.length).toBe(0);
  });

  test("length gate — summary too short → no POST", async () => {
    const sessionFile = await writeTempTranscript(longTranscript());

    const deps: SummarizeSessionForPiDeps = {
      runSummarize: async () => ({ summary: "tiny", ratings: [] }) as RunSummarizeResult,
    };
    await summarizeSessionForPi(makeConfig(), sessionFile, deps);

    const indexCalls = fetchCalls.filter((c) => c.url.endsWith("/api/memory/index"));
    expect(indexCalls.length).toBe(0);
    expect(consoleErrors.length).toBe(0);
  });

  test("'no significant learnings' gate → no POST", async () => {
    const sessionFile = await writeTempTranscript(longTranscript());

    const deps: SummarizeSessionForPiDeps = {
      runSummarize: async () =>
        ({ summary: "No significant learnings.", ratings: [] }) as RunSummarizeResult,
    };
    await summarizeSessionForPi(makeConfig(), sessionFile, deps);

    const indexCalls = fetchCalls.filter((c) => c.url.endsWith("/api/memory/index"));
    expect(indexCalls.length).toBe(0);
    expect(consoleErrors.length).toBe(0);
  });

  test("POST 500 → exactly one console.error('session_summary: /api/memory/index POST failed (pi):', ...)", async () => {
    const sessionFile = await writeTempTranscript(longTranscript());

    fetchHandler = async (url) => {
      if (url.includes("/api/memory/index")) {
        return {
          ok: false,
          status: 500,
          text: async () => "internal server error",
          json: async () => ({}),
        };
      }
      return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
    };

    const deps: SummarizeSessionForPiDeps = {
      runSummarize: async () =>
        ({
          summary: "A valid long-enough summary that passes the length gate.",
          ratings: [],
        }) as RunSummarizeResult,
    };
    await summarizeSessionForPi(makeConfig(), sessionFile, deps);

    const matching = consoleErrors.filter(
      (args) =>
        typeof args[0] === "string" &&
        (args[0] as string).startsWith("session_summary: /api/memory/index POST failed (pi):"),
    );
    expect(matching.length).toBe(1);
    expect(matching[0]![1]).toBe(500);
  });

  test("fetch throws → exactly one console.error('session_summary failed (pi):', ...)", async () => {
    const sessionFile = await writeTempTranscript(longTranscript());

    fetchHandler = async (url) => {
      if (url.includes("/api/memory/index")) {
        throw new Error("network down");
      }
      return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
    };

    const deps: SummarizeSessionForPiDeps = {
      runSummarize: async () =>
        ({
          summary: "A valid long-enough summary that passes the length gate.",
          ratings: [],
        }) as RunSummarizeResult,
    };
    await summarizeSessionForPi(makeConfig(), sessionFile, deps);

    const matching = consoleErrors.filter(
      (args) =>
        typeof args[0] === "string" &&
        (args[0] as string).startsWith("session_summary failed (pi):"),
    );
    expect(matching.length).toBe(1);
  });

  test("ratings path — MEMORY_RATERS=llm + retrievals + ratings → postRatings called with `events:` key (NOT `ratings:`)", async () => {
    process.env.MEMORY_RATERS = "llm";
    const sessionFile = await writeTempTranscript(longTranscript());

    const retrievalRow = {
      id: "mem-A",
      name: "memory A",
      content: "...",
    };
    const fetchRetrievalsMock: SummarizeSessionForPiDeps["fetchRetrievalsForTask"] = async (
      _args: FetchRetrievalsArgs,
    ) => [retrievalRow] as unknown as FetchRetrievalsResult;

    let lastPostRatingsArgs: PostRatingsArgs | null = null;
    const postRatingsMock: SummarizeSessionForPiDeps["postRatings"] = async (args) => {
      lastPostRatingsArgs = args;
      return { ok: true, status: 200 };
    };

    const deps: SummarizeSessionForPiDeps = {
      runSummarize: async (args) => {
        expect(args.retrievals.length).toBe(1);
        expect(args.retrievals[0]!.id).toBe("mem-A");
        return {
          summary: "Long-enough summary with real content for the index POST.",
          ratings: [{ id: "mem-A", score: 0.8, reasoning: "useful" }],
        } as RunSummarizeResult;
      },
      fetchRetrievalsForTask: fetchRetrievalsMock,
      postRatings: postRatingsMock,
      buildRatingsFromLlm: (ratings, retrievals) => {
        // Smoke-check: only keep ratings present in retrievals (mirrors real impl)
        const allowed = new Set(retrievals.map((r) => r.id));
        return ratings
          .filter((r) => allowed.has(r.id))
          .map((r) => ({
            memoryId: r.id,
            signal: 2 * r.score - 1,
            weight: 0.8,
            source: "llm",
            reasoning: r.reasoning,
          }));
      },
    };

    await summarizeSessionForPi(makeConfig(), sessionFile, deps);

    // Index POST happened
    const indexCalls = fetchCalls.filter((c) => c.url.endsWith("/api/memory/index"));
    expect(indexCalls.length).toBe(1);

    // postRatings was called with `events:` key, not `ratings:` — guards against
    // the orchestrator-flagged plan/signature mismatch
    expect(lastPostRatingsArgs).not.toBeNull();
    expect(lastPostRatingsArgs!.apiUrl).toBe("http://localhost:3013");
    expect(lastPostRatingsArgs!.agentId).toBe("agent-pi-1");
    expect(lastPostRatingsArgs!.taskId).toBe("task-pi-1");
    expect(Array.isArray(lastPostRatingsArgs!.events)).toBe(true);
    expect(lastPostRatingsArgs!.events.length).toBe(1);
    expect(lastPostRatingsArgs!.events[0]!.memoryId).toBe("mem-A");
    expect(lastPostRatingsArgs!.events[0]!.source).toBe("llm");

    // Guard against accidentally passing a `ratings:` key (plan example bug)
    expect((lastPostRatingsArgs as unknown as Record<string, unknown>).ratings).toBeUndefined();

    expect(consoleErrors.length).toBe(0);
  });
});
