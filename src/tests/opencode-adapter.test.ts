/**
 * Unit tests for the OpenCode 2 adapter.
 *
 * A fake embedded host stands in for `@opencode/sdk` (injected through
 * `_setOpencodeSdkLoaderForTests`), so these tests drive canned OpenCode 2
 * events through the adapter and check the ProviderEvent mapping, cost,
 * config wiring, steering, abort, and stream-death handling.
 */

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { OpenCodeEvent } from "@opencode/sdk";
import { normalizeSessionLogs, type SessionLogRecord } from "../../apps/ui/src/logs-parser";
import { renderContextBoundNote } from "../prompts/context-bound-note";
import {
  _setOpencodeSdkLoaderForTests,
  _setOpencodeSessionHooksForTests,
  applyOpenRouterBaseUrlOverride,
  applyProviderKeySplice,
  OpencodeAdapter,
  type OpencodeSession,
  resolveOpencodeSdkSpecifier,
} from "../providers/opencode-adapter";
import { createSkillInvokeTracker, type SkillInvoke } from "../providers/skill-invoke";
import type { ProviderEvent, ProviderSessionConfig } from "../providers/types";
import { clearVolatileSecretsForTesting } from "../utils/secret-scrubber";
import { HELD_NOTE_TEXT, holdTemplateRender } from "./fixtures/held-template-render";

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
  /** Model responses handed to the plugin's `http.response` hook at startup. */
  responses?: Response[];
  syntheticError?: Error;
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
    synthetics: [] as Array<Record<string, unknown>>,
    interrupts: [] as unknown[],
    closeCalls: 0,
    mcpListCalls: 0,
    /** Session hooks the plugins registered, with their options. */
    sessionHooks: {} as Record<
      string,
      { fn: (event: any) => unknown; options?: { providerID?: string } }
    >,
    mcp: {
      list: async () => {
        const status = statuses[Math.min(host.mcpListCalls, statuses.length - 1)];
        host.mcpListCalls++;
        return { location: {}, data: status ? [{ name: "swarm", status }] : [] };
      },
    },
    tools: opts.tools ?? ["read", "swarm_store-progress"],
    responses: opts.responses ?? [],
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
      synthetic: async (input: Record<string, unknown>) => {
        host.synthetics.push(input);
        if (opts.syntheticError) throw opts.syntheticError;
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

function installHost(host: FakeHost, onCreate?: (options: Record<string, unknown>) => void) {
  _setOpencodeSdkLoaderForTests(async () => ({
    version: "2.0.28",
    sdk: {
      OpenCode: {
        create: async (options: Record<string, unknown>) => {
          host.createOptions = options;
          onCreate?.(options);
          // Set the plugins up the way OpenCode does, with a stub context.
          const plugins = options.plugins as Array<{ setup: (ctx: unknown) => Promise<void> }>;
          for (const plugin of plugins) {
            await plugin.setup({
              tool: {
                hook: async () => {},
                list: async () => host.tools.map((id) => ({ id })),
              },
              // Registered when the session config carries a per-task env.
              shell: { hook: async () => {} },
              session: {
                hook: async (
                  name: string,
                  fn: (event: unknown) => unknown,
                  options?: { providerID?: string },
                ) => {
                  host.sessionHooks[name] = { fn, options };
                },
              },
            });
          }
          for (const response of host.responses) {
            await host.sessionHooks["http.response"]?.fn({ response });
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
  test("native skill id records a named invocation only after input is available", async () => {
    const { session } = await startSession([]);
    const tracker = createSkillInvokeTracker();
    const invokes: SkillInvoke[] = [];
    tracker.attach((invoke) => invokes.push(invoke));
    session.onEvent(tracker.onEvent);
    const call = { sessionID: SESSION_ID, id: "call_skill" };
    session.handleOpencodeEvent(ev("session.tool.input.started", { ...call, name: "skill" }));
    expect(invokes).toEqual([]);
    session.handleOpencodeEvent(
      ev("session.tool.input.ended", { ...call, text: '{"id": "deck-script-litmus"}' }),
    );
    expect(invokes).toEqual([]);
    session.handleOpencodeEvent(
      ev("session.tool.called", { ...call, input: { id: "deck-script-litmus" } }),
    );
    session.handleOpencodeEvent(
      ev("session.tool.success", {
        ...call,
        content: [{ type: "text", text: '<skill_content name="deck-script-litmus">' }],
      }),
    );
    session.handleOpencodeEvent(succeeded);
    await session.waitForCompletion();
    expect(invokes).toEqual([{ via: "tool", skillName: "deck-script-litmus" }]);
  });

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

  test("a step on a different model than requested fails the session", async () => {
    const step = (providerID: string, id: string) =>
      ev("session.step.started", { sessionID: SESSION_ID, model: { id, providerID } });

    const ok = await runSession([step("openrouter", "google/gemini-3-flash-preview"), succeeded]);
    expect(ok.result.isError).toBe(false);

    const { result } = await runSession([
      step("openrouter", "anthropic/claude-haiku-5.5"),
      succeeded,
    ]);
    expect(result.isError).toBe(true);
    expect(result.failureReason).toBe(
      "opencode ran openrouter/anthropic/claude-haiku-5.5 instead of the requested model openrouter/google/gemini-3-flash-preview; the requested model is not in OpenCode's catalog",
    );
  });

  test("a rejected prompt fails the session", async () => {
    const { result } = await runSession([], testConfig(), {
      promptError: new Error("model not found: x/y"),
    });
    expect(result).toMatchObject({ isError: true, failureReason: "model not found: x/y" });
  });
});

describe("OpencodeSession — cost of an OpenRouter session", () => {
  // Task 06c031dd (opencode 2.0.28, openrouter/deepseek/deepseek-v4.1-flash),
  // verbatim from session_logs: a title call, then three agent steps.
  // `session.usage.updated` is cumulative; `output` excludes reasoning.
  const deepseek = testConfig({ model: "openrouter/deepseek/deepseek-v4.1-flash" });
  const usage = (cost: number, input: number, output: number, reasoning: number, read: number) =>
    ev("session.usage.updated", {
      sessionID: SESSION_ID,
      cost,
      tokens: { input, output, reasoning, cache: { read, write: 0 } },
    });
  const step = (cost: number, input: number, output: number, reasoning: number, read: number) =>
    ev("session.step.ended", {
      sessionID: SESSION_ID,
      finish: "tool-calls",
      cost,
      tokens: { input, output, reasoning, cache: { read, write: 0 } },
    });
  const v2Events = [
    usage(0.00010640000000000001, 1019, 9, 0, 0),
    step(0.00023894900000000002, 51770, 53, 26, 0),
    usage(0.000345349, 52789, 62, 26, 0),
    step(0.0005280831000000001, 12963, 102, 7, 51840),
    usage(0.0008734321000000001, 65752, 164, 33, 51840),
    step(0.0005287785, 165, 15, 0, 64896),
    usage(0.0014022106, 65917, 179, 33, 116736),
    succeeded,
  ];

  // OpenRouter's final SSE chunk for deepseek/deepseek-v4.1-flash, served by
  // Together (live probe, 2026-10-14): `usage.cost` is the billed USD.
  const openRouterSse = (cost: number, cached: number) =>
    new Response(
      [
        ": OPENROUTER PROCESSING",
        "",
        `data: ${JSON.stringify({ id: "gen-1", choices: [{ index: 0, delta: { content: "pong" } }] })}`,
        "",
        `data: ${JSON.stringify({
          id: "gen-1",
          provider: "Together",
          model: "deepseek/deepseek-v4.1-flash",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 26545,
            completion_tokens: 15,
            total_tokens: 26560,
            cost,
            is_byok: false,
            prompt_tokens_details: { cached_tokens: cached, cache_write_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 11 },
          },
        })}`,
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
      { headers: { "content-type": "text/event-stream" } },
    );

  test("reports v2 tokens with reasoning billed as output", async () => {
    const { result } = await runSession(v2Events, deepseek);
    expect(result.cost).toMatchObject({
      totalCostUsd: 0.0014022106,
      inputTokens: 65917,
      outputTokens: 212,
      reasoningOutputTokens: 33,
      cacheReadTokens: 116736,
      cacheWriteTokens: 0,
      numTurns: 3,
    });
    expect(result.cost?.harnessCostBilled).toBeUndefined();
  });

  test("reports OpenRouter's billed cost when every response carried one", async () => {
    const { result } = await runSession(v2Events, deepseek, {
      responses: [
        openRouterSse(0.0079815, 0),
        openRouterSse(0.000191676, 26496),
        new Response('{"error":{"message":"rate limited"}}', { status: 429 }),
      ],
    });
    expect(result.cost?.harnessCostBilled).toBe(true);
    expect(result.cost?.totalCostUsd).toBeCloseTo(0.0079815 + 0.000191676, 12);
    expect(result.cost?.inputTokens).toBe(65917);
  });

  test("falls back to OpenCode's estimate when a response has no billed cost", async () => {
    const { result } = await runSession(v2Events, deepseek, {
      responses: [openRouterSse(0.0079815, 0), new Response("data: [DONE]\n\n")],
    });
    expect(result.cost?.harnessCostBilled).toBeUndefined();
    expect(result.cost?.totalCostUsd).toBe(0.0014022106);
  });

  test("hooks only OpenRouter responses, and only for an OpenRouter model", async () => {
    const openrouter = await runSession([succeeded], deepseek);
    expect(openrouter.host.sessionHooks["http.response"]?.options).toEqual({
      providerID: "openrouter",
    });
    const direct = await runSession([succeeded], testConfig({ model: "anthropic/claude-haiku" }));
    expect(direct.host.sessionHooks["http.response"]).toBeUndefined();
  });

  test("skips title generation", async () => {
    const { host } = await runSession([succeeded]);
    const event: { result?: string } = {};
    await host.sessionHooks.title?.fn(event);
    expect(event.result).toBe("swarm task task-1");
  });
});

describe("OpencodeSession — persisted rows render in the dashboard", () => {
  test("text, tools and errors render once each, in order", async () => {
    const text = (ordinal: number, value: string, messageID = "msg_1") => [
      ev("session.text.started", { sessionID: SESSION_ID, assistantMessageID: messageID, ordinal }),
      ev("session.text.delta", {
        sessionID: SESSION_ID,
        assistantMessageID: messageID,
        ordinal,
        delta: value,
      }),
      ev("session.text.ended", {
        sessionID: SESSION_ID,
        assistantMessageID: messageID,
        ordinal,
        text: value,
      }),
    ];
    const { emitted } = await runSession([
      ...text(0, "Listing files."),
      ev("session.tool.input.started", { sessionID: SESSION_ID, id: "call_1", name: "shell" }),
      ev("session.tool.called", { sessionID: SESSION_ID, id: "call_1", input: { command: "ls" } }),
      ev("session.tool.success", {
        sessionID: SESSION_ID,
        id: "call_1",
        content: [{ type: "text", text: "file.txt\n" }],
      }),
      ...text(1, " Found one."),
      ev("session.tool.input.started", { sessionID: SESSION_ID, id: "call_2", name: "read" }),
      ev("session.tool.called", { sessionID: SESSION_ID, id: "call_2", input: { path: "x" } }),
      ev("session.tool.failed", {
        sessionID: SESSION_ID,
        id: "call_2",
        error: { type: "unknown", message: "no such file" },
      }),
      ev("session.step.ended", { sessionID: SESSION_ID, tokens: tokens(1000, 10) }),
      ev("session.execution.failed", {
        sessionID: SESSION_ID,
        error: { type: "unknown", message: "provider overloaded" },
      }),
    ]);

    // The runner stores every raw_log line verbatim as a session log row.
    const rows: SessionLogRecord[] = emitted
      .filter((e) => e.type === "raw_log")
      .map((e, index) => ({
        id: `row-${index}`,
        taskId: "task-1",
        sessionId: "session-1",
        iteration: 1,
        cli: "opencode",
        content: (e as { content: string }).content,
        lineNumber: index + 1,
        createdAt: "2026-10-13T10:00:00.000Z",
      }));
    const { items } = normalizeSessionLogs(rows);

    const visible = items
      .filter((item) => item.kind !== "lifecycle")
      .map((item) =>
        item.kind === "text"
          ? `${item.role} text: ${item.text}`
          : item.kind === "tool_call"
            ? `tool_call ${item.tool?.name} ${JSON.stringify(item.tool?.input)}`
            : item.kind === "tool_result"
              ? `tool_result ${item.result?.id} error=${item.result?.isError} ${item.result?.payload}`
              : item.kind,
      );
    expect(visible).toEqual([
      "assistant text: Listing files.",
      'tool_call shell {"command":"ls"}',
      "tool_result call_1 error=false file.txt\n",
      "assistant text:  Found one.",
      'tool_call read {"path":"x"}',
      "tool_result call_2 error=true no such file",
      "system text: opencode error: provider overloaded",
    ]);
    expect(items.some((item) => item.kind === "unknown")).toBe(false);
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

describe("OpencodeSession — context-bound note", () => {
  const boundConfig = (threshold: string) =>
    testConfig({ env: { CONTEXT_BOUND_NOTE_TOKENS: threshold } });
  const step = (sessionID: string, input: number, read = 0, write = 0) =>
    ev("session.step.ended", { sessionID, tokens: tokens(input, 10, read, write) });

  test("steers the note once at the threshold, not again on a larger step", async () => {
    const { session, host } = await startSession([], boundConfig("1000"));
    // 600 input + 300 cache read + 100 cache write = 1,000 (output does not count).
    session.handleOpencodeEvent(step(SESSION_ID, 500, 300, 100));
    session.handleOpencodeEvent(step(SESSION_ID, 600, 300, 100));
    session.handleOpencodeEvent(step(SESSION_ID, 5_000));
    await waitFor(() => host.synthetics.length > 0);
    await Bun.sleep(20);
    expect(host.synthetics).toEqual([
      {
        sessionID: SESSION_ID,
        text: await renderContextBoundNote(1_000, "openrouter/google/gemini-3-flash-preview"),
        delivery: "steer",
        resume: false,
      },
    ]);
    expect(host.synthetics[0]?.text).toContain("1,000");
    session.handleOpencodeEvent(succeeded);
    expect((await session.waitForCompletion()).isError).toBe(false);
  });

  test("the note shows the window share for a known model and omits it for an unknown one", async () => {
    const noteFor = async (model: string) => {
      const { session, host } = await startSession(
        [],
        testConfig({ model, env: { CONTEXT_BOUND_NOTE_TOKENS: "1000" } }),
      );
      session.handleOpencodeEvent(step(SESSION_ID, 524_288));
      await waitFor(() => host.synthetics.length > 0);
      session.handleOpencodeEvent(succeeded);
      await session.waitForCompletion();
      return host.synthetics[0]?.text;
    };
    const rest =
      "Keep this task bounded: finish the current step, store-progress, and complete or defer instead of starting new exploration.";
    expect(await noteFor("openrouter/google/gemini-3-flash-preview")).toBe(
      `Context is 524,288 tokens (50% of the 1,048,576-token window). ${rest}`,
    );
    expect(await noteFor("openrouter/made-up/model")).toBe(`Context is 524,288 tokens. ${rest}`);
  });

  test("off when CONTEXT_BOUND_NOTE_TOKENS is unset", async () => {
    const { session, host } = await startSession([]);
    session.handleOpencodeEvent(step(SESSION_ID, 900_000));
    await Bun.sleep(20);
    expect(host.synthetics).toEqual([]);
    session.handleOpencodeEvent(succeeded);
    await session.waitForCompletion();
  });

  test("no-op below the threshold and for a child session's steps", async () => {
    const { session, host } = await startSession([], boundConfig("1000"));
    session.handleOpencodeEvent(step(SESSION_ID, 999));
    session.handleOpencodeEvent(step("ses_child", 50_000));
    await Bun.sleep(20);
    expect(host.synthetics).toEqual([]);
    session.handleOpencodeEvent(succeeded);
    await session.waitForCompletion();
  });

  test("off at 0", async () => {
    const { session, host } = await startSession([], boundConfig("0"));
    session.handleOpencodeEvent(step(SESSION_ID, 250_000));
    await Bun.sleep(20);
    expect(host.synthetics).toEqual([]);
    session.handleOpencodeEvent(succeeded);
    await session.waitForCompletion();
  });

  test("fails open on corrupt step tokens", async () => {
    const { session, host } = await startSession([], boundConfig("1000"));
    session.handleOpencodeEvent(
      ev("session.step.ended", {
        sessionID: SESSION_ID,
        tokens: { input: "lots", output: 1, reasoning: 0, cache: { read: null, write: {} } },
      }),
    );
    await Bun.sleep(20);
    expect(host.synthetics).toEqual([]);
    session.handleOpencodeEvent(succeeded);
    expect((await session.waitForCompletion()).isError).toBe(false);
  });

  test("a rejected steer still lets the session complete", async () => {
    const { session, host } = await startSession([], boundConfig("1000"), {
      syntheticError: new Error("synthetic refused"),
    });
    session.handleOpencodeEvent(step(SESSION_ID, 5_000));
    await waitFor(() => host.synthetics.length > 0);
    session.handleOpencodeEvent(succeeded);
    expect((await session.waitForCompletion()).isError).toBe(false);
  });

  test("a note rendered after the session completed is dropped", async () => {
    const lateSynthetics = async (releaseInSession: boolean) => {
      const held = holdTemplateRender();
      try {
        const { session, host } = await startSession([], boundConfig("1000"));
        session.handleOpencodeEvent(step(SESSION_ID, 5_000));
        await held.requested;
        if (releaseInSession) {
          held.release();
          await waitFor(() => host.synthetics.length > 0);
        }
        session.handleOpencodeEvent(succeeded);
        expect((await session.waitForCompletion()).isError).toBe(false);
        held.release();
        await Bun.sleep(50);
        return host.synthetics.map((s) => s.text);
      } finally {
        held.stop();
      }
    };
    expect(await lateSynthetics(false)).toEqual([]);
    // Control: ready while the session runs.
    expect(await lateSynthetics(true)).toEqual([HELD_NOTE_TEXT]);
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

describe("provider key splice (one picked key per task)", () => {
  const PICKED = "sk-picked-member-0123456789";
  const POOL = "sk-pool-member-aaaaaaaaaa,sk-pool-member-bbbbbbbbbb";
  const SPLICE_VARS = [
    "NAN_API_KEY",
    "HELMCODE_API_NAN",
    "HELMCODE_API_KEY",
    "OPENROUTER_API_KEY",
    "OPENROUTER_BASE_URL",
  ];
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const key of SPLICE_VARS) saved[key] = process.env[key];
  });
  afterEach(() => {
    for (const key of SPLICE_VARS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    clearVolatileSecretsForTesting();
  });

  test("nan: env [] and the per-task key, even with a pool in process.env", async () => {
    process.env.NAN_API_KEY = POOL;
    const { host } = await runSession(
      [succeeded],
      testConfig({ model: "nan/glm5.3-flash", env: { NAN_API_KEY: PICKED } }),
    );
    const nan = configOf(host).provider.nan;
    expect(nan.env).toEqual([]);
    expect(nan.options.apiKey).toBe(PICKED);
  });

  test("nan: the HELMCODE_API_NAN alias is read when NAN_API_KEY is empty", () => {
    const config = {};
    const picked = applyProviderKeySplice(config, "nan/qwen3.6", { HELMCODE_API_NAN: PICKED });
    expect(picked).toEqual({ key: PICKED, name: "HELMCODE_API_NAN" });
    expect(config).toEqual({ provider: { nan: { env: [], options: { apiKey: PICKED } } } });
  });

  test("a pool that reaches the splice unpicked yields its first member", () => {
    const config = {};
    applyProviderKeySplice(config, "nan/qwen3.6", {
      NAN_API_KEY: ` ${PICKED} , sk-other-0000000000`,
    });
    expect(config).toEqual({ provider: { nan: { env: [], options: { apiKey: PICKED } } } });
  });

  test("helmcode: full custom block with limits, reasoning options merged in", async () => {
    const { host } = await runSession(
      [succeeded],
      testConfig({
        model: "helmcode/glm5.3",
        reasoningEffort: "high",
        env: { HELMCODE_API_KEY: PICKED },
      }),
    );
    const helmcode = configOf(host).provider.helmcode;
    expect(helmcode).toMatchObject({
      npm: "@ai-sdk/openai-compatible",
      name: "Helmcode",
      env: [],
      options: { baseURL: "https://api.helmcode.com/v1", apiKey: PICKED },
    });
    expect(helmcode.models["glm5.3"]).toEqual({
      name: "GLM-5.3",
      tool_call: true,
      reasoning: true,
      limit: { context: 1048576, output: 32768 },
      options: { reasoningEffort: "high" },
    });
    expect(Object.keys(helmcode.models)).toEqual([
      "deepseek-v4-flash",
      "glm5.3",
      "glm5.3-flash",
      "qwen3.6",
      "gemma4",
    ]);
  });

  test("helmcode: a model missing from the table still gets an entry", () => {
    const config: Record<string, any> = {};
    applyProviderKeySplice(config, "helmcode/brand-new", { HELMCODE_API_KEY: PICKED });
    expect(config.provider.helmcode.models["brand-new"]).toEqual({
      name: "brand-new",
      tool_call: true,
    });
  });

  test("openrouter gateway: baseURL kept next to env [] and the picked key", async () => {
    process.env.OPENROUTER_API_KEY = POOL;
    const { host } = await runSession(
      [succeeded],
      testConfig({
        model: "openrouter/deepseek/deepseek-v4-flash",
        env: { OPENROUTER_API_KEY: PICKED, OPENROUTER_BASE_URL: "http://127.0.0.1:1234/v1" },
      }),
    );
    expect(configOf(host).provider.openrouter).toEqual({
      env: [],
      options: { apiKey: PICKED, baseURL: "http://127.0.0.1:1234/v1" },
    });
  });

  test("openrouter host: attribution headers kept next to env [] and the picked key", async () => {
    const { host } = await runSession(
      [succeeded],
      testConfig({
        model: "openrouter/deepseek/deepseek-v4-flash",
        env: { OPENROUTER_API_KEY: PICKED },
      }),
    );
    const openrouter = configOf(host).provider.openrouter;
    expect(openrouter.env).toEqual([]);
    expect(openrouter.options.apiKey).toBe(PICKED);
    expect(openrouter.options.headers).toMatchObject({ "X-Title": "Agent Swarm" });
  });

  test("no splice without a key, or for providers outside the splice", () => {
    for (const model of ["nan/qwen3.6", "helmcode/glm5.3", "openrouter/x/y"]) {
      const config = {};
      expect(applyProviderKeySplice(config, model, {})).toBeUndefined();
      expect(config).toEqual({});
    }
    for (const model of ["anthropic/claude-sonnet-4-5", "openai/gpt-5", "glm5.3", "", undefined]) {
      const config = {};
      applyProviderKeySplice(config, model, {
        ANTHROPIC_API_KEY: PICKED,
        OPENAI_API_KEY: PICKED,
        NAN_API_KEY: PICKED,
      });
      expect(config).toEqual({});
    }
  });
});

describe("spliced key never reaches logs, events, or errors", () => {
  // Not in process.env: the key a dashboard save delivers to the per-task env only.
  const SENTINEL = "sk-nan-sentinel-do-not-log-4f9c2e";
  let captured: string[] = [];
  let spies: Array<ReturnType<typeof spyOn>> = [];
  beforeAll(() => {
    delete process.env.NAN_API_KEY;
  });
  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    spies = [];
    captured = [];
    clearVolatileSecretsForTesting();
  });
  function captureConsole() {
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      spies.push(
        spyOn(console, method).mockImplementation((...args: unknown[]) => {
          captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
        }),
      );
    }
  }

  test("SDK log lines and a provider failure that echo the config are scrubbed", async () => {
    captureConsole();
    const host = makeFakeHost([
      ev("session.execution.failed", {
        sessionID: SESSION_ID,
        error: { message: `401 Invalid API key ${SENTINEL}` },
      }),
    ]);
    installHost(host, (options) => {
      const content = (options.config as { content: string }).content;
      const log = options.log as { emit: (entry: { message: string }) => void };
      log.emit({ message: `config: ${content}` });
    });
    const session = (await new OpencodeAdapter().createSession(
      testConfig({ model: "nan/glm5.3-flash", env: { NAN_API_KEY: SENTINEL } }),
    )) as OpencodeSession;
    const emitted: ProviderEvent[] = [];
    session.onEvent((e) => emitted.push(e));
    const result = await session.waitForCompletion();

    // Positive control: the key did reach the SDK config.
    expect(configOf(host).provider.nan.options.apiKey).toBe(SENTINEL);
    expect(captured.some((line) => line.includes("[opencode] config:"))).toBe(true);
    expect(result.isError).toBe(true);

    for (const line of captured) expect(line).not.toContain(SENTINEL);
    expect(JSON.stringify(emitted)).not.toContain(SENTINEL);
    expect(result.failureReason ?? "").not.toContain(SENTINEL);
  });

  test("a host start failure that echoes the config is scrubbed before it propagates", async () => {
    captureConsole();
    const host = makeFakeHost([]);
    installHost(host, (options) => {
      const content = (options.config as { content: string }).content;
      throw new Error(`invalid config ${content}`);
    });
    const error = await new OpencodeAdapter()
      .createSession(testConfig({ model: "nan/glm5.3-flash", env: { NAN_API_KEY: SENTINEL } }))
      .then(
        () => undefined,
        (err: unknown) => err as Error,
      );
    expect(error?.message).toStartWith("opencode host failed to start: invalid config");
    expect(error?.message).not.toContain(SENTINEL);
    for (const line of captured) expect(line).not.toContain(SENTINEL);
  });
});
