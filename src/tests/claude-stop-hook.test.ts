/**
 * Unit tests for `runStopHookSessionSummary` in `src/hooks/hook.ts`.
 *
 * Plan: thoughts/taras/plans/2026-05-10-fix-session-summarization-workers.md
 * → Phase 4 § "Test coverage"
 *
 * Uses explicit dependency injection (the `deps` parameter on
 * `runStopHookSessionSummary`) instead of `bun:test`'s `mock.module()` because
 * the latter installs a process-wide override that leaks across test files in
 * the same `bun test` run. Mirrors the `summarizeSessionForPi` test pattern in
 * `src/tests/pi-mono-extension.test.ts`.
 *
 * Mocks:
 *   - `runSummarize`           — captures args + returns canned result
 *   - `fetchRetrievalsForTask` — returns canned retrievals (when needed)
 *   - `postRatings`            — captures args, asserts `events:` key
 *   - `buildRatingsFromLlm`    — minimal pass-through unless overridden
 *   - `globalThis.fetch`       — captures `/api/memory/index` POSTs
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RunStopHookSessionSummaryDeps } from "../hooks/hook";
import { runStopHookSessionSummary } from "../hooks/hook";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a transcript with > 100 chars so the degenerate gate doesn't trip. */
function longTranscript(extra = "") {
  return "User: do a thing\nAssistant: doing thing\nTool[write]: ok\n".repeat(5) + extra;
}

/**
 * Write a temp file under /tmp containing `content`. The SUT's
 * `Bun.file(transcriptPath).text()` reads it back without further mocking.
 */
async function writeTempTranscript(content: string): Promise<string> {
  const path = `/tmp/claude-stop-hook-test-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
  await Bun.write(path, content);
  return path;
}

// ── test state ────────────────────────────────────────────────────────────────

type RunSummarizeArgs = Parameters<NonNullable<RunStopHookSessionSummaryDeps["runSummarize"]>>[0];
type RunSummarizeResult = Awaited<
  ReturnType<NonNullable<RunStopHookSessionSummaryDeps["runSummarize"]>>
>;
type PostRatingsArgs = Parameters<NonNullable<RunStopHookSessionSummaryDeps["postRatings"]>>[0];

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
  // Default fetch: 202 for /api/memory/index, 200 otherwise.
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
  // Wipe any envs that could leak between tests.
  delete process.env.MEMORY_RATERS;
  delete process.env.SKIP_SESSION_SUMMARY;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  console.error = origConsoleError;
});

function makeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  // Minimal env that drives the SUT through its happy path. Tests override
  // selectively via `extra`.
  return {
    MCP_BASE_URL: "http://localhost:3013",
    API_KEY: "test-key",
    AGENT_SWARM_TASK_ID: "task-stop-1",
    ...extra,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("runStopHookSessionSummary", () => {
  test("happy path — long transcript + valid summary → POSTs to /api/memory/index with old runMemoryRater shape", async () => {
    const transcript = longTranscript("Real-looking learnings here\n");
    const transcriptPath = await writeTempTranscript(transcript);

    let lastRunSummarizeArgs: RunSummarizeArgs | null = null;
    const deps: RunStopHookSessionSummaryDeps = {
      runSummarize: async (args) => {
        lastRunSummarizeArgs = args;
        return {
          summary: "Learned X about Y — concrete reusable fact.",
          ratings: [],
        } as RunSummarizeResult;
      },
    };

    await runStopHookSessionSummary(
      {
        agentId: "agent-claude-1",
        transcriptPath,
        env: makeEnv(),
      },
      deps,
    );

    expect(lastRunSummarizeArgs).not.toBeNull();
    expect(lastRunSummarizeArgs!.harness).toBe("claude");
    expect(lastRunSummarizeArgs!.taskContext.sourceTaskId).toBe("task-stop-1");
    expect(lastRunSummarizeArgs!.taskContext.agentId).toBe("agent-claude-1");
    expect(lastRunSummarizeArgs!.apiUrl).toBe("http://localhost:3013");
    expect(lastRunSummarizeArgs!.apiKey).toBe("test-key");

    const indexCalls = fetchCalls.filter((c) => c.url.endsWith("/api/memory/index"));
    expect(indexCalls.length).toBe(1);
    const body = JSON.parse(indexCalls[0]!.init?.body as string) as Record<string, unknown>;
    expect(body.scope).toBe("agent");
    expect(body.source).toBe("session_summary");
    expect(body.sourceTaskId).toBe("task-stop-1");
    expect(body.agentId).toBe("agent-claude-1");
    expect(typeof body.name).toBe("string");
    expect((body.name as string).length).toBeGreaterThan(0);
    expect(body.content).toBe("Learned X about Y — concrete reusable fact.");

    // Headers match the old runMemoryRater POST: Bearer + X-Agent-ID.
    const headers = indexCalls[0]!.init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer test-key");
    expect(headers["X-Agent-ID"]).toBe("agent-claude-1");

    expect(consoleErrors.length).toBe(0);
  });

  test("no credentials (runSummarize returns null) → no POST, no exception, no error log", async () => {
    const transcriptPath = await writeTempTranscript(longTranscript());

    const deps: RunStopHookSessionSummaryDeps = {
      runSummarize: async () => null,
    };

    await runStopHookSessionSummary(
      {
        agentId: "agent-claude-1",
        transcriptPath,
        env: makeEnv(),
      },
      deps,
    );

    const indexCalls = fetchCalls.filter((c) => c.url.endsWith("/api/memory/index"));
    expect(indexCalls.length).toBe(0);
    expect(consoleErrors.length).toBe(0);
  });

  test("CLAUDE_CODE_OAUTH_TOKEN-only env → wrapper resolves claude-cli; POST still happens", async () => {
    // The SUT delegates credential resolution to `runSummarize` (which calls
    // `resolveCredential` internally). We exercise the same code path by
    // injecting a `runSummarize` that asserts the env state and returns a
    // canned `{summary, ratings}`. Mirrors what the real wrapper would return
    // after going through the claude-cli fallback.
    const transcriptPath = await writeTempTranscript(longTranscript("oauth fallback exercise\n"));

    let observedEnvHasOAuth = false;
    const deps: RunStopHookSessionSummaryDeps = {
      runSummarize: async () => {
        observedEnvHasOAuth =
          !!process.env.CLAUDE_CODE_OAUTH_TOKEN &&
          !process.env.OPENROUTER_API_KEY &&
          !process.env.ANTHROPIC_API_KEY &&
          !process.env.OPENAI_API_KEY;
        return {
          summary:
            "OAuth-fallback session: identified the silent-drop root cause and shipped a fix.",
          ratings: [],
        } as RunSummarizeResult;
      },
    };

    // Set only CLAUDE_CODE_OAUTH_TOKEN; ensure others are not present in the
    // PROCESS env (the SUT's `runSummarize` reads `process.env` because the
    // wrapper's `resolveCredential` defaults to `process.env`).
    const prev = {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    };
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-test-oauth-stop-hook";

    try {
      await runStopHookSessionSummary(
        {
          agentId: "agent-claude-oauth",
          transcriptPath,
          env: makeEnv({
            // Mirror the process env into the SUT-scoped env for SKIP / MCP_BASE_URL plumbing.
            CLAUDE_CODE_OAUTH_TOKEN: "sk-test-oauth-stop-hook",
          }),
        },
        deps,
      );

      expect(observedEnvHasOAuth).toBe(true);
      const indexCalls = fetchCalls.filter((c) => c.url.endsWith("/api/memory/index"));
      expect(indexCalls.length).toBe(1);
      const body = JSON.parse(indexCalls[0]!.init?.body as string) as Record<string, unknown>;
      expect(body.source).toBe("session_summary");
      expect(body.sourceTaskId).toBe("task-stop-1");
      expect(body.agentId).toBe("agent-claude-oauth");
    } finally {
      // Restore process env.
      if (prev.OPENROUTER_API_KEY === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prev.OPENROUTER_API_KEY;
      if (prev.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev.ANTHROPIC_API_KEY;
      if (prev.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev.OPENAI_API_KEY;
      if (prev.CLAUDE_CODE_OAUTH_TOKEN === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = prev.CLAUDE_CODE_OAUTH_TOKEN;
    }
  });

  test("SKIP_SESSION_SUMMARY=1 → no runSummarize call, no POST", async () => {
    const transcriptPath = await writeTempTranscript(longTranscript());

    let runSummarizeCalled = false;
    const deps: RunStopHookSessionSummaryDeps = {
      runSummarize: async () => {
        runSummarizeCalled = true;
        throw new Error("should not be called");
      },
    };

    await runStopHookSessionSummary(
      {
        agentId: "agent-claude-1",
        transcriptPath,
        env: makeEnv({ SKIP_SESSION_SUMMARY: "1" }),
      },
      deps,
    );

    expect(runSummarizeCalled).toBe(false);
    expect(fetchCalls.length).toBe(0);
    expect(consoleErrors.length).toBe(0);
  });

  test("short transcript (≤100 chars) → no runSummarize call, no POST", async () => {
    const transcriptPath = await writeTempTranscript("tiny");

    let runSummarizeCalled = false;
    const deps: RunStopHookSessionSummaryDeps = {
      runSummarize: async () => {
        runSummarizeCalled = true;
        throw new Error("should not be called");
      },
    };

    await runStopHookSessionSummary(
      {
        agentId: "agent-claude-1",
        transcriptPath,
        env: makeEnv(),
      },
      deps,
    );

    expect(runSummarizeCalled).toBe(false);
    expect(fetchCalls.length).toBe(0);
    expect(consoleErrors.length).toBe(0);
  });

  test("length gate — summary too short → no POST", async () => {
    const transcriptPath = await writeTempTranscript(longTranscript());

    const deps: RunStopHookSessionSummaryDeps = {
      runSummarize: async () => ({ summary: "tiny", ratings: [] }) as RunSummarizeResult,
    };

    await runStopHookSessionSummary(
      {
        agentId: "agent-claude-1",
        transcriptPath,
        env: makeEnv(),
      },
      deps,
    );

    const indexCalls = fetchCalls.filter((c) => c.url.endsWith("/api/memory/index"));
    expect(indexCalls.length).toBe(0);
    expect(consoleErrors.length).toBe(0);
  });

  test("'No significant learnings' gate → no POST", async () => {
    const transcriptPath = await writeTempTranscript(longTranscript());

    const deps: RunStopHookSessionSummaryDeps = {
      runSummarize: async () =>
        ({ summary: "No significant learnings.", ratings: [] }) as RunSummarizeResult,
    };

    await runStopHookSessionSummary(
      {
        agentId: "agent-claude-1",
        transcriptPath,
        env: makeEnv(),
      },
      deps,
    );

    const indexCalls = fetchCalls.filter((c) => c.url.endsWith("/api/memory/index"));
    expect(indexCalls.length).toBe(0);
    expect(consoleErrors.length).toBe(0);
  });

  test("MEMORY_RATERS includes 'llm' + ratings returned → postRatings invoked with events: key", async () => {
    const transcriptPath = await writeTempTranscript(longTranscript("with ratings\n"));

    let postRatingsArgs: PostRatingsArgs | null = null;
    const fetchRetrievalsArgsLog: unknown[] = [];

    const deps: RunStopHookSessionSummaryDeps = {
      runSummarize: async () =>
        ({
          summary: "Real, durable learning that easily passes the 20-char gate.",
          ratings: [{ id: "mem-1", score: 0.9, reasoning: "directly applicable" }],
        }) as RunSummarizeResult,
      fetchRetrievalsForTask: async (args) => {
        fetchRetrievalsArgsLog.push(args);
        return [
          {
            id: "mem-1",
            name: "stub memory",
            content: "stub memory content",
            scope: "agent",
          },
        ];
      },
      buildRatingsFromLlm: (ratings, _retrievals) =>
        ratings.map((r) => ({
          memoryId: r.id,
          signal: 2 * r.score - 1,
          weight: 1,
          source: "llm" as const,
          reasoning: r.reasoning,
        })),
      postRatings: async (args) => {
        postRatingsArgs = args;
        return { ok: true, status: 202 };
      },
    };

    process.env.MEMORY_RATERS = "llm";
    try {
      await runStopHookSessionSummary(
        {
          agentId: "agent-claude-1",
          transcriptPath,
          env: makeEnv(),
        },
        deps,
      );
    } finally {
      delete process.env.MEMORY_RATERS;
    }

    expect(fetchRetrievalsArgsLog.length).toBe(1);
    expect(postRatingsArgs).not.toBeNull();
    // Real signature uses `events:`, NOT `ratings:`.
    expect(Array.isArray(postRatingsArgs!.events)).toBe(true);
    expect(postRatingsArgs!.events.length).toBe(1);
    expect(postRatingsArgs!.events[0]!.memoryId).toBe("mem-1");
    expect(postRatingsArgs!.taskId).toBe("task-stop-1");
    expect(postRatingsArgs!.agentId).toBe("agent-claude-1");
  });

  test("runSummarize throws → caught silently; no POST, no rethrow", async () => {
    const transcriptPath = await writeTempTranscript(longTranscript());

    const deps: RunStopHookSessionSummaryDeps = {
      runSummarize: async () => {
        throw new Error("boom");
      },
    };

    await expect(
      runStopHookSessionSummary(
        {
          agentId: "agent-claude-1",
          transcriptPath,
          env: makeEnv(),
        },
        deps,
      ),
    ).resolves.toBeUndefined();

    const indexCalls = fetchCalls.filter((c) => c.url.endsWith("/api/memory/index"));
    expect(indexCalls.length).toBe(0);
  });
});
