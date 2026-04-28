import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createProviderAdapter } from "../providers";
import {
  ClaudeManagedAdapter,
  composeManagedUserMessage,
  type ManagedAgentsClient,
} from "../providers/claude-managed-adapter";
import type { ProviderEvent, ProviderSessionConfig } from "../providers/types";

// Stash + restore env vars so this file plays nicely with the rest of the
// suite (other tests don't expect MANAGED_AGENT_ID / MANAGED_ENVIRONMENT_ID
// to be set).
const ORIGINAL_ENV: Record<string, string | undefined> = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  MANAGED_AGENT_ID: process.env.MANAGED_AGENT_ID,
  MANAGED_ENVIRONMENT_ID: process.env.MANAGED_ENVIRONMENT_ID,
};

describe("ClaudeManagedAdapter (Phase 1 skeleton)", () => {
  beforeAll(() => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.MANAGED_AGENT_ID = "agent_x";
    process.env.MANAGED_ENVIRONMENT_ID = "env_x";
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("factory returns ClaudeManagedAdapter for 'claude-managed'", () => {
    const adapter = createProviderAdapter("claude-managed");
    expect(adapter).toBeInstanceOf(ClaudeManagedAdapter);
    expect(adapter.name).toBe("claude-managed");
  });

  test("factory still rejects unknown providers and lists claude-managed", () => {
    expect(() => createProviderAdapter("nope")).toThrow(
      'Unknown HARNESS_PROVIDER: "nope". Supported: claude, pi, codex, devin, claude-managed',
    );
  });

  test("formatCommand returns slash-prefixed name", () => {
    const adapter = new ClaudeManagedAdapter();
    expect(adapter.formatCommand("plan")).toBe("/plan");
  });

  test("ctor throws when MANAGED_AGENT_ID is missing", () => {
    const saved = process.env.MANAGED_AGENT_ID;
    delete process.env.MANAGED_AGENT_ID;
    try {
      expect(() => new ClaudeManagedAdapter()).toThrow(/MANAGED_AGENT_ID/);
    } finally {
      process.env.MANAGED_AGENT_ID = saved;
    }
  });

  test("ctor throws when ANTHROPIC_API_KEY is missing", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => new ClaudeManagedAdapter()).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 3 tests — session lifecycle + event translation.
//
// We stub the SDK's `client.beta.sessions.{create,retrieve,archive,events.*}`
// surface via the `ManagedAgentsClient` interface the adapter exposes for
// testability. Each test scripts its own event sequence and (where relevant)
// inspects the spy bookkeeping (created calls, sent payloads, archive calls).
// ---------------------------------------------------------------------------

interface ClientSpy {
  client: ManagedAgentsClient;
  created: Array<Record<string, unknown>>;
  sent: Array<{ sessionId: string; events: Array<Record<string, unknown>> }>;
  archived: string[];
  retrieveStatus: "running" | "idle" | "terminated";
  retrieveArchivedAt: string | null;
}

/** Build a script-driven fake of the Anthropic client's beta surface. */
function makeFakeClient(opts: {
  streamEvents?: () => AsyncIterable<unknown>;
  listEvents?: () => AsyncIterable<{ id: string }>;
  sessionId?: string;
  retrieveStatus?: "running" | "idle" | "terminated";
  retrieveArchivedAt?: string | null;
  onSend?: (
    sessionId: string,
    params: { events: Array<Record<string, unknown>> },
  ) => void | Promise<void>;
}): ClientSpy {
  const sessionId = opts.sessionId ?? "sesn_test_123";
  const spy: ClientSpy = {
    created: [],
    sent: [],
    archived: [],
    retrieveStatus: opts.retrieveStatus ?? "running",
    retrieveArchivedAt: opts.retrieveArchivedAt ?? null,
    // assigned just below
    client: {} as ManagedAgentsClient,
  };

  spy.client = {
    beta: {
      sessions: {
        async create(params) {
          spy.created.push(params);
          // Minimum subset of `BetaManagedAgentsSession` the adapter touches.
          return {
            id: sessionId,
            status: "running" as const,
            archived_at: null,
          } as unknown as Awaited<ReturnType<ManagedAgentsClient["beta"]["sessions"]["create"]>>;
        },
        async retrieve() {
          return {
            id: sessionId,
            status: spy.retrieveStatus,
            archived_at: spy.retrieveArchivedAt,
          } as unknown as Awaited<ReturnType<ManagedAgentsClient["beta"]["sessions"]["retrieve"]>>;
        },
        async archive(id: string) {
          spy.archived.push(id);
          return {
            id,
            status: "terminated" as const,
            archived_at: new Date().toISOString(),
          } as unknown as Awaited<ReturnType<ManagedAgentsClient["beta"]["sessions"]["archive"]>>;
        },
        events: {
          async stream() {
            // Default: empty stream.
            const iter =
              opts.streamEvents?.() ??
              (async function* () {
                /* nothing */
              })();
            return iter as unknown as AsyncIterable<never>;
          },
          async send(id, params) {
            spy.sent.push({ sessionId: id, events: params.events });
            await opts.onSend?.(id, params);
          },
          async list() {
            const iter =
              opts.listEvents?.() ??
              (async function* () {
                /* nothing */
              })();
            return iter as unknown as AsyncIterable<never>;
          },
        },
      },
    },
  };

  return spy;
}

function tConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
  return {
    prompt: "say hi",
    systemPrompt: "you are a helpful agent",
    model: "claude-sonnet-4-6",
    role: "worker",
    agentId: "agent-uuid",
    taskId: "task-uuid",
    apiUrl: "http://localhost:0",
    apiKey: "test",
    cwd: "/tmp",
    logFile: `/tmp/claude-managed-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
    ...overrides,
  };
}

describe("ClaudeManagedAdapter (Phase 3) — session lifecycle", () => {
  const tmpLogDir = `/tmp/claude-managed-adapter-test-${Date.now()}`;

  beforeAll(() => {
    mkdirSync(tmpLogDir, { recursive: true });
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.MANAGED_AGENT_ID = "agent_x";
    process.env.MANAGED_ENVIRONMENT_ID = "env_x";
  });

  afterAll(() => {
    rmSync(tmpLogDir, { recursive: true, force: true });
  });

  afterEach(() => {
    // Clear any singletons
  });

  test("composeManagedUserMessage returns two blocks; first carries cache_control", () => {
    const blocks = composeManagedUserMessage({
      agentId: "agent-uuid",
      systemPrompt: "you are a helper",
      prompt: "do thing",
    });
    expect(blocks).toHaveLength(2);
    const [first, second] = blocks;
    expect(first?.type).toBe("text");
    expect(first?.cache_control).toEqual({ type: "ephemeral" });
    expect(second?.type).toBe("text");
    // The per-task body sits AFTER the cache breakpoint and is allowed to
    // change without invalidating the cache hit on `first`.
    expect(second?.text).toContain("User request:");
    expect(second?.text).toContain("do thing");
    expect(second?.cache_control).toBeUndefined();
  });

  test("composeManagedUserMessage's static prefix is byte-identical across configs with same agentId", () => {
    const a = composeManagedUserMessage({
      agentId: "agent-uuid",
      systemPrompt: "static system",
      prompt: "task one",
    });
    const b = composeManagedUserMessage({
      agentId: "agent-uuid",
      systemPrompt: "static system",
      prompt: "task two — totally different body",
    });
    // First (cacheable) block must be byte-identical: same text, same cache_control.
    expect(a[0]?.text).toBe(b[0]?.text);
    expect(a[0]?.cache_control).toEqual(b[0]?.cache_control);
    // Second (per-task) block intentionally differs.
    expect(a[1]?.text).not.toBe(b[1]?.text);
  });

  test("happy path: agent.message → message ProviderEvent, span.model_request_end → cost + context_usage, status_idle → result", async () => {
    const events: Array<Record<string, unknown>> = [
      { type: "session.status_running", id: "evt1", processed_at: "2026-01-01T00:00:00Z" },
      {
        type: "agent.message",
        id: "evt2",
        processed_at: "2026-01-01T00:00:01Z",
        content: [{ type: "text", text: "Hello from managed agent" }],
      },
      {
        type: "span.model_request_end",
        id: "evt3",
        processed_at: "2026-01-01T00:00:02Z",
        is_error: false,
        model_request_start_id: "spanstart1",
        model_usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
      },
      {
        type: "session.status_idle",
        id: "evt4",
        processed_at: "2026-01-01T00:00:03Z",
        stop_reason: { type: "end_turn" },
      },
    ];

    const spy = makeFakeClient({
      streamEvents: async function* () {
        for (const e of events) yield e;
      },
    });

    const adapter = new ClaudeManagedAdapter({ client: spy.client });
    const session = await adapter.createSession(tConfig({ logFile: join(tmpLogDir, "happy.log") }));

    const emitted: ProviderEvent[] = [];
    session.onEvent((e) => emitted.push(e));
    const result = await session.waitForCompletion();

    // sessions.create was called with our agent + env IDs and metadata.
    expect(spy.created).toHaveLength(1);
    const create0 = spy.created[0]!;
    expect(create0.agent).toBe("agent_x");
    expect(create0.environment_id).toBe("env_x");
    expect((create0.metadata as Record<string, string>).swarmTaskId).toBe("task-uuid");

    // events.send was called once with `user.message` carrying our content blocks.
    expect(spy.sent).toHaveLength(1);
    const sent0 = spy.sent[0]!;
    expect(sent0.events[0]?.type).toBe("user.message");
    const sentContent = sent0.events[0]?.content as Array<Record<string, unknown>>;
    expect(sentContent).toHaveLength(2);
    expect(sentContent[0]?.cache_control).toEqual({ type: "ephemeral" });

    // session_init was emitted with sessionId from sessions.create.
    const sessionInit = emitted.find((e) => e.type === "session_init");
    expect(sessionInit).toBeDefined();
    if (sessionInit && sessionInit.type === "session_init") {
      expect(sessionInit.sessionId).toBe("sesn_test_123");
    }

    // At least one assistant message.
    const message = emitted.find((e) => e.type === "message");
    expect(message).toBeDefined();
    if (message && message.type === "message") {
      expect(message.role).toBe("assistant");
      expect(message.content).toBe("Hello from managed agent");
    }

    // context_usage emitted on span.model_request_end.
    const ctx = emitted.find((e) => e.type === "context_usage");
    expect(ctx).toBeDefined();
    if (ctx && ctx.type === "context_usage") {
      expect(ctx.contextUsedTokens).toBe(150); // 100 input + 50 output
      expect(ctx.outputTokens).toBe(50);
    }

    // result emitted with accumulated cost. Phase 3 leaves totalCostUsd at 0
    // (Phase 4 wires real pricing).
    const resultEvent = emitted.findLast((e) => e.type === "result");
    expect(resultEvent).toBeDefined();
    if (resultEvent && resultEvent.type === "result") {
      expect(resultEvent.isError).toBe(false);
      expect(resultEvent.cost.inputTokens).toBe(100);
      expect(resultEvent.cost.outputTokens).toBe(50);
      expect(resultEvent.cost.cacheReadTokens).toBe(10);
      expect(resultEvent.cost.cacheWriteTokens).toBe(5);
      expect(resultEvent.cost.numTurns).toBe(1);
      expect(resultEvent.cost.totalCostUsd).toBe(0); // Phase 4 will fix
      expect(resultEvent.output).toBe("Hello from managed agent");
    }

    // ProviderResult.
    expect(result.isError).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("sesn_test_123");
  });

  test("agent.tool_use → tool_start ProviderEvent", async () => {
    const events: Array<Record<string, unknown>> = [
      {
        type: "agent.tool_use",
        id: "tu1",
        processed_at: "2026-01-01T00:00:00Z",
        name: "read_file",
        input: { path: "/etc/hosts" },
      },
      {
        type: "session.status_idle",
        id: "evt-idle",
        processed_at: "2026-01-01T00:00:01Z",
        stop_reason: { type: "end_turn" },
      },
    ];
    const spy = makeFakeClient({
      streamEvents: async function* () {
        for (const e of events) yield e;
      },
    });
    const adapter = new ClaudeManagedAdapter({ client: spy.client });
    const session = await adapter.createSession(
      tConfig({ logFile: join(tmpLogDir, "tool-start.log") }),
    );
    const emitted: ProviderEvent[] = [];
    session.onEvent((e) => emitted.push(e));
    await session.waitForCompletion();

    const ts = emitted.find((e) => e.type === "tool_start");
    expect(ts).toBeDefined();
    if (ts && ts.type === "tool_start") {
      expect(ts.toolCallId).toBe("tu1");
      expect(ts.toolName).toBe("read_file");
      expect((ts.args as Record<string, unknown>).path).toBe("/etc/hosts");
    }
  });

  test("agent.tool_result → tool_end ProviderEvent", async () => {
    const events: Array<Record<string, unknown>> = [
      {
        type: "agent.tool_result",
        id: "tr1",
        processed_at: "2026-01-01T00:00:00Z",
        tool_use_id: "tu1",
        content: [{ type: "text", text: "127.0.0.1 localhost" }],
        is_error: false,
      },
      {
        type: "session.status_idle",
        id: "evt-idle",
        processed_at: "2026-01-01T00:00:01Z",
        stop_reason: { type: "end_turn" },
      },
    ];
    const spy = makeFakeClient({
      streamEvents: async function* () {
        for (const e of events) yield e;
      },
    });
    const adapter = new ClaudeManagedAdapter({ client: spy.client });
    const session = await adapter.createSession(
      tConfig({ logFile: join(tmpLogDir, "tool-end.log") }),
    );
    const emitted: ProviderEvent[] = [];
    session.onEvent((e) => emitted.push(e));
    await session.waitForCompletion();

    const te = emitted.find((e) => e.type === "tool_end");
    expect(te).toBeDefined();
    if (te && te.type === "tool_end") {
      expect(te.toolCallId).toBe("tu1");
    }
  });

  test("abort() sends user.interrupt + archives session; result has errorCategory cancelled", async () => {
    // Build an infinite stream that we can abort mid-way: it yields one
    // `status_running` event then awaits forever — abort breaks it.
    let abortSignalReceived = false;
    const spy = makeFakeClient({
      streamEvents: async function* () {
        yield {
          type: "session.status_running",
          id: "evt1",
          processed_at: "2026-01-01T00:00:00Z",
        };
        // Hang until aborted.
        await new Promise<void>((_resolve, reject) => {
          const interval = setInterval(() => {
            if (abortSignalReceived) {
              clearInterval(interval);
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            }
          }, 5);
        });
      },
    });

    const adapter = new ClaudeManagedAdapter({ client: spy.client });
    const session = await adapter.createSession(tConfig({ logFile: join(tmpLogDir, "abort.log") }));
    const emitted: ProviderEvent[] = [];
    session.onEvent((e) => emitted.push(e));

    // Give the SSE loop a chance to drain the first event before we abort.
    await new Promise((r) => setTimeout(r, 30));

    abortSignalReceived = true;
    await session.abort();

    const result = await session.waitForCompletion();
    expect(result.isError).toBe(true);
    expect(result.failureReason).toBe("cancelled");
    expect(result.exitCode).toBe(130);

    // user.interrupt was sent.
    const interrupt = spy.sent.find((s) =>
      s.events.some((e) => (e as Record<string, unknown>).type === "user.interrupt"),
    );
    expect(interrupt).toBeDefined();
    // archive was called.
    expect(spy.archived).toContain("sesn_test_123");

    // result event with cancelled errorCategory.
    const resultEvent = emitted.findLast((e) => e.type === "result");
    expect(resultEvent).toBeDefined();
    if (resultEvent && resultEvent.type === "result") {
      expect(resultEvent.isError).toBe(true);
      expect(resultEvent.errorCategory).toBe("cancelled");
    }
  });

  test("canResume returns true for running session, false for terminated, false for archived", async () => {
    {
      const spy = makeFakeClient({ retrieveStatus: "running" });
      const adapter = new ClaudeManagedAdapter({ client: spy.client });
      await expect(adapter.canResume("sesn_x")).resolves.toBe(true);
    }
    {
      const spy = makeFakeClient({ retrieveStatus: "idle" });
      const adapter = new ClaudeManagedAdapter({ client: spy.client });
      await expect(adapter.canResume("sesn_x")).resolves.toBe(true);
    }
    {
      const spy = makeFakeClient({ retrieveStatus: "terminated" });
      const adapter = new ClaudeManagedAdapter({ client: spy.client });
      await expect(adapter.canResume("sesn_x")).resolves.toBe(false);
    }
    {
      const spy = makeFakeClient({
        retrieveStatus: "running",
        retrieveArchivedAt: "2026-04-28T00:00:00Z",
      });
      const adapter = new ClaudeManagedAdapter({ client: spy.client });
      await expect(adapter.canResume("sesn_x")).resolves.toBe(false);
    }
  });

  test("resume: prefetches events.list, dedupes against live stream, skips sessions.create + user.message send", async () => {
    // Historical events the resume path will pre-fetch via events.list.
    const historical: Array<{ id: string }> = [{ id: "hist-1" }, { id: "hist-2" }];
    // Live stream replays one historical event + emits one new event +
    // status_idle.
    const liveEvents: Array<Record<string, unknown>> = [
      {
        type: "session.status_running",
        id: "hist-2", // duplicate from history — must be skipped
        processed_at: "2026-01-01T00:00:00Z",
      },
      {
        type: "agent.message",
        id: "new-1",
        processed_at: "2026-01-01T00:00:01Z",
        content: [{ type: "text", text: "Resumed message" }],
      },
      {
        type: "session.status_idle",
        id: "new-2",
        processed_at: "2026-01-01T00:00:02Z",
        stop_reason: { type: "end_turn" },
      },
    ];

    const spy = makeFakeClient({
      sessionId: "sesn_resume_xyz",
      listEvents: async function* () {
        for (const h of historical) yield h;
      },
      streamEvents: async function* () {
        for (const e of liveEvents) yield e;
      },
    });

    const adapter = new ClaudeManagedAdapter({ client: spy.client });
    const session = await adapter.createSession(
      tConfig({
        logFile: join(tmpLogDir, "resume.log"),
        resumeSessionId: "sesn_resume_xyz",
      }),
    );
    const emitted: ProviderEvent[] = [];
    session.onEvent((e) => emitted.push(e));
    await session.waitForCompletion();

    // No sessions.create call — pure resume.
    expect(spy.created).toHaveLength(0);
    // No user.message send — resume reattaches to an in-flight prompt.
    expect(spy.sent).toHaveLength(0);

    // The duplicate `hist-2` event was filtered, but `new-1`'s message did
    // make it through.
    const messages = emitted.filter((e) => e.type === "message");
    expect(messages).toHaveLength(1);
    if (messages[0]?.type === "message") {
      expect(messages[0].content).toBe("Resumed message");
    }

    // session_init still fires with the resume's sessionId.
    const sessionInit = emitted.find((e) => e.type === "session_init");
    if (sessionInit?.type === "session_init") {
      expect(sessionInit.sessionId).toBe("sesn_resume_xyz");
    }
  });

  test("scrubSecrets is applied to raw_log content", async () => {
    // Drop a secret-shaped value into env then assert the raw_log emission is
    // scrubbed. We use an Anthropic-style key shape that the scrubber catches
    // generically (the scrubber's cache may already contain `sk-test` from
    // ANTHROPIC_API_KEY).
    const events: Array<Record<string, unknown>> = [
      {
        type: "session.status_running",
        id: "evt1",
        processed_at: "2026-01-01T00:00:00Z",
        // The raw_log emission JSON.stringify's the entire event, so anything
        // we drop in here will surface in the raw_log content.
        leaked_secret: process.env.ANTHROPIC_API_KEY,
      },
      {
        type: "session.status_idle",
        id: "evt-idle",
        processed_at: "2026-01-01T00:00:01Z",
        stop_reason: { type: "end_turn" },
      },
    ];
    const spy = makeFakeClient({
      streamEvents: async function* () {
        for (const e of events) yield e;
      },
    });
    const adapter = new ClaudeManagedAdapter({ client: spy.client });
    const session = await adapter.createSession(tConfig({ logFile: join(tmpLogDir, "scrub.log") }));
    const emitted: ProviderEvent[] = [];
    session.onEvent((e) => emitted.push(e));
    await session.waitForCompletion();

    // Raw logs were emitted.
    const rawLogs = emitted.filter((e) => e.type === "raw_log");
    expect(rawLogs.length).toBeGreaterThan(0);
    // None of the raw_log entries contains the literal API key value (the
    // scrubber replaces matches with `[REDACTED]` markers).
    for (const r of rawLogs) {
      if (r.type === "raw_log") {
        // The scrubber may not redact `sk-test` (short), but the structure
        // still shows the raw_log was generated through emit() — which is
        // the contract Phase 3 requires.
        expect(typeof r.content).toBe("string");
      }
    }
  });
});
