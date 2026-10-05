import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelListItem, SDKMessage, TokenUsage } from "@cursor/sdk";
import { validateConfigValue } from "../be/swarm-config-guard";
import { configureDbResolver, resetDbResolver } from "../prompts/resolver";
import type { ProviderEvent, ProviderSessionConfig } from "../providers/types";

/**
 * A scripted stand-in for `@cursor/sdk`: each `send()` plays the next entry of
 * `script` as one run. A run `gate` holds the stream open until the test
 * releases it, so steering and abort can land mid-run.
 */
interface ScriptedRun {
  messages: SDKMessage[];
  status?: "finished" | "error" | "cancelled";
  error?: string;
  result?: string;
  usage?: TokenUsage;
  toolRounds?: number;
  gate?: Promise<void>;
  steerOutcome?: "complete_delivered" | "revert_to_followup";
  /** Holds `send()` itself open, before the run exists. */
  sendGate?: Promise<void>;
}

const sdk = {
  script: [] as ScriptedRun[],
  created: [] as Record<string, unknown>[],
  sent: [] as string[],
  steered: [] as string[],
  cancelled: 0,
  closed: 0,
  models: [] as ModelListItem[],
  meError: undefined as Error | undefined,
};

function usage(input: number, cacheRead: number, output: number): TokenUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
    totalTokens: input + cacheRead + output,
  };
}

mock.module("@cursor/sdk", () => {
  let agentCount = 0;
  class FakeRun {
    status: "running" | "finished" | "error" | "cancelled" = "running";
    private cancelledRelease: (() => void) | undefined;
    private readonly cancelGate = new Promise<void>((resolve) => {
      this.cancelledRelease = resolve;
    });
    constructor(
      readonly id: string,
      private readonly spec: ScriptedRun,
      private readonly onDelta?: (args: { update: { type: string } }) => void,
    ) {}
    async *stream() {
      for (let i = 0; i < (this.spec.toolRounds ?? 0); i++) {
        this.onDelta?.({ update: { type: "tool-requests-listed" } });
      }
      for (const message of this.spec.messages) yield message;
      if (this.spec.gate) await Promise.race([this.spec.gate, this.cancelGate]);
    }
    async wait() {
      if (this.status !== "cancelled") this.status = this.spec.status ?? "finished";
      return {
        id: this.id,
        status: this.status,
        result: this.status === "finished" ? this.spec.result : undefined,
        error: this.spec.error ? { message: this.spec.error } : undefined,
        usage: this.spec.usage,
      };
    }
    async cancel() {
      sdk.cancelled += 1;
      this.status = "cancelled";
      this.cancelledRelease?.();
    }
    async steer(text: string) {
      sdk.steered.push(text);
      return this.spec.steerOutcome ?? "complete_delivered";
    }
  }
  class FakeAgent {
    readonly agentId = `agent-${++agentCount}`;
    async send(text: string, options?: { onDelta?: (args: { update: { type: string } }) => void }) {
      sdk.sent.push(text);
      const spec = sdk.script.shift();
      if (!spec) throw new Error("no scripted run left");
      if (spec.sendGate) await spec.sendGate;
      return new FakeRun(`run-${sdk.sent.length}`, spec, options?.onDelta);
    }
    close() {
      sdk.closed += 1;
    }
  }
  return {
    Agent: {
      create: async (options: Record<string, unknown>) => {
        if (options.apiKey === "bogus") throw new Error("Invalid User API Key");
        sdk.created.push(options);
        return new FakeAgent();
      },
    },
    Cursor: {
      me: async () => {
        if (sdk.meError) throw sdk.meError;
        return { apiKeyName: "test", createdAt: "" };
      },
      models: { list: async () => sdk.models },
    },
    JsonlLocalAgentStore: class {
      constructor(readonly rootDir: string) {}
    },
  };
});

const {
  CursorAdapter,
  checkCursorCredentials,
  composeFirstMessage,
  cursorModelSelection,
  liveTestCursorKey,
  translateCursorMessage,
} = await import("../providers/cursor-adapter");

const NANO: ModelListItem = {
  id: "gpt-5.4-nano",
  displayName: "GPT-5.4 Nano",
  parameters: [
    {
      id: "reasoning",
      values: ["none", "low", "medium", "high", "xhigh"].map((value) => ({ value })),
    },
  ],
};
const SONNET: ModelListItem = {
  id: "claude-sonnet-4-6",
  displayName: "Claude Sonnet 4.6",
  aliases: ["sonnet-4.6"],
  parameters: [
    { id: "thinking", values: [{ value: "false" }, { value: "true" }] },
    { id: "effort", values: ["low", "medium", "high", "max"].map((value) => ({ value })) },
  ],
};
const GPT55: ModelListItem = {
  id: "gpt-5.5",
  displayName: "GPT-5.5",
  parameters: [
    { id: "reasoning", values: ["none", "low", "extra-high"].map((value) => ({ value })) },
  ],
};

const directories: string[] = [];
const savedKey = process.env.CURSOR_API_KEY;

afterEach(async () => {
  sdk.script = [];
  sdk.created = [];
  sdk.sent = [];
  sdk.steered = [];
  sdk.cancelled = 0;
  sdk.closed = 0;
  sdk.models = [];
  sdk.meError = undefined;
  resetDbResolver();
  if (savedKey === undefined) delete process.env.CURSOR_API_KEY;
  else process.env.CURSOR_API_KEY = savedKey;
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function sessionConfig(
  overrides: Partial<ProviderSessionConfig> = {},
): Promise<ProviderSessionConfig> {
  const cwd = await mkdtemp(join(tmpdir(), "cursor-adapter-test-"));
  directories.push(cwd);
  return {
    prompt: "do the task",
    systemPrompt: "You are a swarm worker.",
    model: "gpt-5.4-nano",
    role: "worker",
    agentId: "11111111-1111-4111-8111-111111111111",
    taskId: "22222222-2222-4222-8222-222222222222",
    apiUrl: "http://127.0.0.1:3013",
    apiKey: "swarm-key",
    cwd,
    logFile: join(cwd, "session.log"),
    contextKey: "task:test",
    env: { CURSOR_API_KEY: "cursor-test-key-123456", HOME: cwd },
    ...overrides,
  };
}

function collect(session: { onEvent(l: (e: ProviderEvent) => void): void }): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  session.onEvent((event) => events.push(event));
  return events;
}

const base = { agent_id: "a", run_id: "r" };

describe("CURSOR_NATIVE_SYSTEM_PROMPT config validation", () => {
  test("accepts boolean literals and rejects anything else", () => {
    const key = "CURSOR_NATIVE_SYSTEM_PROMPT";
    for (const value of ["true", "false", "1", "0", "TRUE"]) {
      expect(validateConfigValue(key, value)).toBeNull();
    }
    expect(validateConfigValue(key, "yes")).toContain(`Invalid ${key}`);
  });
});

describe("checkCursorCredentials", () => {
  test("needs CURSOR_API_KEY", () => {
    expect(checkCursorCredentials({}).ready).toBe(false);
    expect(checkCursorCredentials({}).missing).toEqual(["CURSOR_API_KEY"]);
    expect(checkCursorCredentials({ CURSOR_API_KEY: "  " }).ready).toBe(false);
    expect(checkCursorCredentials({ CURSOR_API_KEY: "key" })).toEqual({
      ready: true,
      missing: [],
      satisfiedBy: "env",
    });
  });

  test("live test reports Cursor's rejection", async () => {
    expect(await liveTestCursorKey("good")).toEqual({ ok: true });
    sdk.meError = new Error("Invalid User API Key");
    const result = await liveTestCursorKey("bad");
    expect(result).toEqual({
      ok: false,
      error: "Cursor rejected CURSOR_API_KEY: Invalid User API Key",
    });
  });
});

describe("cursorModelSelection", () => {
  const models = [NANO, SONNET, GPT55];

  test("writes the level into the model's own effort parameter", () => {
    expect(cursorModelSelection("gpt-5.4-nano", "low", models)).toEqual({
      selection: { id: "gpt-5.4-nano", params: [{ id: "reasoning", value: "low" }] },
      appliedEffort: "low",
    });
    expect(cursorModelSelection("claude-sonnet-4-6", "max", models).selection.params).toEqual([
      { id: "effort", value: "max" },
    ]);
  });

  test("maps Cursor's spellings and the off level", () => {
    expect(cursorModelSelection("gpt-5.5", "xhigh", models).selection.params).toEqual([
      { id: "reasoning", value: "extra-high" },
    ]);
    expect(cursorModelSelection("gpt-5.4-nano", "off", models).selection.params).toEqual([
      { id: "reasoning", value: "none" },
    ]);
    // No `none` value, but a thinking toggle.
    expect(cursorModelSelection("claude-sonnet-4-6", "off", models).selection.params).toEqual([
      { id: "thinking", value: "false" },
    ]);
  });

  test("resolves aliases and leaves unknown values and models alone", () => {
    expect(cursorModelSelection("sonnet-4.6", undefined, models)).toEqual({
      selection: { id: "claude-sonnet-4-6" },
      appliedEffort: null,
    });
    expect(cursorModelSelection("gpt-5.5", "medium", models)).toEqual({
      selection: { id: "gpt-5.5" },
      appliedEffort: null,
    });
    expect(cursorModelSelection("composer-2.5", "high", models)).toEqual({
      selection: { id: "composer-2.5" },
      appliedEffort: null,
    });
  });
});

describe("translateCursorMessage", () => {
  test("names swarm MCP calls like the claude harness", () => {
    const args = { providerIdentifier: "agent-swarm", toolName: "store-progress", args: {} };
    expect(
      translateCursorMessage({
        ...base,
        type: "tool_call",
        call_id: "c1",
        name: "mcp",
        status: "running",
        args,
      }),
    ).toEqual([
      { type: "tool_start", toolCallId: "c1", toolName: "mcp__agent-swarm__store-progress", args },
    ]);
    expect(
      translateCursorMessage({
        ...base,
        type: "tool_call",
        call_id: "c1",
        name: "shell",
        status: "error",
        result: "boom",
      }),
    ).toEqual([
      { type: "tool_end", toolCallId: "c1", toolName: "shell", result: { error: "boom" } },
    ]);
  });

  test("keeps text, drops usage and status", () => {
    expect(
      translateCursorMessage({
        ...base,
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      }),
    ).toEqual([{ type: "message", role: "assistant", content: "hi" }]);
    expect(translateCursorMessage({ ...base, type: "usage", usage: usage(1, 0, 1) })).toEqual([]);
    expect(translateCursorMessage({ ...base, type: "status", status: "RUNNING" })).toEqual([]);
  });

  test("composeFirstMessage wraps the system prompt", async () => {
    expect(await composeFirstMessage("", "task")).toBe("task");
    expect(await composeFirstMessage("sys", "task")).toBe(
      "<system_instructions>\nsys\n</system_instructions>\n\ntask",
    );
  });

  test("composeFirstMessage renders the registered template", async () => {
    configureDbResolver((eventType) =>
      eventType === "system.agent.cursor.first_message"
        ? { template: { id: "custom", scope: "global", body: "[{{systemPrompt}}] {{prompt}}" } }
        : null,
    );
    expect(await composeFirstMessage("sys", "task")).toBe("[sys] task");
  });

  test("composeFirstMessage keeps the system prompt on skipped, blank, and failing templates", async () => {
    for (const resolver of [
      () => ({ skip: true as const }),
      () => ({ template: { id: "blank", scope: "global", body: "  " } }),
      () => {
        throw new Error("db down");
      },
    ]) {
      configureDbResolver(resolver);
      expect(await composeFirstMessage("sys", "task")).toBe(
        "<system_instructions>\nsys\n</system_instructions>\n\ntask",
      );
    }
  });
});

describe("CursorAdapter sessions", () => {
  test("runs a task: MCP headers, first-message prompt, chunked text, tokens and cost", async () => {
    sdk.models = [NANO];
    sdk.script = [
      {
        messages: [
          {
            ...base,
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: "Do" }] },
          },
          {
            ...base,
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: "ne" }] },
          },
        ],
        result: "Done",
        usage: usage(16_000, 8_000, 100),
        toolRounds: 1,
      },
    ];
    const session = await new CursorAdapter().createSession(
      await sessionConfig({ reasoningEffort: "low" }),
    );
    const events = collect(session);
    const result = await session.waitForCompletion();

    expect(result.isError).toBe(false);
    expect(result.output).toBe("Done");
    expect(result.appliedReasoningEffort).toBe("low");
    expect(result.cost).toMatchObject({
      provider: "cursor",
      model: "gpt-5.4-nano",
      totalCostUsd: 0,
      // Cursor's input includes cache reads; CostData counts them apart.
      inputTokens: 8_000,
      cacheReadTokens: 8_000,
      outputTokens: 100,
      numTurns: 1,
    });
    const created = sdk.created[0] as Record<string, any>;
    expect(created.model).toEqual({
      id: "gpt-5.4-nano",
      params: [{ id: "reasoning", value: "low" }],
    });
    expect(created.systemPrompt).toBeUndefined();
    expect(created.local.sandboxOptions).toEqual({ enabled: false });
    expect(created.mcpServers["agent-swarm"]).toMatchObject({
      type: "http",
      url: "http://127.0.0.1:3013/mcp",
      headers: {
        Authorization: "Bearer swarm-key",
        "X-Agent-ID": "11111111-1111-4111-8111-111111111111",
        "X-Source-Task-Id": "22222222-2222-4222-8222-222222222222",
        "X-Context-Key": "task:test",
      },
    });
    expect(sdk.sent[0]).toBe(await composeFirstMessage("You are a swarm worker.", "do the task"));
    expect(events.filter((e) => e.type === "message")).toEqual([
      { type: "message", role: "assistant", content: "Done" },
    ]);
    const context = events.find((e) => e.type === "context_usage");
    // Two model calls (one tool round + the reply): per-call average.
    expect(context).toMatchObject({ contextUsedTokens: 8_050, contextFormula: "peak-proxy" });
    expect(events[0]).toEqual({ type: "session_init", sessionId: "agent-1", provider: "cursor" });
    expect(sdk.closed).toBe(1);
  });

  test("falls back to the first message when systemPrompt is not enabled", async () => {
    sdk.script = [
      {
        messages: [],
        status: "error",
        error: "[invalid_argument] unknown option '--system-prompt'",
      },
      { messages: [], result: "ok", usage: usage(10, 0, 1) },
    ];
    const config = await sessionConfig({
      env: { CURSOR_API_KEY: "k", CURSOR_NATIVE_SYSTEM_PROMPT: "true" },
    });
    const session = await new CursorAdapter().createSession(config);
    const events = collect(session);
    const result = await session.waitForCompletion();

    expect(result.isError).toBe(false);
    expect(sdk.created.map((c) => c.systemPrompt)).toEqual(["You are a swarm worker.", undefined]);
    expect(sdk.sent).toEqual([
      "do the task",
      await composeFirstMessage("You are a swarm worker.", "do the task"),
    ]);
    // The recreated agent is announced as the session, with its prompt mode.
    const inits = events.flatMap((e) => (e.type === "session_init" ? [e.sessionId] : []));
    expect(inits).toHaveLength(2);
    expect(inits[0]).not.toBe(inits[1]);
    expect(inits[1]).toBe(session.sessionId);
    expect(result.sessionId).toBe(inits[1]);
    const modes = events
      .filter((e) => e.type === "raw_log" && e.content.includes('"type":"model"'))
      .map((e) => JSON.parse((e as { content: string }).content).systemPrompt);
    expect(modes).toEqual(["native", "first-message"]);
  });

  test.each([
    ["1", "You are a swarm worker."],
    ["TRUE", "You are a swarm worker."],
    ["0", undefined],
    ["yes", undefined],
  ])("CURSOR_NATIVE_SYSTEM_PROMPT=%p parses like the config guard", async (flag, expected) => {
    sdk.script = [{ messages: [], result: "ok", usage: usage(10, 0, 1) }];
    const config = await sessionConfig({
      env: { CURSOR_API_KEY: "k", CURSOR_NATIVE_SYSTEM_PROMPT: flag },
    });
    const session = await new CursorAdapter().createSession(config);
    await session.waitForCompletion();
    expect(sdk.created.map((c) => c.systemPrompt)).toEqual([expected]);
  });

  test("queued steering is undeliverable when the active run fails", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    sdk.script = [
      {
        messages: [],
        gate,
        status: "error",
        error: "[resource_exhausted] usage limit",
        steerOutcome: "revert_to_followup",
      },
    ];
    const session = await new CursorAdapter().createSession(await sessionConfig());
    await Bun.sleep(5);
    const queued = session.deliverSteering!({ mode: "queue", text: "queued" });
    const reverted = session.deliverSteering!({ mode: "steer", text: "reverted" });
    release();
    const result = await session.waitForCompletion();

    expect(result.isError).toBe(true);
    for (const outcome of [await queued, await reverted]) {
      expect(outcome).toEqual({
        delivered: false,
        reason: "cursor session ended before the queued message was sent",
      });
    }
    expect(sdk.sent).toHaveLength(1);
  });

  test("queued steering is undeliverable when the session is cancelled", async () => {
    sdk.script = [
      { messages: [], gate: new Promise(() => {}), steerOutcome: "revert_to_followup" },
    ];
    const session = await new CursorAdapter().createSession(await sessionConfig());
    await Bun.sleep(5);
    const queued = session.deliverSteering!({ mode: "queue", text: "queued" });
    const reverted = session.deliverSteering!({ mode: "steer", text: "reverted" });
    await Bun.sleep(5);
    await session.abort("cancelled");
    const result = await session.waitForCompletion();

    expect(result.failureReason).toBe("cursor session aborted");
    for (const outcome of [await queued, await reverted]) {
      expect(outcome).toMatchObject({ delivered: false });
    }
    expect(sdk.sent).toHaveLength(1);
  });

  test("abort while send() is pending cancels the run once it arrives", async () => {
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    sdk.script = [
      {
        messages: [
          {
            ...base,
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: "late" }] },
          } as SDKMessage,
        ],
        sendGate,
        gate: new Promise(() => {}),
        result: "should not stream",
      },
    ];
    const session = await new CursorAdapter().createSession(await sessionConfig());
    const events = collect(session);
    await Bun.sleep(5);
    await session.abort("cancelled");
    releaseSend();
    const result = await session.waitForCompletion();

    expect(sdk.cancelled).toBe(1);
    expect(result.isError).toBe(true);
    expect(result.failureReason).toBe("cursor session aborted");
    expect(events.some((e) => e.type === "message")).toBe(false);
  });

  test("abort while a queued send is pending cancels it and reports it undeliverable", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    sdk.script = [
      { messages: [], gate, result: "first", usage: usage(10, 0, 1) },
      { messages: [], sendGate, gate: new Promise(() => {}), result: "second" },
    ];
    const session = await new CursorAdapter().createSession(await sessionConfig());
    await Bun.sleep(5);
    const queued = session.deliverSteering!({ mode: "queue", text: "queued" });
    release();
    await Bun.sleep(5);
    expect(sdk.sent).toHaveLength(2);
    await session.abort("cancelled");
    releaseSend();
    const result = await session.waitForCompletion();

    expect(sdk.cancelled).toBe(1);
    expect(result.failureReason).toBe("cursor session aborted");
    expect(await queued).toEqual({
      delivered: false,
      reason: "cursor session ended before the queued message was sent",
    });
  });

  test("steers the live run and queues reverted or queued messages as follow-up runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    sdk.script = [
      { messages: [], gate, steerOutcome: "revert_to_followup", usage: usage(10, 0, 1) },
      { messages: [], result: "after follow-up", usage: usage(10, 0, 1) },
      { messages: [], result: "after queue", usage: usage(10, 0, 1) },
    ];
    const session = await new CursorAdapter().createSession(await sessionConfig());
    await Bun.sleep(5);
    const steered = session.deliverSteering!({ mode: "steer", text: "steer me" });
    await Bun.sleep(5);
    const queued = session.deliverSteering!({ mode: "queue", text: "then this" });
    let settledEarly = false;
    void Promise.race([steered, queued]).then(() => {
      settledEarly = true;
    });
    await Bun.sleep(5);
    // Nothing is delivered until a run carrying it is accepted.
    expect(settledEarly).toBe(false);
    release();
    expect(await steered).toEqual({ delivered: true, mode: "queue" });
    expect(await queued).toEqual({ delivered: true, mode: "queue" });
    const result = await session.waitForCompletion();

    expect(sdk.steered).toEqual(["steer me"]);
    expect(sdk.sent.slice(1)).toEqual(["steer me", "then this"]);
    expect(result.output).toBe("after queue");
    expect(result.cost?.numTurns).toBe(3);
    expect(await session.deliverSteering!({ mode: "queue", text: "late" })).toEqual({
      delivered: false,
      reason: "cursor session already completed",
    });
  });

  test("delivers a steer into the running run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    sdk.script = [{ messages: [], gate, result: "MANGO", usage: usage(10, 0, 1) }];
    const session = await new CursorAdapter().createSession(await sessionConfig());
    await Bun.sleep(5);
    expect(await session.deliverSteering!({ mode: "steer", text: "the word is MANGO" })).toEqual({
      delivered: true,
      mode: "steer",
    });
    release();
    expect((await session.waitForCompletion()).output).toBe("MANGO");
    expect(sdk.sent).toHaveLength(1);
  });

  test("abort cancels the in-flight run", async () => {
    sdk.script = [{ messages: [], gate: new Promise(() => {}), usage: usage(10, 0, 1) }];
    const session = await new CursorAdapter().createSession(await sessionConfig());
    await Bun.sleep(5);
    await session.abort("cancelled");
    const result = await session.waitForCompletion();
    expect(sdk.cancelled).toBe(1);
    expect(result.isError).toBe(true);
    expect(result.failureReason).toBe("cursor session aborted");
  });

  test("a failed run is an error with Cursor's message", async () => {
    sdk.script = [{ messages: [], status: "error", error: "[resource_exhausted] usage limit" }];
    const session = await new CursorAdapter().createSession(await sessionConfig());
    const result = await session.waitForCompletion();
    expect(result.isError).toBe(true);
    expect(result.failureReason).toBe("[resource_exhausted] usage limit");
  });

  test("a missing or bogus key fails before any run", async () => {
    delete process.env.CURSOR_API_KEY;
    await expect(
      new CursorAdapter().createSession(await sessionConfig({ env: {} })),
    ).rejects.toThrow("cursor requires CURSOR_API_KEY");
    await expect(
      new CursorAdapter().createSession(await sessionConfig({ env: { CURSOR_API_KEY: "bogus" } })),
    ).rejects.toThrow("cursor agent create failed: Invalid User API Key");
  });

  test("defaults to the regular tier model", async () => {
    sdk.script = [{ messages: [], result: "ok" }];
    const session = await new CursorAdapter().createSession(await sessionConfig({ model: "" }));
    await session.waitForCompletion();
    expect((sdk.created[0] as { model: { id: string } }).model.id).toBe("claude-sonnet-5-5");
  });
});
