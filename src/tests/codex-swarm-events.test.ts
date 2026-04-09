import { afterEach, describe, expect, test } from "bun:test";
import {
  type CodexSwarmEventHandlerOpts,
  createCodexSwarmEventHandler,
} from "../providers/codex-swarm-events";
import type { ProviderEvent } from "../providers/types";

/**
 * Captured fetch invocation, recorded by the stub installed for each test.
 * `init` is the second argument to `fetch` (method, headers, body).
 */
interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

const originalFetch = globalThis.fetch;

function buildOpts(override: Partial<CodexSwarmEventHandlerOpts> = {}): CodexSwarmEventHandlerOpts {
  return {
    apiUrl: "http://test-api",
    apiKey: "test-key",
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

    test("aborts the running turn when the cancellation endpoint reports cancelled", async () => {
      installFetchStub((url) => {
        if (url.includes("/cancelled-tasks")) {
          return new Response(
            JSON.stringify({ cancelled: [{ id: "task-1", failureReason: "user request" }] }),
            { status: 200 },
          );
        }
        return new Response("{}", { status: 200 });
      });
      const controller = new AbortController();
      const opts = buildOpts({ abortRef: { current: controller } });
      const handler = createCodexSwarmEventHandler(opts);
      handler({
        type: "tool_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "sleep 9999" },
      });
      // Wait for the async cancellation poll to resolve and call abort().
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(controller.signal.aborted).toBe(true);
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
    test("posts a completion context event", async () => {
      const { calls } = installFetchStub(() => new Response("{}", { status: 200 }));
      const handler = createCodexSwarmEventHandler(buildOpts());
      handler({ type: "session_init", sessionId: "thread-abc" });
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
      const ctxCall = calls.find((c) => c.url.includes("/api/tasks/task-1/context"));
      expect(ctxCall).toBeDefined();
      const body = JSON.parse((ctxCall?.init?.body as string) ?? "{}");
      expect(body.eventType).toBe("completion");
      expect(body.sessionId).toBe("thread-abc");
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
