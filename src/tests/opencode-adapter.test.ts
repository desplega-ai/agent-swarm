/**
 * Unit tests for OpencodeSession lifecycle (DES-299, DES-300).
 *
 * Mocks `@opencode-ai/sdk` so we can drive canned SSE event sequences
 * and verify the SSE→ProviderEvent mapping, cost aggregation, raw_log
 * persistence, and per-task isolation (agent file, config, data home).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

/** Last args captured by the fakeClient.session.prompt mock. */
let lastPromptArgs: unknown;

/** Last config passed to createOpencode mock. */
let lastCreateOpencodeConfig: unknown;

/** Collect all ProviderEvents emitted by a session. */
async function driveSession(
  events: OpencodeEvent[],
  cfg: ProviderSessionConfig = testConfig(),
): Promise<{ emitted: ProviderEvent[]; result: ProviderResult; serverCloseCalls: () => number }> {
  const emitted: ProviderEvent[] = [];

  // Build the fake client/server pair used by the mock
  const fakeSessionId = "sess-abc-123";
  const fakeStream = makeStream(events);

  const fakeClient = {
    session: {
      create: async () => ({ data: { id: fakeSessionId }, error: undefined }),
      prompt: async (args: unknown) => {
        lastPromptArgs = args;
        return { data: {}, error: undefined };
      },
    },
    event: {
      subscribe: async () => ({ stream: fakeStream }),
    },
  };

  const closeServer = mock(() => {});
  const fakeServer = { url: "http://127.0.0.1:12345", close: closeServer };

  // Install mock BEFORE importing the adapter (Bun hoists mock.module)
  mock.module("@opencode-ai/sdk", () => ({
    createOpencode: async (opts: unknown) => {
      lastCreateOpencodeConfig = opts;
      return { client: fakeClient, server: fakeServer };
    },
  }));

  // Dynamic import ensures the mock is applied
  const { OpencodeAdapter } = await import("../providers/opencode-adapter");
  const adapter = new OpencodeAdapter();
  const session = await adapter.createSession(cfg);
  session.onEvent((e) => emitted.push(e));

  // Give microtasks (session_init) a chance to run
  await new Promise((r) => setTimeout(r, 0));

  const result = await session.waitForCompletion();
  return { emitted, result, serverCloseCalls: () => closeServer.mock.calls.length };
}

async function inspectSessionBeforeIdle(
  cfg: ProviderSessionConfig,
  inspect: () => Promise<void>,
): Promise<void> {
  const fakeSessionId = "sess-abc-123";
  let releaseIdle!: () => void;
  const idleReleased = new Promise<void>((resolve) => {
    releaseIdle = resolve;
  });

  const fakeClient = {
    session: {
      create: async () => ({ data: { id: fakeSessionId }, error: undefined }),
      prompt: async (args: unknown) => {
        lastPromptArgs = args;
        return { data: {}, error: undefined };
      },
    },
    event: {
      subscribe: async () => ({
        stream: (async function* (): AsyncGenerator<OpencodeEvent> {
          await idleReleased;
          yield { type: "session.idle", properties: { sessionID: fakeSessionId } };
        })(),
      }),
    },
  };

  const fakeServer = { url: "http://127.0.0.1:12345", close: mock(() => {}) };

  mock.module("@opencode-ai/sdk", () => ({
    createOpencode: async (opts: unknown) => {
      lastCreateOpencodeConfig = opts;
      return { client: fakeClient, server: fakeServer };
    },
  }));

  const { OpencodeAdapter } = await import("../providers/opencode-adapter");
  const adapter = new OpencodeAdapter();
  const session = await adapter.createSession(cfg);
  session.onEvent(() => {});
  await new Promise((r) => setTimeout(r, 0));
  await inspect();
  releaseIdle();
  await session.waitForCompletion();
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
    const { emitted, result, serverCloseCalls } = await driveSession(events);

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
    expect(serverCloseCalls()).toBe(1);
  });

  test("session.idle closes the server and drops later heartbeat events", async () => {
    const events: OpencodeEvent[] = [
      { type: "session.idle", properties: { sessionID: "sess-abc-123" } },
      { type: "server.heartbeat", properties: {} } as OpencodeEvent,
    ];
    const { emitted, serverCloseCalls } = await driveSession(events);

    expect(serverCloseCalls()).toBe(1);
    const rawLogContents = emitted
      .filter((e): e is Extract<ProviderEvent, { type: "raw_log" }> => e.type === "raw_log")
      .map((e) => e.content);
    expect(rawLogContents.some((content) => content.includes("server.heartbeat"))).toBe(false);
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
    const { emitted, result, serverCloseCalls } = await driveSession(events);

    const errorEvent = emitted.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === "error") {
      expect(errorEvent.message).toContain("provider overloaded");
    }
    expect(result.isError).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.failureReason).toContain("provider overloaded");
    expect(serverCloseCalls()).toBe(1);
  });

  test("prompt Model not found refreshes OpenRouter cache and retries once", async () => {
    const emitted: ProviderEvent[] = [];
    const refreshCalls: Array<{ model?: string; configFilePath: string; dataHomePath: string }> =
      [];
    const fakeSessionId = "sess-abc-123";
    let promptCalls = 0;
    let resolveSecondPrompt!: () => void;
    const secondPromptSent = new Promise<void>((resolve) => {
      resolveSecondPrompt = resolve;
    });

    const fakeClient = {
      session: {
        create: async () => ({ data: { id: fakeSessionId }, error: undefined }),
        prompt: async (args: unknown) => {
          lastPromptArgs = args;
          promptCalls += 1;
          if (promptCalls === 1) {
            throw new Error(
              "Model not found: openrouter/x-ai/grok-4.3. Did you mean: x-ai/grok-4.3?",
            );
          }
          resolveSecondPrompt();
          return { data: {}, error: undefined };
        },
      },
      event: {
        subscribe: async () => ({
          stream: (async function* (): AsyncGenerator<OpencodeEvent> {
            await secondPromptSent;
            yield { type: "session.idle", properties: { sessionID: fakeSessionId } };
          })(),
        }),
      },
    };
    const fakeServer = { url: "http://127.0.0.1:12345", close: mock(() => {}) };

    mock.module("@opencode-ai/sdk", () => ({
      createOpencode: async () => ({ client: fakeClient, server: fakeServer }),
    }));

    const { OpencodeAdapter, _setOpenRouterModelCacheRefreshForTests } = await import(
      "../providers/opencode-adapter"
    );
    _setOpenRouterModelCacheRefreshForTests(
      async (opencodeConfig, configFilePath, dataHomePath) => {
        refreshCalls.push({ model: opencodeConfig.model, configFilePath, dataHomePath });
      },
    );
    try {
      const adapter = new OpencodeAdapter();
      const session = await adapter.createSession(
        testConfig({ model: "openrouter/x-ai/grok-4.3", taskId: "task-refresh" }),
      );
      session.onEvent((e) => emitted.push(e));

      const result = await session.waitForCompletion();

      expect(result.isError).toBe(false);
      expect(promptCalls).toBe(2);
      expect(refreshCalls).toEqual([
        {
          model: "openrouter/x-ai/grok-4.3",
          configFilePath: "/tmp/opencode-task-refresh.json",
          dataHomePath: "/tmp/opencode-data-task-refresh",
        },
      ]);
      expect(emitted.some((e) => e.type === "progress" && e.message.includes("refreshing"))).toBe(
        true,
      );
    } finally {
      _setOpenRouterModelCacheRefreshForTests(null);
    }
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
          // Phase 9 fix: accumulator gates on `time.completed` so simulated steps
          // must look like finalized opencode messages.
          time: { created: Date.now(), completed: Date.now() + 1 },
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

// ── Phase 9: context_usage emission ───────────────────────────────────────────

describe("OpencodeSession — context_usage emission (phase 9 fix)", () => {
  beforeEach(() => {
    mock.restore();
  });

  /** Build a `message.updated` event with optional finalize flag. */
  function makeMessageUpdated(
    overrides: {
      sessionID?: string;
      completed?: boolean;
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      cost?: number;
      modelID?: string;
    } = {},
  ): OpencodeEvent {
    const now = Date.now();
    return {
      type: "message.updated",
      properties: {
        info: {
          id: `msg-${now}`,
          sessionID: overrides.sessionID ?? "sess-abc-123",
          role: "assistant",
          cost: overrides.cost ?? 0.001,
          tokens: {
            input: overrides.input ?? 0,
            output: overrides.output ?? 0,
            reasoning: 0,
            cache: {
              read: overrides.cacheRead ?? 0,
              write: overrides.cacheWrite ?? 0,
            },
          },
          time: overrides.completed ? { created: now, completed: now + 1 } : { created: now },
          parentID: "",
          modelID: overrides.modelID ?? "claude-sonnet-4-5",
          providerID: "anthropic",
          mode: "live",
          path: { cwd: "/", root: "/" },
        } as never,
      },
    };
  }

  test("finalized message with real tokens → emits context_usage matching the cost row", async () => {
    // Mirrors the E2E evidence: opencode reports `in=12, cache.read=99970,
    // cache.write=104606, out=288` on the FINAL message.updated for the turn.
    const events: OpencodeEvent[] = [
      makeMessageUpdated({
        completed: true,
        input: 12,
        output: 288,
        cacheRead: 99970,
        cacheWrite: 104606,
      }),
      { type: "session.idle", properties: { sessionID: "sess-abc-123" } },
    ];

    const { emitted, result } = await driveSession(events);

    const contextEvents = emitted.filter((e) => e.type === "context_usage");
    expect(contextEvents.length).toBe(1);
    const ctx = contextEvents[0];
    if (ctx?.type === "context_usage") {
      // Unified formula: input + cache_read + cache_write + output
      expect(ctx.contextUsedTokens).toBe(12 + 99970 + 104606 + 288);
      expect(ctx.contextFormula).toBe("input-cache-output");
      expect(ctx.outputTokens).toBe(288);
      expect(ctx.contextTotalTokens).toBeGreaterThan(0);
      expect(ctx.contextPercent).toBeGreaterThan(0);
    }
    // The cost row stays consistent — same tokens, single turn.
    expect(result.cost?.inputTokens).toBe(12);
    expect(result.cost?.cacheReadTokens).toBe(99970);
    expect(result.cost?.cacheWriteTokens).toBe(104606);
    expect(result.cost?.outputTokens).toBe(288);
    expect(result.cost?.numTurns).toBe(1);
  });

  test("non-finalized message.updated (tokens all zero) → NO context_usage emission", async () => {
    // Simulates opencode's intermediate streaming updates that arrive before
    // the model returns usage counts. Pre-fix, these emitted a 0-token snapshot
    // that the runner-side throttle pinned for the rest of the session.
    const events: OpencodeEvent[] = [
      makeMessageUpdated({ completed: false }),
      makeMessageUpdated({ completed: false }),
      { type: "session.idle", properties: { sessionID: "sess-abc-123" } },
    ];

    const { emitted, result } = await driveSession(events);

    const contextEvents = emitted.filter((e) => e.type === "context_usage");
    expect(contextEvents.length).toBe(0);
    // Cost accumulator also skipped non-finalized updates.
    expect(result.cost?.numTurns).toBe(0);
    expect(result.cost?.totalCostUsd).toBe(0);
  });

  test("mix of streaming-zero updates then finalized update → exactly one context_usage from the final", async () => {
    // The realistic opencode event stream: many intermediate zero-token updates
    // followed by a single finalized update. Only the finalized one should
    // produce a context_usage row.
    const events: OpencodeEvent[] = [
      makeMessageUpdated({ completed: false }),
      makeMessageUpdated({ completed: false }),
      makeMessageUpdated({
        completed: true,
        input: 50,
        output: 200,
        cacheRead: 1000,
        cacheWrite: 500,
      }),
      { type: "session.idle", properties: { sessionID: "sess-abc-123" } },
    ];

    const { emitted, result } = await driveSession(events);

    const contextEvents = emitted.filter((e) => e.type === "context_usage");
    expect(contextEvents.length).toBe(1);
    if (contextEvents[0]?.type === "context_usage") {
      expect(contextEvents[0].contextUsedTokens).toBe(50 + 1000 + 500 + 200);
    }
    expect(result.cost?.numTurns).toBe(1);
    expect(result.cost?.inputTokens).toBe(50);
  });

  test("finalized message with all-zero tokens → still no emission (guards against pathological zero turns)", async () => {
    const events: OpencodeEvent[] = [
      makeMessageUpdated({ completed: true }), // all zero tokens
      { type: "session.idle", properties: { sessionID: "sess-abc-123" } },
    ];

    const { emitted } = await driveSession(events);
    const contextEvents = emitted.filter((e) => e.type === "context_usage");
    expect(contextEvents.length).toBe(0);
  });
});

// ── DES-300: per-task isolation ────────────────────────────────────────────────

describe("OpencodeAdapter — per-task isolation (DES-300)", () => {
  beforeEach(() => {
    lastPromptArgs = undefined;
    lastCreateOpencodeConfig = undefined;
    mock.restore();
  });

  afterEach(() => {
    // Clean up any written files from tests
    Bun.$`rm -rf /tmp/opencode-task-1.json /tmp/opencode-data-task-1`.quiet().nothrow();
    Bun.$`rm -rf /tmp/test/.opencode`.quiet().nothrow();
  });

  test("session.prompt receives agent=swarm-<taskId>", async () => {
    const events: OpencodeEvent[] = [
      { type: "session.idle", properties: { sessionID: "sess-abc-123" } },
    ];
    const cfg = testConfig({ taskId: "task-1" });
    await driveSession(events, cfg);

    expect(lastPromptArgs).toBeDefined();
    const args = lastPromptArgs as { body?: { agent?: string } };
    expect(args.body?.agent).toBe("swarm-task-1");
  });

  test("createOpencode receives config with model, mcp.swarm, and permission", async () => {
    const events: OpencodeEvent[] = [
      { type: "session.idle", properties: { sessionID: "sess-abc-123" } },
    ];
    const cfg = testConfig({
      taskId: "task-1",
      model: "claude-sonnet-4-6",
      apiUrl: "http://localhost:9999",
      apiKey: "mykey",
      agentId: "agent-42",
    });
    await driveSession(events, cfg);

    expect(lastCreateOpencodeConfig).toBeDefined();
    const opts = lastCreateOpencodeConfig as {
      config?: {
        model?: string;
        mcp?: Record<string, unknown>;
        permission?: Record<string, string>;
      };
    };
    expect(opts.config?.model).toBe("claude-sonnet-4-6");
    expect(opts.config?.mcp?.swarm).toBeDefined();
    const swarm = opts.config?.mcp?.swarm as {
      type: string;
      url: string;
      headers?: Record<string, string>;
    };
    expect(swarm.type).toBe("remote");
    expect(swarm.url).toContain("http://localhost:9999");
    expect(swarm.headers?.Authorization).toContain("mykey");
    expect(opts.config?.permission?.edit).toBe("allow");
  });

  test("per-task agent file is written with system prompt", async () => {
    const cwd = `/tmp/opencode-test-agent-${Date.now()}`;
    await Bun.$`mkdir -p ${cwd}`.quiet();
    const cfg = testConfig({ taskId: "task-agent-file", systemPrompt: "be a coder", cwd });
    await inspectSessionBeforeIdle(cfg, async () => {
      const agentFile = Bun.file(join(cwd, ".opencode", "agents", "swarm-task-agent-file.md"));
      const exists = await agentFile.exists();
      expect(exists).toBe(true);
      if (exists) {
        const content = await agentFile.text();
        expect(content).toContain("be a coder");
      }
    });

    // Cleanup
    await Bun.$`rm -rf ${cwd}`.quiet().nothrow();
  });

  test("per-task config file is written as valid JSON", async () => {
    const cfg = testConfig({ taskId: "task-cfg-json" });
    await inspectSessionBeforeIdle(cfg, async () => {
      const configFile = Bun.file("/tmp/opencode-task-cfg-json.json");
      const exists = await configFile.exists();
      expect(exists).toBe(true);
      if (exists) {
        const text = await configFile.text();
        expect(() => JSON.parse(text)).not.toThrow();
        const parsed = JSON.parse(text) as { mcp?: unknown; permission?: unknown };
        expect(parsed.mcp).toBeDefined();
        expect(parsed.permission).toBeDefined();
      }
    });

    // Cleanup
    await Bun.$`rm -f /tmp/opencode-task-cfg-json.json`.quiet().nothrow();
    await Bun.$`rm -rf /tmp/opencode-data-task-cfg-json`.quiet().nothrow();
  });
});

// ── Phase 4: context-mode in-process plugin ────────────────────────────────────

describe("OpencodeAdapter — context-mode plugin wiring (phase 4)", () => {
  let prevContextModeDisabled: string | undefined;
  let prevContextModePluginPath: string | undefined;
  // The global npm install of context-mode is absent in the test env, so point
  // the override at a real temp file to make resolution succeed deterministically.
  const fakePluginPath = "/tmp/ctx-mode-opencode-plugin.test.js";

  beforeEach(() => {
    prevContextModeDisabled = process.env.CONTEXT_MODE_DISABLED;
    prevContextModePluginPath = process.env.CONTEXT_MODE_OPENCODE_PLUGIN_PATH;
    lastCreateOpencodeConfig = undefined;
    mock.restore();
  });

  afterEach(() => {
    // Never leak the env mutations across tests.
    if (prevContextModeDisabled === undefined) delete process.env.CONTEXT_MODE_DISABLED;
    else process.env.CONTEXT_MODE_DISABLED = prevContextModeDisabled;
    if (prevContextModePluginPath === undefined)
      delete process.env.CONTEXT_MODE_OPENCODE_PLUGIN_PATH;
    else process.env.CONTEXT_MODE_OPENCODE_PLUGIN_PATH = prevContextModePluginPath;
    Bun.$`rm -rf /tmp/opencode-task-1.json /tmp/opencode-data-task-1`.quiet().nothrow();
    Bun.$`rm -rf /tmp/test/.opencode`.quiet().nothrow();
    Bun.$`rm -f ${fakePluginPath}`.quiet().nothrow();
  });

  /** Pull the opencode config object passed to createOpencode. */
  function getBuiltConfig(): { plugin?: string[]; mcp?: Record<string, unknown> } {
    const opts = lastCreateOpencodeConfig as {
      config?: { plugin?: string[]; mcp?: Record<string, unknown> };
    };
    expect(opts.config).toBeDefined();
    return opts.config as { plugin?: string[]; mcp?: Record<string, unknown> };
  }

  test("resolveContextModePluginPath returns the override path when it exists", async () => {
    writeFileSync(fakePluginPath, "// test plugin\n");
    process.env.CONTEXT_MODE_OPENCODE_PLUGIN_PATH = fakePluginPath;
    const { resolveContextModePluginPath } = await import("../providers/opencode-adapter");
    expect(resolveContextModePluginPath()).toBe(fakePluginPath);
  });

  test("resolveContextModePluginPath returns null when the override path is missing", async () => {
    process.env.CONTEXT_MODE_OPENCODE_PLUGIN_PATH = "/tmp/ctx-mode-does-not-exist.js";
    const { resolveContextModePluginPath } = await import("../providers/opencode-adapter");
    expect(resolveContextModePluginPath()).toBeNull();
  });

  test("plugin array includes the resolved context-mode plugin path when available", async () => {
    delete process.env.CONTEXT_MODE_DISABLED;
    writeFileSync(fakePluginPath, "// test plugin\n");
    process.env.CONTEXT_MODE_OPENCODE_PLUGIN_PATH = fakePluginPath;
    const events: OpencodeEvent[] = [
      { type: "session.idle", properties: { sessionID: "sess-abc-123" } },
    ];
    await driveSession(events, testConfig({ taskId: "task-1" }));

    const built = getBuiltConfig();
    expect(built.plugin).toContain(fakePluginPath);
    // The bare package name must never be used — opencode can't resolve it offline.
    expect(built.plugin).not.toContain("context-mode");
  });

  test("plugin array excludes context-mode when CONTEXT_MODE_DISABLED=true", async () => {
    process.env.CONTEXT_MODE_DISABLED = "true";
    writeFileSync(fakePluginPath, "// test plugin\n");
    process.env.CONTEXT_MODE_OPENCODE_PLUGIN_PATH = fakePluginPath;
    const events: OpencodeEvent[] = [
      { type: "session.idle", properties: { sessionID: "sess-abc-123" } },
    ];
    await driveSession(events, testConfig({ taskId: "task-1" }));

    const built = getBuiltConfig();
    expect(built.plugin).not.toContain(fakePluginPath);
    expect(built.plugin).not.toContain("context-mode");
  });

  test("context-mode does NOT appear in the mcp block", async () => {
    delete process.env.CONTEXT_MODE_DISABLED;
    writeFileSync(fakePluginPath, "// test plugin\n");
    process.env.CONTEXT_MODE_OPENCODE_PLUGIN_PATH = fakePluginPath;
    const events: OpencodeEvent[] = [
      { type: "session.idle", properties: { sessionID: "sess-abc-123" } },
    ];
    await driveSession(events, testConfig({ taskId: "task-1" }));

    const built = getBuiltConfig();
    expect(built.mcp).toBeDefined();
    expect(built.mcp?.["context-mode"]).toBeUndefined();
  });
});
