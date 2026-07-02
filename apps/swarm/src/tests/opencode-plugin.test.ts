/**
 * Unit tests for the opencode plugin's vendored summarize helpers.
 *
 * Plan: thoughts/taras/plans/2026-05-10-fix-session-summarization-workers.md
 * → Phase 2 § "Test coverage"
 *
 * Uses explicit dependency injection (the `deps` parameter on
 * `summarizeSessionForOpencode`) instead of `bun:test`'s `mock.module()`.
 * The latter is process-wide and leaks across test files in the same
 * `bun test` run (verified in Phase 1; see `pi-mono-extension.test.ts`).
 *
 * Test cases (per the plan):
 *   1. `flattenOpencodeTranscript` snapshot with mixed parts
 *   2. Happy path — long transcript + valid summary → POSTs to /api/memory/index
 *   3. Empty messages → no POST, no error
 *   4. `client.session.messages` throws → exactly one
 *      `console.error("session_summary failed (opencode):", ...)`
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Message, Part } from "@opencode-ai/sdk";
import {
  flattenOpencodeTranscript,
  type SummarizeSessionForOpencodeDeps,
  type SwarmConfig,
  summarizeSessionForOpencode,
} from "../../../../plugin/opencode-plugins/lib/summarize";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<SwarmConfig> = {}): SwarmConfig {
  return {
    apiUrl: "http://localhost:3013",
    apiKey: "test-key",
    agentId: "agent-oc-1",
    taskId: "task-oc-1",
    isLead: false,
    ...overrides,
  };
}

/** Build a fake `client` whose `session.messages` returns the provided items. */
function fakeClient(messages: Array<{ info: Message; parts: Part[] }>): {
  session: { messages: (opts: unknown) => Promise<{ data: typeof messages }> };
} {
  return {
    session: {
      messages: async () => ({ data: messages }),
    },
  };
}

function makeUserText(
  id: string,
  sessionID: string,
  text: string,
): {
  info: Message;
  parts: Part[];
} {
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: Date.now() },
    } as Message,
    parts: [
      {
        id: `${id}-p1`,
        sessionID,
        messageID: id,
        type: "text",
        text,
      } as Part,
    ],
  };
}

function makeAssistantWithTool(
  id: string,
  sessionID: string,
  text: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: string,
): { info: Message; parts: Part[] } {
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: Date.now() },
    } as unknown as Message,
    parts: [
      {
        id: `${id}-p1`,
        sessionID,
        messageID: id,
        type: "text",
        text,
      } as Part,
      {
        id: `${id}-p2`,
        sessionID,
        messageID: id,
        type: "tool",
        callID: `${id}-c1`,
        tool: toolName,
        state: {
          status: "completed",
          input: toolInput,
          output: toolOutput,
          title: "ran tool",
          metadata: {},
          time: { start: Date.now(), end: Date.now() + 100 },
        },
      } as Part,
    ],
  };
}

// ── test state ────────────────────────────────────────────────────────────────

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

describe("flattenOpencodeTranscript", () => {
  test("emits User: / Assistant: / Tool[..]: lines in order, ignores other parts", () => {
    const sessionID = "s1";
    const items = [
      makeUserText("m1", sessionID, "Please update the README"),
      makeAssistantWithTool(
        "m2",
        sessionID,
        "Reading the file first",
        "read",
        { path: "/workspace/README.md" },
        "(file contents)",
      ),
      makeUserText("m3", sessionID, "Looks good, ship it"),
    ];
    const result = flattenOpencodeTranscript(items);
    expect(result).toContain("User: Please update the README");
    expect(result).toContain("Assistant: Reading the file first");
    expect(result).toContain('Tool[read]: input={"path":"/workspace/README.md"}');
    expect(result).toContain('output="(file contents)"');
    expect(result).toContain("User: Looks good, ship it");
    // Order check
    const lines = result.split("\n");
    expect(lines[0]).toBe("User: Please update the README");
    expect(lines[1]).toBe("Assistant: Reading the file first");
    expect(lines[2]!.startsWith("Tool[read]:")).toBe(true);
    expect(lines[3]).toBe("User: Looks good, ship it");
  });

  test("incomplete tool state (status=running) is dropped", () => {
    const items = [
      {
        info: {
          id: "m1",
          sessionID: "s1",
          role: "assistant" as const,
          time: { created: 0 },
        } as Message,
        parts: [
          {
            id: "p1",
            sessionID: "s1",
            messageID: "m1",
            type: "tool" as const,
            callID: "c1",
            tool: "bash",
            state: {
              status: "running" as const,
              input: { cmd: "ls" },
              time: { start: 0 },
            },
          } as Part,
        ],
      },
    ];
    const result = flattenOpencodeTranscript(items);
    // Running tool calls should not appear.
    expect(result).toBe("");
  });

  test("reasoning / file / step parts are ignored", () => {
    const items = [
      makeUserText("m1", "s1", "Do work"),
      {
        info: {
          id: "m2",
          sessionID: "s1",
          role: "assistant" as const,
          time: { created: 0 },
        } as Message,
        parts: [
          {
            id: "p1",
            sessionID: "s1",
            messageID: "m2",
            type: "reasoning",
            text: "thinking...",
            time: { start: 0 },
          } as Part,
          {
            id: "p2",
            sessionID: "s1",
            messageID: "m2",
            type: "step-start",
          } as Part,
          {
            id: "p3",
            sessionID: "s1",
            messageID: "m2",
            type: "text",
            text: "ok done",
          } as Part,
        ],
      },
    ];
    const result = flattenOpencodeTranscript(items);
    expect(result).toBe("User: Do work\nAssistant: ok done");
  });

  test("empty items array → empty string", () => {
    expect(flattenOpencodeTranscript([])).toBe("");
  });
});

describe("summarizeSessionForOpencode", () => {
  test("happy path — long transcript + valid summary → POSTs to /api/memory/index", async () => {
    const items: Array<{ info: Message; parts: Part[] }> = [];
    // Generate enough lines to exceed the 100-char gate.
    for (let i = 0; i < 10; i++) {
      items.push(makeUserText(`m${i}u`, "s1", `Doing task ${i} with multiple details and notes`));
      items.push(
        makeAssistantWithTool(
          `m${i}a`,
          "s1",
          `Working on task ${i} now in detail`,
          "edit",
          { path: `/file${i}` },
          `result-${i}`,
        ),
      );
    }

    let runSummaryArgs: { systemPrompt: string; userPrompt: string } | null = null;
    const deps: SummarizeSessionForOpencodeDeps = {
      resolveAuth: async () => ({
        kind: "anthropic" as const,
        apiKey: "sk-test",
        modelDefault: "anthropic/claude-haiku-4-5",
      }),
      runSummaryLlm: async (_cred, systemPrompt, userPrompt) => {
        runSummaryArgs = { systemPrompt, userPrompt };
        return {
          summary: "Learned X about Y — concrete reusable fact about opencode.",
          ratings: [],
        };
      },
    };

    await summarizeSessionForOpencode(makeConfig(), fakeClient(items) as never, "s1", deps);

    expect(runSummaryArgs).not.toBeNull();
    expect(runSummaryArgs!.systemPrompt).toContain("expert at extracting durable");
    expect(runSummaryArgs!.userPrompt).toContain("Transcript:");

    const indexCalls = fetchCalls.filter((c) => c.url.endsWith("/api/memory/index"));
    expect(indexCalls.length).toBe(1);
    const body = JSON.parse(indexCalls[0]!.init?.body as string) as Record<string, unknown>;
    expect(body.scope).toBe("agent");
    expect(body.source).toBe("session_summary");
    expect(body.sourceTaskId).toBe("task-oc-1");
    expect(body.agentId).toBe("agent-oc-1");
    expect(body.name).toBe("session-summary");
    expect(body.content).toBe("Learned X about Y — concrete reusable fact about opencode.");

    expect(consoleErrors.length).toBe(0);
  });

  test("empty messages array → no POST, no error", async () => {
    await summarizeSessionForOpencode(makeConfig(), fakeClient([]) as never, "s1", {
      // Should never be called.
      resolveAuth: async () => {
        throw new Error("resolveAuth should not be called for empty transcript");
      },
    });
    const indexCalls = fetchCalls.filter((c) => c.url.endsWith("/api/memory/index"));
    expect(indexCalls.length).toBe(0);
    expect(consoleErrors.length).toBe(0);
  });

  test("transcript ≤100 chars after flattening → no POST, no error", async () => {
    const items = [makeUserText("m1", "s1", "hi")];
    await summarizeSessionForOpencode(makeConfig(), fakeClient(items) as never, "s1", {
      resolveAuth: async () => {
        throw new Error("resolveAuth should not be called for short transcript");
      },
    });
    const indexCalls = fetchCalls.filter((c) => c.url.endsWith("/api/memory/index"));
    expect(indexCalls.length).toBe(0);
    expect(consoleErrors.length).toBe(0);
  });

  test("client.session.messages throws → exactly one console.error('session_summary failed (opencode):', ...)", async () => {
    const fakeClientThrows = {
      session: {
        messages: async () => {
          throw new Error("opencode SDK boom");
        },
      },
    };

    await summarizeSessionForOpencode(makeConfig(), fakeClientThrows as never, "s1", {
      resolveAuth: async () => {
        throw new Error("resolveAuth should not be called when SDK throws");
      },
    });

    // No index POST should fire.
    const indexCalls = fetchCalls.filter((c) => c.url.endsWith("/api/memory/index"));
    expect(indexCalls.length).toBe(0);

    // Exactly one error log with the documented prefix.
    const opencodeErrors = consoleErrors.filter((args) =>
      String(args[0] ?? "").includes("session_summary failed (opencode):"),
    );
    expect(opencodeErrors.length).toBe(1);
  });

  test("resolveAuth returns null → no POST, no error log (graceful no-op)", async () => {
    const items: Array<{ info: Message; parts: Part[] }> = [];
    for (let i = 0; i < 5; i++) {
      items.push(makeUserText(`m${i}`, "s1", `long enough transcript line ${i} with detail`));
    }
    await summarizeSessionForOpencode(makeConfig(), fakeClient(items) as never, "s1", {
      resolveAuth: async () => null,
      runSummaryLlm: async () => {
        throw new Error("runSummaryLlm should not be called when no creds");
      },
    });
    const indexCalls = fetchCalls.filter((c) => c.url.endsWith("/api/memory/index"));
    expect(indexCalls.length).toBe(0);
    expect(consoleErrors.length).toBe(0);
  });

  test("summary contains 'no significant learnings' → no POST", async () => {
    const items: Array<{ info: Message; parts: Part[] }> = [];
    for (let i = 0; i < 5; i++) {
      items.push(makeUserText(`m${i}`, "s1", `long enough transcript line ${i} with detail`));
    }
    await summarizeSessionForOpencode(makeConfig(), fakeClient(items) as never, "s1", {
      resolveAuth: async () => ({
        kind: "openrouter" as const,
        apiKey: "sk-test",
        modelDefault: "openrouter/google/gemini-3-flash-preview",
      }),
      runSummaryLlm: async () => ({
        summary: "No significant learnings.",
        ratings: [],
      }),
    });
    const indexCalls = fetchCalls.filter((c) => c.url.endsWith("/api/memory/index"));
    expect(indexCalls.length).toBe(0);
  });

  test("/api/memory/index POST 500 → console.error with documented prefix, no throw", async () => {
    fetchHandler = async (url) => {
      if (url.includes("/api/memory/index")) {
        return {
          ok: false,
          status: 500,
          text: async () => "server boom",
          json: async () => ({}),
        };
      }
      return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
    };

    const items: Array<{ info: Message; parts: Part[] }> = [];
    for (let i = 0; i < 5; i++) {
      items.push(makeUserText(`m${i}`, "s1", `long enough transcript line ${i} with detail`));
    }
    await summarizeSessionForOpencode(makeConfig(), fakeClient(items) as never, "s1", {
      resolveAuth: async () => ({
        kind: "openrouter" as const,
        apiKey: "sk-test",
        modelDefault: "openrouter/google/gemini-3-flash-preview",
      }),
      runSummaryLlm: async () => ({
        summary: "A concrete reusable fact about opencode.",
        ratings: [],
      }),
    });

    const postFailures = consoleErrors.filter((args) =>
      String(args[0] ?? "").includes("session_summary: /api/memory/index POST failed (opencode):"),
    );
    expect(postFailures.length).toBe(1);
  });

  test("ratings path — MEMORY_RATERS=llm + retrievals + ratings → postRatings called with events: key", async () => {
    process.env.MEMORY_RATERS = "llm";

    const retrievals = [
      { id: "mem-a", name: "memA", content: "content A" },
      { id: "mem-b", name: "memB", content: "content B" },
    ];

    let postRatingsArgs: { events: unknown[]; taskId?: string; agentId?: string } | null = null;

    const items: Array<{ info: Message; parts: Part[] }> = [];
    for (let i = 0; i < 5; i++) {
      items.push(makeUserText(`m${i}`, "s1", `long enough transcript line ${i} with detail`));
    }

    await summarizeSessionForOpencode(makeConfig(), fakeClient(items) as never, "s1", {
      resolveAuth: async () => ({
        kind: "openrouter" as const,
        apiKey: "sk-test",
        modelDefault: "openrouter/google/gemini-3-flash-preview",
      }),
      runSummaryLlm: async () => ({
        summary: "Learned that mem-a is highly relevant and mem-b is irrelevant.",
        ratings: [
          { id: "mem-a", score: 0.9, reasoning: "directly used" },
          { id: "mem-b", score: 0.1, reasoning: "off-topic" },
        ],
      }),
      fetchRetrievalsForTask: async () => retrievals,
      postRatings: async (args) => {
        postRatingsArgs = {
          events: args.events,
          taskId: args.taskId,
          agentId: args.agentId,
        };
        return { ok: true, status: 200 };
      },
    });

    expect(postRatingsArgs).not.toBeNull();
    expect(postRatingsArgs!.agentId).toBe("agent-oc-1");
    // Critical: events:, not ratings: — Phase 1 errata.
    expect(Array.isArray(postRatingsArgs!.events)).toBe(true);
    expect(postRatingsArgs!.events.length).toBe(2);
    // Task ID is passed for cross-referencing.
    expect(postRatingsArgs!.taskId).toBe("task-oc-1");
  });
});
