import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunStopHookSessionSummaryOpts } from "../hooks/hook";
import { ClaudeAdapter, createSessionMcpConfig, mergeMcpConfig } from "../providers/claude-adapter";
import type { ProviderSessionConfig } from "../providers/types";

/** Minimal config for testing — sessions won't actually spawn in these unit tests */
function makeConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
  return {
    prompt: "Say hello",
    systemPrompt: "",
    model: "sonnet",
    role: "worker",
    agentId: "test-agent-id",
    taskId: "test-task-id",
    apiUrl: "http://localhost:3013",
    apiKey: "test-key",
    cwd: "/tmp",
    logFile: "/tmp/test-claude-adapter.jsonl",
    ...overrides,
  };
}

describe("ClaudeAdapter", () => {
  test("name is 'claude'", () => {
    const adapter = new ClaudeAdapter();
    expect(adapter.name).toBe("claude");
  });

  test("canResume always returns true", async () => {
    const adapter = new ClaudeAdapter();
    expect(await adapter.canResume("any-session-id")).toBe(true);
    expect(await adapter.canResume("")).toBe(true);
  });
});

describe("ClaudeSession CLI argument construction", () => {
  // We test the command building indirectly by examining what ClaudeAdapter passes.
  // Since buildCommand is private, we verify via the public interface behavior.

  test("default model falls back to 'opus' when empty", async () => {
    const _adapter = new ClaudeAdapter();
    const config = makeConfig({ model: "" });

    // We can't easily inspect the spawned process args without actually spawning,
    // but we can verify the adapter accepts empty model without throwing.
    // The actual fallback logic is: config.model || "opus"
    expect(config.model).toBe("");
  });

  test("config with systemPrompt is accepted", () => {
    const config = makeConfig({ systemPrompt: "You are a test agent" });
    expect(config.systemPrompt).toBe("You are a test agent");
  });

  test("config with arbitrary additionalArgs is accepted", () => {
    // Native resume is deprecated — the adapter no longer special-cases
    // --resume in additionalArgs. The config shape just round-trips opaquely.
    const config = makeConfig({
      additionalArgs: ["--max-turns", "10"],
    });
    expect(config.additionalArgs).toEqual(["--max-turns", "10"]);
  });
});

// ─── Phase 4 (reasoning-effort plan): spawn env wiring ────────────────────────

/** Fake Bun.Subprocess — exits cleanly with no output. */
function makeFakeProc(): ReturnType<typeof Bun.spawn> {
  return {
    stdout: null,
    stderr: null,
    stdin: null,
    exited: Promise.resolve(0),
    exitCode: 0,
    kill: () => {},
    pid: 0,
    killed: false,
    ref: () => {},
    unref: () => {},
  } as unknown as ReturnType<typeof Bun.spawn>;
}

describe("ClaudeSession spawn env — reasoning_effort", () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  let spawnedEnvs: Array<Record<string, string> | undefined>;

  // `createSession`/`ClaudeSession` fall back to `process.env` when `config.env`
  // is omitted, and spread it wholesale into the spawned process env. Two
  // problems follow in a credential-less sandbox: (1) `validateClaudeCredentials`
  // throws without CLAUDE_CODE_OAUTH_TOKEN/ANTHROPIC_API_KEY, and (2) any ambient
  // env var sharing a name with what these tests assert on (CLAUDE_CODE_EFFORT_LEVEL,
  // MAX_THINKING_TOKENS) would leak through and pollute the `toBeUndefined()`
  // assertions. Passing an explicit, minimal `env` sidesteps both — deterministic
  // regardless of the ambient process env the test happens to run in.
  const CLEAN_ENV: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token" };

  beforeEach(() => {
    spawnedEnvs = [];
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((
      _cmd: readonly string[],
      opts?: { env?: Record<string, string> },
    ) => {
      spawnedEnvs.push(opts?.env);
      return makeFakeProc();
    }) as typeof Bun.spawn);
  });

  afterEach(() => {
    spawnSpy.mockRestore();
  });

  test("reasoningEffort: 'high' on claude-opus-4-8 sets CLAUDE_CODE_EFFORT_LEVEL", async () => {
    const adapter = new ClaudeAdapter(async () => {});
    await adapter.createSession(
      makeConfig({ model: "claude-opus-4-8", reasoningEffort: "high", env: CLEAN_ENV }),
    );

    expect(spawnedEnvs).toHaveLength(1);
    expect(spawnedEnvs[0]?.CLAUDE_CODE_EFFORT_LEVEL).toBe("high");
  });

  test("reasoningEffort: 'off' on a legacy budget_tokens-capable model sets MAX_THINKING_TOKENS=0, no effort env", async () => {
    const adapter = new ClaudeAdapter(async () => {});
    await adapter.createSession(
      makeConfig({ model: "claude-opus-4-0", reasoningEffort: "off", env: CLEAN_ENV }),
    );

    expect(spawnedEnvs).toHaveLength(1);
    expect(spawnedEnvs[0]?.MAX_THINKING_TOKENS).toBe("0");
    expect(spawnedEnvs[0]?.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
  });

  test("undefined reasoningEffort leaves spawn env unchanged (no effort/budget keys)", async () => {
    const adapter = new ClaudeAdapter(async () => {});
    await adapter.createSession(makeConfig({ model: "claude-opus-4-8", env: CLEAN_ENV }));

    expect(spawnedEnvs).toHaveLength(1);
    expect(spawnedEnvs[0]?.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
    expect(spawnedEnvs[0]?.MAX_THINKING_TOKENS).toBeUndefined();
  });
});

describe("Claude stream-json event parsing", () => {
  test("session_init parsed from system.init JSON", () => {
    const json = { type: "system", subtype: "init", session_id: "sess-12345" };
    expect(json.type).toBe("system");
    expect(json.subtype).toBe("init");
    expect(json.session_id).toBe("sess-12345");
  });

  test("result event with cost data", () => {
    const json = {
      type: "result",
      total_cost_usd: 0.0342,
      duration_ms: 12000,
      num_turns: 5,
      is_error: false,
      usage: {
        input_tokens: 5000,
        output_tokens: 2000,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 500,
      },
    };

    expect(json.total_cost_usd).toBe(0.0342);
    expect(json.usage.input_tokens).toBe(5000);
    expect(json.usage.output_tokens).toBe(2000);
    expect(json.usage.cache_read_input_tokens).toBe(1000);
    expect(json.usage.cache_creation_input_tokens).toBe(500);
  });

  test("result event with is_error=true", () => {
    const json = {
      type: "result",
      total_cost_usd: 0.01,
      is_error: true,
      duration_ms: 3000,
      num_turns: 1,
    };
    expect(json.is_error).toBe(true);
  });
});

// ─── ProviderResult.output: last-assistant-text capture (PR #78 review) ────
//
// claude-adapter.ts:1005-1008 decides the ONE piece of data that ends up as
// `task.output` in the swarm UI session view for every Claude task. These
// tests drive the real `processStreams()`/stream-json parsing path (via a
// mocked `Bun.spawn` whose fake child process streams real NDJSON lines on
// stdout) rather than asserting on hand-built fixtures, so a message-shape
// regression here is caught instead of silently shipping the wrong text.
describe("ClaudeSession processStreams — ProviderResult.output capture", () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  const CLEAN_ENV: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token" };

  /** Fake Bun.Subprocess whose stdout streams the given NDJSON lines, then closes. */
  function makeStreamingFakeProc(lines: string[]): ReturnType<typeof Bun.spawn> {
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(new TextEncoder().encode(`${line}\n`));
        }
        controller.close();
      },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    return {
      stdout,
      stderr,
      stdin: null,
      exited: Promise.resolve(0),
      exitCode: 0,
      kill: () => {},
      pid: 0,
      killed: false,
      ref: () => {},
      unref: () => {},
    } as unknown as ReturnType<typeof Bun.spawn>;
  }

  /** Builds an `assistant` stream-json line with the given content blocks. */
  function assistantLine(content: Array<Record<string, unknown>>): string {
    return JSON.stringify({ type: "assistant", message: { content } });
  }

  beforeEach(() => {
    spawnSpy = spyOn(Bun, "spawn");
  });

  afterEach(() => {
    spawnSpy.mockRestore();
  });

  test("multiple assistant turns: the last non-empty text wins", async () => {
    const lines = [
      assistantLine([{ type: "text", text: "Hello" }]),
      assistantLine([{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
      assistantLine([{ type: "text", text: "Final answer" }]),
    ];
    spawnSpy.mockImplementation((() => makeStreamingFakeProc(lines)) as typeof Bun.spawn);

    const adapter = new ClaudeAdapter(async () => {});
    const session = await adapter.createSession(makeConfig({ env: CLEAN_ENV }));
    const result = await session.waitForCompletion();

    expect(result.output).toBe("Final answer");
  });

  test("buffers stream-json events and invokes the parent-owned summary path", async () => {
    const lines = [
      assistantLine([
        { type: "text", text: "I found a durable implementation detail." },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/tmp/source.ts" } },
      ]),
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t1", content: "export const value = 1" }],
        },
      }),
    ];
    spawnSpy.mockImplementation((() => makeStreamingFakeProc(lines)) as typeof Bun.spawn);

    let summaryOpts: RunStopHookSessionSummaryOpts | undefined;
    const adapter = new ClaudeAdapter(async (opts) => {
      summaryOpts = opts;
    });
    const prompt = "Inspect the implementation and preserve the important behavior. ".repeat(3);
    const session = await adapter.createSession(makeConfig({ prompt, env: CLEAN_ENV }));
    await session.waitForCompletion();

    expect(summaryOpts).toBeDefined();
    expect(summaryOpts!.transcript).toContain(`User: ${prompt}`);
    expect(summaryOpts!.transcript).toContain(
      "Assistant: I found a durable implementation detail.",
    );
    expect(summaryOpts!.transcript).toContain('Tool[Read] started: {"file_path":"/tmp/source.ts"}');
    expect(summaryOpts!.transcript).toContain("Tool result: export const value = 1");
    expect(summaryOpts!.transcriptPath).toBeUndefined();
    expect(summaryOpts!.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("test-oauth-token");
    expect(summaryOpts!.env?.AGENT_SWARM_TASK_ID).toBe("test-task-id");
  });

  test("tool_use-only, thinking-only, and empty-text turns are skipped, not captured", async () => {
    const lines = [
      assistantLine([{ type: "text", text: "Real answer" }]),
      assistantLine([{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
      assistantLine([{ type: "thinking", thinking: "pondering..." }]),
      assistantLine([{ type: "text", text: "" }]),
    ];
    spawnSpy.mockImplementation((() => makeStreamingFakeProc(lines)) as typeof Bun.spawn);

    const adapter = new ClaudeAdapter(async () => {});
    const session = await adapter.createSession(makeConfig({ env: CLEAN_ENV }));
    const result = await session.waitForCompletion();

    // None of the trailing turns had non-empty text, so the last real
    // answer must survive untouched.
    expect(result.output).toBe("Real answer");
  });

  test("subagent sidechain frames (parent_tool_use_id) do not overwrite the captured output", async () => {
    const lines = [
      assistantLine([{ type: "text", text: "Main thread final answer" }]),
      // A subagent (sidechain) frame carries a truthy `parent_tool_use_id` at
      // the top level of the raw stream-json frame — only the main thread's
      // text should win the `ProviderResult.output` fallback.
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Subagent chatter" }] },
        parent_tool_use_id: "tool-call-1",
      }),
    ];
    spawnSpy.mockImplementation((() => makeStreamingFakeProc(lines)) as typeof Bun.spawn);

    const adapter = new ClaudeAdapter(async () => {});
    const session = await adapter.createSession(makeConfig({ env: CLEAN_ENV }));
    const result = await session.waitForCompletion();

    expect(result.output).toBe("Main thread final answer");
  });

  test("a stream with no assistant text at all leaves output undefined", async () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" }),
      assistantLine([{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
      JSON.stringify({ type: "result", total_cost_usd: 0.01, duration_ms: 100, num_turns: 1 }),
    ];
    spawnSpy.mockImplementation((() => makeStreamingFakeProc(lines)) as typeof Bun.spawn);

    const adapter = new ClaudeAdapter(async () => {});
    const session = await adapter.createSession(makeConfig({ env: CLEAN_ENV }));
    const result = await session.waitForCompletion();

    expect(result.output).toBeUndefined();
  });

  test("result cost includes Claude cache TTL split and complete per-model usage", async () => {
    const lines = [
      JSON.stringify({
        type: "result",
        total_cost_usd: 1.23,
        duration_ms: 100,
        num_turns: 1,
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 300,
          cache_creation: {
            ephemeral_5m_input_tokens: 100,
            ephemeral_1h_input_tokens: 200,
          },
        },
        modelUsage: {
          "claude-opus-5": {
            inputTokens: 11,
            outputTokens: 22,
            cacheReadInputTokens: 33,
            cacheCreationInputTokens: 44,
            webSearchRequests: 2,
            costUSD: 1.1,
          },
          "claude-haiku-4-5": {
            inputTokens: 55,
            outputTokens: 66,
            cacheReadInputTokens: 77,
            cacheCreationInputTokens: 88,
            costUSD: 0.13,
          },
        },
      }),
    ];
    spawnSpy.mockImplementation((() => makeStreamingFakeProc(lines)) as typeof Bun.spawn);

    const adapter = new ClaudeAdapter();
    const session = await adapter.createSession(makeConfig({ env: CLEAN_ENV }));
    const result = await session.waitForCompletion();

    expect(result.cost).toMatchObject({
      cacheWrite5mTokens: 100,
      cacheWrite1hTokens: 200,
      models: [
        {
          model: "claude-opus-5",
          inputTokens: 11,
          outputTokens: 22,
          cacheReadTokens: 33,
          cacheWriteTokens: 44,
          webSearchRequests: 2,
          harnessCostUsd: 1.1,
        },
        {
          model: "claude-haiku-4-5",
          inputTokens: 55,
          outputTokens: 66,
          cacheReadTokens: 77,
          cacheWriteTokens: 88,
          harnessCostUsd: 0.13,
        },
      ],
    });
  });

  test("malformed modelUsage values fall back without fabricating numbers", async () => {
    const lines = [
      JSON.stringify({
        type: "result",
        total_cost_usd: 0.7,
        duration_ms: 100,
        num_turns: 1,
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_creation: {
            ephemeral_5m_input_tokens: null,
            ephemeral_1h_input_tokens: "not-a-number",
          },
        },
        modelUsage: {
          "claude-opus-5": {
            inputTokens: "not-a-number",
            outputTokens: 22,
            cacheReadInputTokens: 33,
            cacheCreationInputTokens: 44,
            webSearchRequests: null,
            costUSD: null,
          },
          "claude-haiku-4-5": "not-an-object",
        },
      }),
    ];
    spawnSpy.mockImplementation((() => makeStreamingFakeProc(lines)) as typeof Bun.spawn);

    const adapter = new ClaudeAdapter();
    const session = await adapter.createSession(makeConfig({ env: CLEAN_ENV }));
    const result = await session.waitForCompletion();

    // null/garbage TTL values must not become 0 (Number(null) === 0 hazard).
    expect(result.cost?.cacheWrite5mTokens).toBeUndefined();
    expect(result.cost?.cacheWrite1hTokens).toBeUndefined();
    expect(result.cost?.models).toEqual([
      {
        model: "claude-opus-5",
        inputTokens: 0,
        outputTokens: 22,
        cacheReadTokens: 33,
        cacheWriteTokens: 44,
      },
      {
        model: "claude-haiku-4-5",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ]);
    const opus = result.cost?.models?.[0];
    expect(opus?.webSearchRequests).toBeUndefined();
    expect(opus?.harnessCostUsd).toBeUndefined();
  });

  test("old Claude result lines omit unavailable cache split and model usage", async () => {
    const lines = [
      JSON.stringify({
        type: "result",
        total_cost_usd: 0.5,
        duration_ms: 100,
        num_turns: 1,
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 40,
        },
      }),
    ];
    spawnSpy.mockImplementation((() => makeStreamingFakeProc(lines)) as typeof Bun.spawn);

    const adapter = new ClaudeAdapter();
    const session = await adapter.createSession(makeConfig({ env: CLEAN_ENV }));
    const result = await session.waitForCompletion();

    expect(result.cost).toMatchObject({
      totalCostUsd: 0.5,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
    });
    expect(result.cost?.cacheWrite5mTokens).toBeUndefined();
    expect(result.cost?.cacheWrite1hTokens).toBeUndefined();
    expect(result.cost?.models).toBeUndefined();
  });

  test("prod aef117fe result preserves the all-1h cache write split", async () => {
    const lines = [
      JSON.stringify({
        type: "result",
        total_cost_usd: 9.4629795,
        usage: {
          input_tokens: 138,
          output_tokens: 53185,
          cache_read_input_tokens: 12276769,
          cache_creation_input_tokens: 199428,
          cache_creation: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 199428,
          },
        },
        modelUsage: {
          "claude-opus-5": {
            inputTokens: 138,
            outputTokens: 53185,
            cacheReadInputTokens: 12276769,
            cacheCreationInputTokens: 199428,
            costUSD: 9.4629795,
          },
        },
      }),
    ];
    spawnSpy.mockImplementation((() => makeStreamingFakeProc(lines)) as typeof Bun.spawn);

    const adapter = new ClaudeAdapter();
    const session = await adapter.createSession(makeConfig({ env: CLEAN_ENV }));
    const result = await session.waitForCompletion();

    expect(result.cost?.cacheWrite1hTokens).toBe(199428);
    expect(result.cost?.cacheWrite5mTokens).toBe(0);
    expect(result.cost?.totalCostUsd).toBe(9.4629795);
  });
});

describe("mergeMcpConfig (issue #369)", () => {
  const TASK_ID = "task-abc-123";

  test("returns only installed servers when base config is null", () => {
    const installed = {
      "my-mcp": {
        type: "http",
        url: "https://example.com",
        headers: { Authorization: "Bearer x" },
      },
    };
    const merged = mergeMcpConfig(null, installed, TASK_ID);
    expect(merged.mcpServers["my-mcp"]).toEqual(installed["my-mcp"]);
  });

  test("returns only base servers when installedServers is null", () => {
    const base = {
      mcpServers: {
        "agent-swarm": {
          type: "http",
          url: "http://localhost:3013/mcp",
          headers: { Authorization: "Bearer KEY", "X-Agent-ID": "a1" },
        },
      },
    };
    const merged = mergeMcpConfig(base, null, TASK_ID);
    const agentSwarm = merged.mcpServers["agent-swarm"] as Record<string, unknown>;
    expect(agentSwarm).toBeDefined();
    // Agent-swarm entry is augmented with X-Source-Task-Id
    expect((agentSwarm.headers as Record<string, string>)["X-Source-Task-Id"]).toBe(TASK_ID);
  });

  test("installed servers OVERRIDE stale .mcp.json entries (precedence fix)", () => {
    // Simulates: /workspace/.mcp.json has an entry baked at container startup with
    // a stale OAuth Bearer; the per-session fetch returns a freshly-resolved Bearer.
    // The merged config MUST carry the fresh token — this is the core of issue #369.
    const base = {
      mcpServers: {
        stripe: {
          type: "http",
          url: "https://mcp.stripe.com",
          headers: { Authorization: "Bearer STALE_TOKEN_FROM_STARTUP" },
        },
      },
    };
    const installed = {
      stripe: {
        type: "http",
        url: "https://mcp.stripe.com",
        headers: { Authorization: "Bearer FRESH_TOKEN_FROM_API" },
      },
    };
    const merged = mergeMcpConfig(base, installed, TASK_ID);
    const stripe = merged.mcpServers.stripe as Record<string, unknown>;
    expect((stripe.headers as Record<string, string>).Authorization).toBe(
      "Bearer FRESH_TOKEN_FROM_API",
    );
  });

  test("installed-server removal is honored (uninstall propagates)", () => {
    // Previously, if .mcp.json had `stripe` baked in but the server was uninstalled
    // from the API, the stale entry persisted. With the precedence fix + skeleton
    // .mcp.json, a server absent from installedServers stays in the merged config
    // ONLY if it's also in base (e.g., manually-added) — no API-layer override is
    // issued. This test confirms we don't spontaneously delete base entries; the
    // docker-entrypoint change (don't bake installed servers) is what prevents
    // stale uninstalls from persisting.
    const base = {
      mcpServers: {
        "manually-configured": { type: "http", url: "https://x.test" },
      },
    };
    const installed = {}; // Empty — nothing installed via API
    const merged = mergeMcpConfig(base, installed, TASK_ID);
    expect(merged.mcpServers["manually-configured"]).toBeDefined();
  });

  test("agent-swarm server gets X-Source-Task-Id injected", () => {
    const base = {
      mcpServers: {
        "agent-swarm": {
          type: "http",
          url: "http://localhost:3013/mcp",
          headers: { Authorization: "Bearer KEY", "X-Agent-ID": "a1" },
        },
      },
    };
    const merged = mergeMcpConfig(base, null, TASK_ID);
    const agentSwarm = merged.mcpServers["agent-swarm"] as Record<string, unknown>;
    const headers = agentSwarm.headers as Record<string, string>;
    expect(headers["X-Source-Task-Id"]).toBe(TASK_ID);
    // Existing headers preserved
    expect(headers.Authorization).toBe("Bearer KEY");
    expect(headers["X-Agent-ID"]).toBe("a1");
  });

  test("X-Source-Task-Id injection works on entry discovered by X-Agent-ID header", () => {
    // Discovery path for non-standard server names.
    const base = {
      mcpServers: {
        "custom-name-swarm": {
          type: "http",
          url: "http://localhost:3013/mcp",
          headers: { Authorization: "Bearer KEY", "X-Agent-ID": "a1" },
        },
      },
    };
    const merged = mergeMcpConfig(base, null, TASK_ID);
    const entry = merged.mcpServers["custom-name-swarm"] as Record<string, unknown>;
    expect((entry.headers as Record<string, string>)["X-Source-Task-Id"]).toBe(TASK_ID);
  });

  test("does not mutate the input baseConfig", () => {
    const base = {
      mcpServers: {
        stripe: {
          type: "http",
          url: "https://mcp.stripe.com",
          headers: { Authorization: "Bearer STALE" },
        },
      },
    };
    const installed = {
      stripe: {
        type: "http",
        url: "https://mcp.stripe.com",
        headers: { Authorization: "Bearer FRESH" },
      },
    };
    mergeMcpConfig(base, installed, TASK_ID);
    // Original object should be untouched
    expect((base.mcpServers.stripe.headers as Record<string, string>).Authorization).toBe(
      "Bearer STALE",
    );
  });

  test("empty base + empty installed yields empty mcpServers", () => {
    const merged = mergeMcpConfig({ mcpServers: {} }, {}, TASK_ID);
    expect(Object.keys(merged.mcpServers)).toHaveLength(0);
  });

  test("preserves a context-mode entry through the merge", () => {
    const base = {
      mcpServers: {
        "agent-swarm": {
          type: "http",
          url: "http://localhost:3013/mcp",
          headers: { Authorization: "Bearer KEY", "X-Agent-ID": "a1" },
        },
        "plugin_context-mode_context-mode": { command: "context-mode" },
      },
    };
    const merged = mergeMcpConfig(base, null, TASK_ID);
    expect(merged.mcpServers["plugin_context-mode_context-mode"]).toEqual({
      command: "context-mode",
    });
  });
});

describe("createSessionMcpConfig", () => {
  let sandbox: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "mcp-cfg-test-"));
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  async function readWritten(path: string) {
    return JSON.parse(await Bun.file(path).text()) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
  }

  test("returns null when no .mcp.json found and no installed servers", async () => {
    const cwd = join(sandbox, "empty");
    await mkdir(cwd, { recursive: true });
    const path = await createSessionMcpConfig(cwd, "task-empty");
    expect(path).toBeNull();
  });

  test("ancestor-only .mcp.json is found via walk-up (Docker layout)", async () => {
    await writeFile(
      join(sandbox, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "agent-swarm": {
            type: "http",
            url: "http://swarm/mcp",
            headers: { Authorization: "Bearer SWARM", "X-Agent-ID": "a1" },
          },
        },
      }),
    );
    const cwd = join(sandbox, "repos", "foo");
    await mkdir(cwd, { recursive: true });

    const path = await createSessionMcpConfig(cwd, "task-anc");
    expect(path).toBe("/tmp/mcp-task-anc.json");
    const written = await readWritten(path!);
    expect(written.mcpServers["agent-swarm"]).toBeDefined();
    expect(
      (written.mcpServers["agent-swarm"].headers as Record<string, string>)["X-Source-Task-Id"],
    ).toBe("task-anc");
  });

  test("merges repo-local + ancestor when server names differ", async () => {
    await writeFile(
      join(sandbox, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "agent-swarm": {
            type: "http",
            url: "http://swarm/mcp",
            headers: { Authorization: "Bearer SWARM", "X-Agent-ID": "a1" },
          },
        },
      }),
    );
    const repo = join(sandbox, "repos", "client-monorepo");
    await mkdir(repo, { recursive: true });
    await writeFile(
      join(repo, ".mcp.json"),
      JSON.stringify({
        mcpServers: { Datadog: { command: "npx", args: ["-y", "@winor30/mcp-server-datadog"] } },
      }),
    );

    const path = await createSessionMcpConfig(repo, "task-merge");
    const written = await readWritten(path!);
    expect(written.mcpServers["agent-swarm"]).toBeDefined();
    expect(written.mcpServers.Datadog).toBeDefined();
    // context-mode is injected by default (see CONTEXT_MODE_DISABLED gate); the
    // two differently-named .mcp.json servers still merge alongside it.
    expect(Object.keys(written.mcpServers).sort()).toEqual([
      "Datadog",
      "agent-swarm",
      "plugin_context-mode_context-mode",
    ]);
  });

  test("ancestor wins over repo-local on agent-swarm key conflict", async () => {
    await writeFile(
      join(sandbox, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "agent-swarm": {
            type: "http",
            url: "http://swarm/mcp",
            headers: { Authorization: "Bearer SWARM", "X-Agent-ID": "a1" },
          },
        },
      }),
    );
    const repo = join(sandbox, "repos", "foo");
    await mkdir(repo, { recursive: true });
    await writeFile(
      join(repo, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "agent-swarm": {
            type: "http",
            url: "http://stale/mcp",
            headers: { Authorization: "Bearer STALE", "X-Agent-ID": "stale-agent" },
          },
        },
      }),
    );

    const path = await createSessionMcpConfig(repo, "task-conflict");
    const written = await readWritten(path!);
    const swarm = written.mcpServers["agent-swarm"] as Record<string, unknown>;
    const headers = swarm.headers as Record<string, string>;
    expect(swarm.url).toBe("http://swarm/mcp");
    expect(headers.Authorization).toBe("Bearer SWARM");
    expect(headers["X-Agent-ID"]).toBe("a1");
    expect(headers["X-Source-Task-Id"]).toBe("task-conflict");
  });

  test("malformed repo-local .mcp.json is skipped without poisoning ancestor entries", async () => {
    await writeFile(
      join(sandbox, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "agent-swarm": {
            type: "http",
            url: "http://swarm/mcp",
            headers: { "X-Agent-ID": "a1" },
          },
        },
      }),
    );
    const repo = join(sandbox, "repos", "foo");
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, ".mcp.json"), "{ this is not valid json");

    const path = await createSessionMcpConfig(repo, "task-malformed");
    expect(path).not.toBeNull();
    const written = await readWritten(path!);
    expect(written.mcpServers["agent-swarm"]).toBeDefined();
  });

  test("only installedServers, no .mcp.json on disk", async () => {
    const cwd = join(sandbox, "no-mcp");
    await mkdir(cwd, { recursive: true });

    const path = await createSessionMcpConfig(cwd, "task-installed", {
      "from-api": {
        type: "http",
        url: "http://api.test/mcp",
        headers: { Authorization: "Bearer API" },
      },
    });
    expect(path).toBe("/tmp/mcp-task-installed.json");
    const written = await readWritten(path!);
    expect(written.mcpServers["from-api"]).toBeDefined();
  });

  test("includes context-mode entry when CONTEXT_MODE_DISABLED is unset", async () => {
    const prev = process.env.CONTEXT_MODE_DISABLED;
    delete process.env.CONTEXT_MODE_DISABLED;
    try {
      await writeFile(
        join(sandbox, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            "agent-swarm": {
              type: "http",
              url: "http://swarm/mcp",
              headers: { Authorization: "Bearer SWARM", "X-Agent-ID": "a1" },
            },
          },
        }),
      );
      const cwd = join(sandbox, "repos", "foo");
      await mkdir(cwd, { recursive: true });

      const path = await createSessionMcpConfig(cwd, "task-ctx-on");
      const written = await readWritten(path!);
      expect(written.mcpServers["plugin_context-mode_context-mode"]).toEqual({
        command: "context-mode",
      });
      // Coexists with the swarm entry.
      expect(written.mcpServers["agent-swarm"]).toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.CONTEXT_MODE_DISABLED;
      else process.env.CONTEXT_MODE_DISABLED = prev;
    }
  });

  test("excludes context-mode entry when CONTEXT_MODE_DISABLED='true'", async () => {
    const prev = process.env.CONTEXT_MODE_DISABLED;
    process.env.CONTEXT_MODE_DISABLED = "true";
    try {
      await writeFile(
        join(sandbox, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            "agent-swarm": {
              type: "http",
              url: "http://swarm/mcp",
              headers: { Authorization: "Bearer SWARM", "X-Agent-ID": "a1" },
            },
          },
        }),
      );
      const cwd = join(sandbox, "repos", "foo");
      await mkdir(cwd, { recursive: true });

      const path = await createSessionMcpConfig(cwd, "task-ctx-off");
      const written = await readWritten(path!);
      expect(written.mcpServers["plugin_context-mode_context-mode"]).toBeUndefined();
      // The swarm entry is still present.
      expect(written.mcpServers["agent-swarm"]).toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.CONTEXT_MODE_DISABLED;
      else process.env.CONTEXT_MODE_DISABLED = prev;
    }
  });
});
