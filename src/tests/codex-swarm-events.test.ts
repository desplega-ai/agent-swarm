import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as toolLoop from "../hooks/tool-loop-detection";
import { CodexAdapter } from "../providers/codex-adapter";
import {
  type CodexSwarmEventHandlerOpts,
  createCodexSwarmEventHandler,
} from "../providers/codex-swarm-events";
import type { ProviderEvent } from "../providers/types";
import { makeFakeAppServer } from "./fixtures/codex-app-server-client";

/**
 * Captured fetch invocation, recorded by the stub installed for each test.
 * `init` is the second argument to `fetch` (method, headers, body).
 */
interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

const originalFetch = globalThis.fetch;
const originalLog = console.log;

function buildOpts(override: Partial<CodexSwarmEventHandlerOpts> = {}): CodexSwarmEventHandlerOpts {
  return {
    apiUrl: "http://test-api",
    apiKey: "example-test-key",
    agentId: "agent-1",
    taskId: "task-1",
    abortRef: { current: null },
    ...override,
  };
}

function installFetchStub(responder: (url: string, init: RequestInit | undefined) => Response): {
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return responder(url, init);
  }) as typeof fetch;
  return { calls };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
});

describe("createCodexSwarmEventHandler", () => {
  describe("session_init", () => {
    test("captures the session id without firing any fetches", () => {
      const { calls } = installFetchStub(() => new Response("{}", { status: 200 }));
      const handler = createCodexSwarmEventHandler(buildOpts());
      handler({ type: "session_init", sessionId: "thread-abc" });
      expect(calls.length).toBe(0);
    });
  });

  describe("tool_start", () => {
    test("triggers cancellation check, heartbeat, and activity ping", async () => {
      const { calls } = installFetchStub(
        () => new Response(JSON.stringify({ cancelled: [] }), { status: 200 }),
      );
      const handler = createCodexSwarmEventHandler(buildOpts());
      handler({
        type: "tool_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "ls" },
      });
      // Yield so fire-and-forget fetches actually run.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const urls = calls.map((c) => c.url);
      expect(urls.some((u) => u.includes("/cancelled-tasks?taskId=task-1"))).toBe(true);
      expect(urls.some((u) => u.includes("/api/active-sessions/heartbeat/task-1"))).toBe(true);
      expect(urls.some((u) => u.includes("/api/agents/agent-1/activity"))).toBe(true);
    });

    test("aborts with cancelled reason and logs the task ID when the poll reports cancellation", async () => {
      installFetchStub((url) => {
        if (url.includes("/cancelled-tasks")) {
          return new Response(
            JSON.stringify({ cancelled: [{ id: "task-1", failureReason: "user request" }] }),
            { status: 200 },
          );
        }
        return new Response("{}", { status: 200 });
      });
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
      try {
        const controller = new AbortController();
        const aborted = new Promise<void>((resolve) => {
          controller.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        const handler = createCodexSwarmEventHandler(
          buildOpts({ abortRef: { current: controller }, taskId: "task-1" }),
        );
        handler({
          type: "tool_start",
          toolCallId: "call-1",
          toolName: "bash",
          args: { command: "sleep 9999" },
        });
        await aborted;
        expect(controller.signal.aborted).toBe(true);
        expect(controller.signal.reason).toBe("cancelled");
      } finally {
        console.log = origLog;
      }
      expect(logs).toContain(
        "[swarm-events] aborting task task-1: cancelled via /cancelled-tasks poll",
      );
    });

    test("throttles the cancellation check across rapid tool_start events", async () => {
      const { calls } = installFetchStub(
        () => new Response(JSON.stringify({ cancelled: [] }), { status: 200 }),
      );
      const handler = createCodexSwarmEventHandler(buildOpts());
      for (let i = 0; i < 5; i++) {
        handler({
          type: "tool_start",
          toolCallId: `call-${i}`,
          toolName: "bash",
          args: { command: "ls" },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      const cancellationCalls = calls.filter((c) => c.url.includes("/cancelled-tasks"));
      // Throttle window is 500ms — 5 events fired back-to-back should yield 1 call.
      expect(cancellationCalls.length).toBe(1);
    });

    test("skips all task-scoped fetches when taskId is null", async () => {
      const { calls } = installFetchStub(() => new Response("{}", { status: 200 }));
      const handler = createCodexSwarmEventHandler(buildOpts({ taskId: null }));
      handler({
        type: "tool_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "ls" },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const taskCalls = calls.filter(
        (c) => c.url.includes("/cancelled-tasks") || c.url.includes("/heartbeat/"),
      );
      expect(taskCalls.length).toBe(0);
    });
  });

  describe("context_usage", () => {
    test("forwards a progress event to /api/tasks/:id/context", async () => {
      const { calls } = installFetchStub(() => new Response("{}", { status: 200 }));
      const handler = createCodexSwarmEventHandler(buildOpts());
      handler({ type: "session_init", sessionId: "thread-abc" });
      handler({
        type: "context_usage",
        contextUsedTokens: 1000,
        contextTotalTokens: 200_000,
        contextPercent: 0.005,
        outputTokens: 200,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const ctxCall = calls.find((c) => c.url.includes("/api/tasks/task-1/context"));
      expect(ctxCall).toBeDefined();
      const body = JSON.parse((ctxCall?.init?.body as string) ?? "{}");
      expect(body.eventType).toBe("progress");
      expect(body.sessionId).toBe("thread-abc");
      expect(body.contextUsedTokens).toBe(1000);
      expect(body.contextTotalTokens).toBe(200_000);
    });
  });

  describe("result", () => {
    test("uses the result model's catalog window without a prior context update", () => {
      const { calls } = installFetchStub(() => new Response("{}", { status: 200 }));
      const handler = createCodexSwarmEventHandler(buildOpts());
      handler({ type: "session_init", sessionId: "thread-abc" });
      handler({
        type: "result",
        cost: {
          sessionId: "thread-abc",
          agentId: "agent-1",
          totalCostUsd: 0,
          durationMs: 1234,
          numTurns: 1,
          model: "gpt-5.4",
          isError: false,
        },
        isError: false,
      });

      const snapshots = calls.filter((call) => call.url.includes("/api/tasks/task-1/context"));
      expect(snapshots).toHaveLength(1);
      expect(JSON.parse(String(snapshots[0]?.init?.body))).toEqual({
        eventType: "completion",
        sessionId: "thread-abc",
        contextTotalTokens: 1_050_000,
      });
    });

    test("posts a completion context event", async () => {
      const { calls } = installFetchStub(() => new Response("{}", { status: 200 }));
      const handler = createCodexSwarmEventHandler(buildOpts());
      handler({ type: "session_init", sessionId: "thread-abc" });
      // The second live update is throttled, but its window must reach completion.
      for (const contextTotalTokens of [258_400, 272_000]) {
        handler({
          type: "context_usage",
          contextUsedTokens: 1000,
          contextTotalTokens,
          contextPercent: 1,
          outputTokens: 50,
        });
      }
      handler({
        type: "result",
        cost: {
          sessionId: "thread-abc",
          taskId: "task-1",
          agentId: "agent-1",
          totalCostUsd: 0,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          durationMs: 1234,
          numTurns: 1,
          model: "gpt-5.4",
          isError: false,
        },
        isError: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const ctxCall = calls.find(
        (c) =>
          c.url.includes("/api/tasks/task-1/context") &&
          JSON.parse(String(c.init?.body)).eventType === "completion",
      );
      expect(ctxCall).toBeDefined();
      const body = JSON.parse((ctxCall?.init?.body as string) ?? "{}");
      expect(body.eventType).toBe("completion");
      expect(body.sessionId).toBe("thread-abc");
      expect(body.contextTotalTokens).toBe(272_000);
    });
  });

  describe("error handling", () => {
    test("does not throw when fetch rejects", async () => {
      globalThis.fetch = (async () => {
        throw new Error("network down");
      }) as typeof fetch;
      const handler = createCodexSwarmEventHandler(buildOpts());
      // Should not throw, even though the underlying fetch rejects.
      expect(() =>
        handler({
          type: "tool_start",
          toolCallId: "call-1",
          toolName: "bash",
          args: { command: "ls" },
        }),
      ).not.toThrow();
      expect(() =>
        handler({
          type: "result",
          cost: {
            sessionId: "thread-abc",
            taskId: "task-1",
            agentId: "agent-1",
            totalCostUsd: 0,
            durationMs: 100,
            numTurns: 1,
            model: "gpt-5.4",
            isError: false,
          },
          isError: false,
        }),
      ).not.toThrow();
      // Yield to let the fire-and-forget rejections settle.
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    test("does not throw when the handler is called repeatedly with malformed events", () => {
      installFetchStub(() => new Response("{}", { status: 200 }));
      const handler = createCodexSwarmEventHandler(buildOpts());
      // Bypass the discriminated union to feed in a deliberately weird event.
      const malformed = { type: "tool_start", toolCallId: "x", toolName: "bash", args: null };
      expect(() => handler(malformed as unknown as ProviderEvent)).not.toThrow();
    });
  });
});

describe("Codex web search loop detection", () => {
  test.each([
    { scenario: "distinct queries", count: 20, blocked: false },
    { scenario: "identical queries", count: 15, blocked: true },
    { scenario: "distinct batches sharing the first query", count: 20, blocked: false },
    { scenario: "distinct queries alternating with bash", count: 8, blocked: false },
  ])("checks completed web searches for loops: $scenario", async ({ scenario, count, blocked }) => {
    const taskId = crypto.randomUUID();
    const dir = mkdtempSync(join(tmpdir(), "codex-web-search-"));
    installFetchStub(() => Response.json({}));
    const check = spyOn(toolLoop, "checkToolLoop");
    const withBash = scenario === "distinct queries alternating with bash";
    try {
      const fake = makeFakeAppServer((method, _params, emit) => {
        if (method === "thread/start") return { thread: { id: "thread-search" } };
        if (method !== "turn/start") return {};
        for (let i = 0; i < count; i++) {
          const search = { type: "webSearch", id: `search-${i}` };
          const query = `query ${i}`;
          emit("item/started", { item: { ...search, query: "" } });
          const args =
            scenario === "distinct batches sharing the first query"
              ? { query: "shared", action: { type: "search", queries: ["shared", query] } }
              : { query: blocked ? "same query" : query };
          emit("item/completed", { item: { ...search, ...args } });
          if (withBash) {
            const item = { type: "commandExecution", id: `cmd-${i}`, command: "pwd", exitCode: 0 };
            emit("item/started", { item });
            emit("item/completed", { item });
          }
        }
        emit("turn/completed", { turn: { id: "turn-search", status: "completed" } });
        return { turn: { id: "turn-search" } };
      });
      const session = await new CodexAdapter({
        bypassSubprocess: true,
        appServerFactory: () => fake.client,
      }).createSession({
        prompt: "search",
        systemPrompt: "",
        model: "gpt-5.4",
        role: "worker",
        agentId: "agent-1",
        taskId,
        apiUrl: "http://test-api",
        apiKey: "test",
        cwd: dir,
        logFile: join(dir, "session.log"),
        env: { CODEX_HOME: dir },
      });
      await session.waitForCompletion();

      // The guard serializes its file writes and the adapter fires it asynchronously.
      const checks = await Promise.all(check.mock.results.map((call) => call.value));
      expect(checks).toHaveLength(count * (withBash ? 2 : 1));
      expect(checks.slice(0, -1).every((result) => !result.blocked)).toBe(true);
      expect(checks.at(-1)?.blocked).toBe(blocked);
    } finally {
      check.mockRestore();
      await toolLoop.clearToolHistory(taskId);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
