/**
 * Unit tests for OpencodeSession lifecycle (DES-299).
 *
 * Mocks `@opencode-ai/sdk` so we can drive canned SSE event sequences
 * and verify the SSE→ProviderEvent mapping, cost aggregation, and raw_log
 * persistence — all without starting a real opencode server.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Event as OpencodeEvent } from "@opencode-ai/sdk";
import type { ProviderEvent, ProviderResult, ProviderSessionConfig } from "../providers/types";

// ── helpers ──────────────────────────────────────────────────────────────────

function testConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
  return {
    prompt: "do something",
    systemPrompt: "be helpful",
    model: "claude-opus-4",
    role: "worker",
    agentId: "agent-1",
    taskId: "task-1",
    apiUrl: "http://localhost:0",
    apiKey: "test-key",
    cwd: "/tmp/test",
    logFile: "/tmp/test.log",
    ...overrides,
  };
}

/** Build a fake opencode SSE stream from a list of events. */
function makeStream(events: OpencodeEvent[]): AsyncGenerator<OpencodeEvent> {
  async function* gen(): AsyncGenerator<OpencodeEvent> {
    for (const ev of events) yield ev;
  }
  return gen();
}

/** Collect all ProviderEvents emitted by a session. */
async function driveSession(
  events: OpencodeEvent[],
  cfg: ProviderSessionConfig = testConfig(),
): Promise<{ emitted: ProviderEvent[]; result: ProviderResult }> {
  const emitted: ProviderEvent[] = [];

  // Build the fake client/server pair used by the mock
  const fakeSessionId = "sess-abc-123";
  const fakeStream = makeStream(events);

  const fakeClient = {
    session: {
      create: async () => ({ data: { id: fakeSessionId }, error: undefined }),
      prompt: async () => ({ data: {}, error: undefined }),
    },
    event: {
      subscribe: async () => ({ stream: fakeStream }),
    },
  };

  const fakeServer = { url: "http://127.0.0.1:12345", close: mock(() => {}) };

  // Install mock BEFORE importing the adapter (Bun hoists mock.module)
  mock.module("@opencode-ai/sdk", () => ({
    createOpencode: async () => ({ client: fakeClient, server: fakeServer }),
  }));

  // Dynamic import ensures the mock is applied
  const { OpencodeAdapter } = await import("../providers/opencode-adapter");
  const adapter = new OpencodeAdapter();
  const session = await adapter.createSession(cfg);
  session.onEvent((e) => emitted.push(e));

  // Give microtasks (session_init) a chance to run
  await new Promise((r) => setTimeout(r, 0));

  const result = await session.waitForCompletion();
  return { emitted, result };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("OpencodeSession — SSE→ProviderEvent mapping", () => {
  beforeEach(() => {
    // Reset module mock cache between tests so each test gets a fresh instance
    mock.restore();
  });

  test("session.idle → emits result with isError=false", async () => {
    const events: OpencodeEvent[] = [
      {
        type: "session.idle",
        properties: { sessionID: "sess-abc-123" },
      },
    ];
    const { emitted, result } = await driveSession(events);

    const resultEvent = emitted.find((e) => e.type === "result");
    expect(resultEvent).toBeDefined();
    if (resultEvent?.type === "result") {
      expect(resultEvent.isError).toBe(false);
      expect(resultEvent.cost).toBeDefined();
      expect(resultEvent.cost.provider).toBe("opencode");
    }
    expect(result.isError).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("sess-abc-123");
  });

  test("session.error → emits error event and fails result", async () => {
    const events: OpencodeEvent[] = [
      {
        type: "session.error",
        properties: {
          sessionID: "sess-abc-123",
          error: { message: "provider overloaded" } as never,
        },
      },
    ];
    const { emitted, result } = await driveSession(events);

    const errorEvent = emitted.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === "error") {
      expect(errorEvent.message).toContain("provider overloaded");
    }
    expect(result.isError).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.failureReason).toContain("provider overloaded");
  });

  test("permission.updated → emits error (headless cannot approve)", async () => {
    const events: OpencodeEvent[] = [
      {
        type: "permission.updated",
        properties: {
          id: "perm-1",
          type: "bash",
          sessionID: "sess-abc-123",
          messageID: "msg-1",
          title: "Run shell command",
          metadata: {},
          time: { created: Date.now() },
        },
      },
    ];
    const { emitted, result } = await driveSession(events);

    const errorEvent = emitted.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === "error") {
      expect(errorEvent.message).toContain("Permission request");
    }
    expect(result.isError).toBe(true);
  });

  test("message.updated (other session) → ignored", async () => {
    const events: OpencodeEvent[] = [
      {
        type: "message.updated",
        properties: {
          info: {
            id: "msg-other",
            sessionID: "other-session",
            role: "assistant",
            cost: 999,
            tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: Date.now() },
            parentID: "",
            modelID: "claude-opus",
            providerID: "anthropic",
            mode: "live",
            path: { cwd: "/", root: "/" },
          } as never,
        },
      },
      { type: "session.idle", properties: { sessionID: "sess-abc-123" } },
    ];
    const { result } = await driveSession(events);
    // The other-session cost should NOT be accumulated
    expect(result.cost?.totalCostUsd).toBe(0);
  });

  test("all events emit a raw_log", async () => {
    const events: OpencodeEvent[] = [
      { type: "session.idle", properties: { sessionID: "sess-abc-123" } },
    ];
    const { emitted } = await driveSession(events);

    const rawLogs = emitted.filter((e) => e.type === "raw_log");
    expect(rawLogs.length).toBeGreaterThan(0);
  });
});

describe("OpencodeSession — cost aggregation", () => {
  beforeEach(() => {
    mock.restore();
  });

  test("N message.updated steps → totalCostUsd is the sum", async () => {
    const stepCosts = [0.001, 0.002, 0.0015];
    const stepEvents: OpencodeEvent[] = stepCosts.map((cost, i) => ({
      type: "message.updated",
      properties: {
        info: {
          id: `msg-${i}`,
          sessionID: "sess-abc-123",
          role: "assistant",
          cost,
          tokens: {
            input: 100 + i * 10,
            output: 50 + i * 5,
            reasoning: 0,
            cache: { read: i * 2, write: i },
          },
          time: { created: Date.now() },
          parentID: "",
          modelID: "claude-opus",
          providerID: "anthropic",
          mode: "live",
          path: { cwd: "/", root: "/" },
        } as never,
      },
    }));

    const events: OpencodeEvent[] = [
      ...stepEvents,
      { type: "session.idle", properties: { sessionID: "sess-abc-123" } },
    ];

    const { result } = await driveSession(events);
    const expected = stepCosts.reduce((a, b) => a + b, 0);
    expect(result.cost?.totalCostUsd).toBeCloseTo(expected, 10);
    expect(result.cost?.numTurns).toBe(stepCosts.length);
    expect(result.cost?.inputTokens).toBe(100 + 110 + 120);
    expect(result.cost?.outputTokens).toBe(50 + 55 + 60);
    expect(result.cost?.cacheReadTokens).toBe(0 + 2 + 4);
    expect(result.cost?.cacheWriteTokens).toBe(0 + 1 + 2);
  });

  test("cost data includes provider='opencode'", async () => {
    const events: OpencodeEvent[] = [
      { type: "session.idle", properties: { sessionID: "sess-abc-123" } },
    ];
    const { result } = await driveSession(events);
    expect(result.cost?.provider).toBe("opencode");
  });

  test("cost data includes taskId and agentId from config", async () => {
    const cfg = testConfig({ taskId: "my-task", agentId: "my-agent" });
    const events: OpencodeEvent[] = [
      { type: "session.idle", properties: { sessionID: "sess-abc-123" } },
    ];
    const { result } = await driveSession(events, cfg);
    expect(result.cost?.taskId).toBe("my-task");
    expect(result.cost?.agentId).toBe("my-agent");
  });
});

describe("OpencodeSession — raw_log persistence", () => {
  beforeEach(() => {
    mock.restore();
  });

  test("every SSE event produces at least one raw_log row", async () => {
    const events: OpencodeEvent[] = [
      {
        type: "message.updated",
        properties: {
          info: {
            id: "msg-1",
            sessionID: "sess-abc-123",
            role: "assistant",
            cost: 0.001,
            tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: Date.now() },
            parentID: "",
            modelID: "claude-opus",
            providerID: "anthropic",
            mode: "live",
            path: { cwd: "/", root: "/" },
          } as never,
        },
      },
      { type: "session.idle", properties: { sessionID: "sess-abc-123" } },
    ];

    const { emitted } = await driveSession(events);
    const rawLogs = emitted.filter((e) => e.type === "raw_log");
    // At minimum: one per SSE event + one for the result event
    expect(rawLogs.length).toBeGreaterThanOrEqual(events.length);
  });

  test("raw_log content is a valid JSON string", async () => {
    const events: OpencodeEvent[] = [
      { type: "session.idle", properties: { sessionID: "sess-abc-123" } },
    ];
    const { emitted } = await driveSession(events);
    const rawLogs = emitted.filter((e) => e.type === "raw_log");
    for (const rl of rawLogs) {
      if (rl.type === "raw_log") {
        expect(() => JSON.parse(rl.content)).not.toThrow();
      }
    }
  });
});
