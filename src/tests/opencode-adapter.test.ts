/**
 * Unit tests for the OpenCode 2 adapter.
 *
 * A fake embedded host stands in for `@opencode/sdk` (injected through
 * `_setOpencodeSdkLoaderForTests`), so these tests drive canned OpenCode 2
 * events through the adapter and check the ProviderEvent mapping, cost,
 * config wiring, steering, abort, and stream-death handling.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { OpenCodeEvent } from "@opencode/sdk";
import {
  _setOpencodeSdkLoaderForTests,
  _setOpencodeSessionHooksForTests,
  applyOpenRouterBaseUrlOverride,
  OpencodeAdapter,
  type OpencodeSession,
  resolveOpencodeSdkSpecifier,
} from "../providers/opencode-adapter";
import type { ProviderEvent, ProviderSessionConfig } from "../providers/types";

const SESSION_ID = "ses_test";

function testConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
  return {
    prompt: "do something",
    systemPrompt: "be helpful",
    model: "openrouter/google/gemini-3-flash-preview",
    role: "worker",
    agentId: "agent-1",
    taskId: "task-1",
    apiUrl: "http://127.0.0.1:9",
    apiKey: "example-test-key",
    cwd: "/tmp/opencode-adapter-test",
    logFile: "/tmp/opencode-adapter-test.log",
    ...overrides,
  };
}

/** Builds a typed event; the adapter only reads `type` and `data`. */
function ev(type: string, data: Record<string, unknown>): OpenCodeEvent {
  return { id: `evt_${type}`, created: 0, type, data } as unknown as OpenCodeEvent;
}

const tokens = (input: number, output: number, read = 0, write = 0) => ({
  input,
  output,
  reasoning: 0,
  cache: { read, write },
});

type FakeHost = ReturnType<typeof makeFakeHost>;

type McpStatus =
  | { status: "connected" | "pending" | "disabled" }
  | { status: "failed" | "needs_auth"; error: string };

type FakeHostOptions = {
  endStream?: boolean;
  promptError?: Error;
  /** Swarm MCP status per `mcp.list` call; the last entry repeats. Omit the server with `null`. */
  mcpStatuses?: Array<McpStatus | null>;
  /** Registered tool ids the plugin's tool lister returns. */
  tools?: string[];
};

/**
 * An embedded host whose event stream replays `events`, then either ends
 * (`endStream`) or stays open until `close()`. By default its swarm MCP
 * server is connected with `store-progress` registered.
 */
function makeFakeHost(events: OpenCodeEvent[], opts: FakeHostOptions = {}) {
  const statuses = opts.mcpStatuses ?? [{ status: "connected" }];
  let release: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const host = {
    createOptions: undefined as unknown as Record<string, unknown>,
    created: [] as unknown[],
    prompts: [] as Array<Record<string, unknown>>,
    interrupts: [] as unknown[],
    closeCalls: 0,
    mcpListCalls: 0,
    mcp: {
      list: async () => {
        const status = statuses[Math.min(host.mcpListCalls, statuses.length - 1)];
        host.mcpListCalls++;
        return { location: {}, data: status ? [{ name: "swarm", status }] : [] };
      },
    },
    tools: opts.tools ?? ["read", "swarm_store-progress"],
    sessions: {
      create: async (input: unknown) => {
        host.created.push(input);
        return { id: SESSION_ID };
      },
      prompt: async (input: Record<string, unknown>) => {
        if (opts.promptError) throw opts.promptError;
        host.prompts.push(input);
        return {};
      },
      interrupt: async (input: unknown) => {
        host.interrupts.push(input);
        return {};
      },
    },
    events: {
      async *subscribe() {
        for (const event of events) yield event;
        if (!opts.endStream) await closed;
      },
    },
    close: async () => {
      host.closeCalls++;
      release();
    },
  };
  return host;
}

function installHost(host: FakeHost) {
  _setOpencodeSdkLoaderForTests(async () => ({
    version: "2.0.28",
    sdk: {
      OpenCode: {
        create: async (options: Record<string, unknown>) => {
          host.createOptions = options;
          // Set the plugins up the way OpenCode does, with a stub context.
          const plugins = options.plugins as Array<{ setup: (ctx: unknown) => Promise<void> }>;
          for (const plugin of plugins) {
            await plugin.setup({
              tool: {
                hook: async () => {},
                list: async () => host.tools.map((id) => ({ id })),
              },
              session: { hook: async () => {} },
            });
          }
          return host;
        },
      },
    } as never,
  }));
}

async function startSession(
  events: OpenCodeEvent[],
  cfg: ProviderSessionConfig = testConfig(),
  opts: FakeHostOptions = {},
) {
  const host = makeFakeHost(events, opts);
  installHost(host);
  const session = (await new OpencodeAdapter().createSession(cfg)) as OpencodeSession;
  const emitted: ProviderEvent[] = [];
  session.onEvent((e) => emitted.push(e));
  return { host, session, emitted };
}

async function runSession(
  events: OpenCodeEvent[],
  cfg?: ProviderSessionConfig,
  opts?: FakeHostOptions,
) {
  const started = await startSession(events, cfg, opts);
  const result = await started.session.waitForCompletion();
  return { ...started, result };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await Bun.sleep(5);
  }
}

function configOf(host: FakeHost): Record<string, any> {
  const config = host.createOptions.config as { content: string };
  return JSON.parse(config.content);
}

const succeeded = ev("session.execution.succeeded", { sessionID: SESSION_ID });

const prevEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const key of ["SKIP_SESSION_SUMMARY", "CONTEXT_MODE_DISABLED", "OPENCODE_SDK_PATH"]) {
    prevEnv[key] = process.env[key];
  }
  process.env.SKIP_SESSION_SUMMARY = "1";
  delete process.env.CONTEXT_MODE_DISABLED;
});
afterAll(() => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
afterEach(() => {
  _setOpencodeSdkLoaderForTests(null);
  _setOpencodeSessionHooksForTests(null);
});

describe("OpencodeAdapter — host and config wiring", () => {
  test("passes the per-task config as content and the swarm plugin as an object", async () => {
    const { host } = await runSession([succeeded], testConfig({ contextKey: "ctx-1" }));
    const config = configOf(host);

    expect(config.model).toBe("openrouter/google/gemini-3-flash-preview");
    expect(config.permission).toMatchObject({ edit: "allow", bash: "allow" });
    expect(config.agent).toEqual({ swarm: { mode: "primary", prompt: "be helpful" } });
    expect(config.mcp.swarm).toMatchObject({
      type: "remote",
      url: "http://127.0.0.1:9/mcp",
      headers: {
        Authorization: "Bearer example-test-key",
        "X-Agent-ID": "agent-1",
        "X-Source-Task-Id": "task-1",
        "X-Context-Key": "ctx-1",
      },
    });
    expect(config.mcp["context-mode"]).toMatchObject({ type: "local", command: ["context-mode"] });

    const plugins = host.createOptions.plugins as Array<{ id: string; setup: unknown }>;
    expect(plugins.map((p) => p.id)).toEqual(["agent-swarm"]);
    expect(typeof plugins[0]?.setup).toBe("function");
  });

  test("creates the session in the task cwd with the swarm agent and queues the prompt", async () => {
    const { host, session } = await startSession([]);
    await waitFor(() => host.prompts.length > 0);
    expect(host.created).toEqual([
      { location: { directory: "/tmp/opencode-adapter-test" }, agent: "swarm" },
    ]);
    expect(host.prompts).toEqual([
      { sessionID: SESSION_ID, text: "do something", delivery: "queue" },
    ]);
    await session.abort();
  });

  test("context-mode is not wired when CONTEXT_MODE_DISABLED is set", async () => {
    process.env.CONTEXT_MODE_DISABLED = "true";
    try {
      const { host } = await runSession([succeeded]);
      expect(configOf(host).mcp["context-mode"]).toBeUndefined();
    } finally {
      delete process.env.CONTEXT_MODE_DISABLED;
    }
  });

  test("reasoningEffort on an openrouter model sets provider options", async () => {
    const { host } = await runSession([succeeded], testConfig({ reasoningEffort: "low" }));
    expect(
      configOf(host).provider.openrouter.models["google/gemini-3-flash-preview"].options,
    ).toEqual({ reasoning: { effort: "low" } });
  });

  test("session_init carries the SDK version", async () => {
    const { emitted } = await runSession([succeeded]);
    expect(emitted[0]).toMatchObject({
      type: "session_init",
      sessionId: SESSION_ID,
      provider: "opencode",
      harnessVariantMeta: { version: "2.0.28" },
    });
  });

  test("OPENCODE_SDK_PATH overrides the SDK lookup", () => {
    process.env.OPENCODE_SDK_PATH = "/opt/opencode/sdk/dist/index.js";
    try {
      expect(resolveOpencodeSdkSpecifier()).toBe("/opt/opencode/sdk/dist/index.js");
    } finally {
      delete process.env.OPENCODE_SDK_PATH;
    }
  });
});

describe("OpencodeSession — event mapping", () => {
  test("tool, text, step and usage events map to provider events and cost", async () => {
    const { result, emitted, host } = await runSession([
      ev("session.tool.input.started", { sessionID: SESSION_ID, id: "call_1", name: "shell" }),
      ev("session.tool.called", { sessionID: SESSION_ID, id: "call_1", input: { command: "ls" } }),
      ev("session.tool.success", {
        sessionID: SESSION_ID,
        id: "call_1",
        content: [{ type: "text", text: "file.txt\n" }],
      }),
      ev("session.tool.input.started", { sessionID: SESSION_ID, id: "call_2", name: "read" }),
      ev("session.tool.called", { sessionID: SESSION_ID, id: "call_2", input: {} }),
      ev("session.tool.failed", {
        sessionID: SESSION_ID,
        id: "call_2",
        error: { type: "unknown", message: "no such file" },
      }),
      ev("session.step.ended", { sessionID: SESSION_ID, tokens: tokens(1000, 10, 200, 0) }),
      ev("session.text.ended", {
        sessionID: SESSION_ID,
        assistantMessageID: "msg_2",
        ordinal: 0,
        text: "All done.",
      }),
      ev("session.step.ended", { sessionID: SESSION_ID, tokens: tokens(1200, 5) }),
      ev("session.usage.updated", {
        sessionID: SESSION_ID,
        cost: 0.42,
        tokens: tokens(2200, 15, 200, 0),
      }),
      succeeded,
    ]);

    const visible = emitted.filter((e) => e.type !== "raw_log");
    expect(visible.map((e) => e.type)).toEqual([
      "session_init",
      "tool_start",
      "tool_end",
      "tool_start",
      "tool_end",
      "context_usage",
      "message",
      "context_usage",
      "result",
    ]);
    expect(visible[1]).toEqual({
      type: "tool_start",
      toolCallId: "call_1",
      toolName: "shell",
      args: { command: "ls" },
    });
    expect(visible[2]).toMatchObject({ toolName: "shell", result: "file.txt\n", isError: false });
    expect(visible[4]).toMatchObject({ toolName: "read", result: "no such file", isError: true });
    expect(visible[5]).toMatchObject({ contextUsedTokens: 1210, outputTokens: 10 });
    expect(visible[6]).toEqual({
      type: "message",
      role: "assistant",
      content: "All done.",
      messageId: "msg_2",
    });

    expect(result.exitCode).toBe(0);
    expect(result.isError).toBe(false);
    expect(result.cost).toMatchObject({
      totalCostUsd: 0.42,
      inputTokens: 2200,
      outputTokens: 15,
      cacheReadTokens: 200,
      numTurns: 2,
      provider: "opencode",
      taskId: "task-1",
      agentId: "agent-1",
    });
    expect(host.closeCalls).toBe(1);
  });

  test("text parts of one message are joined in order", async () => {
    const { emitted } = await runSession([
      ev("session.text.ended", {
        sessionID: SESSION_ID,
        assistantMessageID: "m",
        ordinal: 0,
        text: "a ",
      }),
      ev("session.text.ended", {
        sessionID: SESSION_ID,
        assistantMessageID: "m",
        ordinal: 1,
        text: "b",
      }),
      succeeded,
    ]);
    const messages = emitted.filter((e) => e.type === "message");
    expect(messages.map((m) => (m as { content: string }).content)).toEqual(["a", "a b"]);
  });

  test("events from other sessions are ignored", async () => {
    const { result, emitted } = await runSession([
      ev("session.execution.failed", { sessionID: "ses_child", error: { message: "child" } }),
      ev("session.usage.updated", { sessionID: "ses_child", cost: 9, tokens: tokens(1, 1) }),
      succeeded,
    ]);
    expect(result.isError).toBe(false);
    expect(result.cost?.totalCostUsd).toBe(0);
    expect(emitted.some((e) => e.type === "error")).toBe(false);
  });

  test("every handled event produces a scrubbed raw_log", async () => {
    const { emitted } = await runSession([succeeded]);
    const raw = emitted.filter((e) => e.type === "raw_log");
    expect(raw.length).toBeGreaterThan(0);
    for (const r of raw) expect(() => JSON.parse((r as { content: string }).content)).not.toThrow();
  });

  test("session.execution.failed fails the task with the error message", async () => {
    const { result, emitted } = await runSession([
      ev("session.execution.failed", {
        sessionID: SESSION_ID,
        error: { type: "provider", message: "rate limited" },
      }),
    ]);
    expect(result).toMatchObject({ exitCode: 1, isError: true, failureReason: "rate limited" });
    expect(emitted).toContainEqual({ type: "error", message: "rate limited" });
  });

  test("permission.asked fails the session (headless cannot answer)", async () => {
    const { result } = await runSession([
      ev("permission.asked", {
        sessionID: SESSION_ID,
        id: "per_1",
        action: "shell",
        resources: [],
      }),
    ]);
    expect(result.isError).toBe(true);
    expect(result.failureReason).toContain("per_1");
  });

  test("a stream that ends without a terminal event settles the session as failed", async () => {
    const { result } = await runSession([], testConfig(), { endStream: true });
    expect(result.isError).toBe(true);
    expect(result.failureReason).toBe("runner exited without result: opencode event stream ended");
  });

  test("a rejected prompt fails the session", async () => {
    const { result } = await runSession([], testConfig(), {
      promptError: new Error("model not found: x/y"),
    });
    expect(result).toMatchObject({ isError: true, failureReason: "model not found: x/y" });
  });
});

describe("OpencodeSession — session end is bounded", () => {
  test("a profile sync that never answers cannot strand the host or completion", async () => {
    let syncCalls = 0;
    _setOpencodeSessionHooksForTests({
      budgetMs: 50,
      // A held profile PUT that ignores cancellation: the worst case.
      syncIdentity: () => {
        syncCalls++;
        return new Promise<void>(() => {});
      },
    });
    const { result, host } = await runSession([succeeded]);
    expect(syncCalls).toBe(1);
    expect(host.closeCalls).toBe(1);
    expect(result).toMatchObject({ exitCode: 0, isError: false });
  });

  test("abort while finishing cancels the sync, closes the host, and completes", async () => {
    let syncSignal: AbortSignal | undefined;
    _setOpencodeSessionHooksForTests({
      budgetMs: 60_000,
      // A deferred profile response that only ends when the request is cancelled.
      syncIdentity: (_config, _source, signal) => {
        syncSignal = signal;
        return new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    });
    const { session, host } = await startSession([succeeded]);
    await waitFor(() => syncSignal !== undefined);
    expect(session.isFinished).toBe(true);
    expect(host.closeCalls).toBe(0);

    await session.abort();
    const result = await session.waitForCompletion();
    expect(syncSignal?.aborted).toBe(true);
    expect(host.closeCalls).toBe(1);
    expect(result).toMatchObject({ exitCode: 0, isError: false });
  });
});

describe("OpencodeAdapter — swarm MCP admission", () => {
  test("waits for a pending server, then prompts once store-progress is registered", async () => {
    const { host, session } = await startSession([], testConfig(), {
      mcpStatuses: [null, { status: "pending" }, { status: "connected" }],
    });
    await waitFor(() => host.prompts.length > 0);
    expect(host.mcpListCalls).toBeGreaterThanOrEqual(3);
    await session.abort();
  });

  test("a refused server fails the session before the first prompt and closes the host", async () => {
    const { result, host } = await runSession([], testConfig(), {
      mcpStatuses: [
        { status: "pending" },
        { status: "failed", error: "Unable to connect. (ConnectionRefused)" },
      ],
    });
    expect(host.prompts).toEqual([]);
    expect(host.closeCalls).toBe(1);
    expect(result).toMatchObject({ exitCode: 1, isError: true });
    expect(result.failureReason).toBe(
      "swarm MCP admission failed: swarm MCP server failed: Unable to connect. (ConnectionRefused)",
    );
  });

  test("an unauthorized server fails with a scrubbed reason", async () => {
    const leaked = `sk-or-v1-${"a1B2c3D4e5".repeat(5)}`;
    const { result, host, emitted } = await runSession([], testConfig(), {
      mcpStatuses: [{ status: "needs_auth", error: `401 for bearer ${leaked}` }],
    });
    expect(host.prompts).toEqual([]);
    expect(host.closeCalls).toBe(1);
    expect(result.failureReason).toContain(
      "swarm MCP admission failed: swarm MCP server needs_auth",
    );
    expect(result.failureReason).not.toContain(leaked);
    expect(JSON.stringify(emitted)).not.toContain(leaked);
  });

  test("a connected server without store-progress fails once admission times out", async () => {
    _setOpencodeSessionHooksForTests({ admissionTimeoutMs: 50 });
    const { result, host } = await runSession([], testConfig(), {
      tools: ["read", "swarm_poll-task"],
    });
    expect(host.prompts).toEqual([]);
    expect(host.closeCalls).toBe(1);
    expect(result.failureReason).toContain(
      "swarm MCP server connected without required tools: store-progress",
    );
  });
});

describe("OpencodeSession — abort and steering", () => {
  test("abort interrupts the session, closes the host, and reports aborted", async () => {
    const { session, host } = await startSession([]);
    await session.abort();
    const result = await session.waitForCompletion();
    expect(host.interrupts).toEqual([{ sessionID: SESSION_ID }]);
    expect(host.closeCalls).toBe(1);
    expect(result).toMatchObject({ exitCode: 1, isError: true, failureReason: "aborted" });
  });

  test("steering queues a prompt, even when steer is requested", async () => {
    const { session, host } = await startSession([]);
    await Bun.sleep(0);
    const delivered = await session.deliverSteering({ mode: "steer", text: "also do X" });
    expect(delivered).toEqual({ delivered: true, mode: "queue" });
    expect(host.prompts.at(-1)).toEqual({
      sessionID: SESSION_ID,
      text: "also do X",
      delivery: "queue",
    });
    await session.abort();
  });

  test("steering after completion is undeliverable", async () => {
    const { session } = await runSession([succeeded]);
    expect(await session.deliverSteering({ mode: "queue", text: "late" })).toEqual({
      delivered: false,
      reason: "opencode session already completed",
    });
  });
});

describe("OpenRouter attribution config", () => {
  test("overrides harness attribution while preserving custom headers and options", () => {
    const config = {
      provider: {
        openrouter: {
          options: {
            apiKey: "test",
            headers: {
              "X-Custom": "keep",
              "X-Title": "opencode",
              "HTTP-Referer": "https://opencode.ai",
            },
          },
        },
      },
    };
    applyOpenRouterBaseUrlOverride(config, {});
    expect(config.provider.openrouter.options).toEqual({
      apiKey: "test",
      headers: {
        "X-Custom": "keep",
        "HTTP-Referer": "https://agent-swarm.dev",
        "X-Title": "Agent Swarm",
        "X-OpenRouter-Title": "Agent Swarm",
        "X-OpenRouter-Categories": "personal-agent,cloud-agent",
      },
    });
  });

  test("gateway override preserves options without injecting attribution", () => {
    const config = {
      provider: {
        openrouter: {
          models: {
            "google/gemini-3-flash-preview": { options: { reasoning: { effort: "low" } } },
          },
          options: { apiKey: "test", headers: { "X-Custom": "keep" } },
        },
        anthropic: { options: { apiKey: "test-other" } },
      },
    };
    applyOpenRouterBaseUrlOverride(config, { OPENROUTER_BASE_URL: "http://localhost:1234/v1" });
    expect(config.provider.openrouter.options).toEqual({
      apiKey: "test",
      headers: { "X-Custom": "keep" },
      baseURL: "http://localhost:1234/v1",
    });
    expect(config.provider.openrouter.models).toEqual({
      "google/gemini-3-flash-preview": { options: { reasoning: { effort: "low" } } },
    });
    expect(config.provider.anthropic).toEqual({ options: { apiKey: "test-other" } });
  });

  test("task opt-out leaves default provider config untouched", () => {
    const config = {};
    applyOpenRouterBaseUrlOverride(config, { OPENROUTER_APP_ATTRIBUTION: "false" });
    expect(config).toEqual({});
  });
});
