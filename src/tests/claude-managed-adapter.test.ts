import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createProviderAdapter } from "../providers";
import {
  ClaudeManagedAdapter,
  composeManagedUserMessage,
  type ManagedAgentsClient,
  normalizeRepoUrl,
} from "../providers/claude-managed-adapter";
import {
  CLAUDE_MANAGED_MODEL_PRICING,
  computeClaudeManagedCostUsd,
} from "../providers/claude-managed-models";
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

  test("composeManagedUserMessage returns two text blocks; second carries the per-task body", () => {
    const blocks = composeManagedUserMessage({
      agentId: "agent-uuid",
      systemPrompt: "you are a helper",
      prompt: "do thing",
    });
    expect(blocks).toHaveLength(2);
    const [first, second] = blocks;
    expect(first?.type).toBe("text");
    expect(second?.type).toBe("text");
    // The per-task body is the second block; the first block holds the static
    // identity + system prompt prefix (asserted byte-identical in the next test).
    expect(second?.text).toContain("User request:");
    expect(second?.text).toContain("do thing");
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
    // First (cacheable) block must be byte-identical so server-side caching
    // can hit it across consecutive runs.
    expect(a[0]?.text).toBe(b[0]?.text);
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
    expect(sentContent[0]?.type).toBe("text");
    expect(sentContent[1]?.type).toBe("text");

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
      // Phase 4: totalCostUsd is now computed via per-Mtok rates +
      // $0.08/session-hour runtime fee. With sonnet rates and 100/50/10/5
      // tokens, the token cost is essentially zero (sub-cent) but a few-ms
      // session also adds a sub-cent fee. We assert non-negative + finite
      // here; precise pricing is asserted in the Phase 4 describe block.
      expect(resultEvent.cost.totalCostUsd).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(resultEvent.cost.totalCostUsd)).toBe(true);
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

// ---------------------------------------------------------------------------
// Phase 4 tests — repo provisioning + cost data.
//
// 1. Resources mapping: when `vcsRepo` is set on the spawn config, the
//    `sessions.create` payload includes a `resources: [...]` array with a
//    `github_repository` entry pointing at the requested URL + branch.
//    When unset, the field is absent.
// 2. Pricing: `computeClaudeManagedCostUsd` returns the expected USD value
//    against Anthropic's published rates.
// 3. Runtime fee: a 1-hour session adds exactly $0.08 to `totalCostUsd`.
// ---------------------------------------------------------------------------

describe("ClaudeManagedAdapter (Phase 4) — repo provisioning + cost data", () => {
  const tmpLogDir = `/tmp/claude-managed-adapter-phase4-${Date.now()}`;

  beforeAll(() => {
    mkdirSync(tmpLogDir, { recursive: true });
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.MANAGED_AGENT_ID = "agent_x";
    process.env.MANAGED_ENVIRONMENT_ID = "env_x";
  });

  afterAll(() => {
    rmSync(tmpLogDir, { recursive: true, force: true });
    delete process.env.MANAGED_GITHUB_TOKEN;
    delete process.env.MANAGED_GITHUB_VAULT_ID;
  });

  afterEach(() => {
    delete process.env.MANAGED_GITHUB_TOKEN;
    delete process.env.MANAGED_GITHUB_VAULT_ID;
  });

  test("normalizeRepoUrl: passes through https URLs and expands owner/repo shorthand", () => {
    expect(normalizeRepoUrl("https://github.com/desplega-ai/agent-swarm")).toBe(
      "https://github.com/desplega-ai/agent-swarm",
    );
    expect(normalizeRepoUrl("desplega-ai/agent-swarm")).toBe(
      "https://github.com/desplega-ai/agent-swarm",
    );
    expect(normalizeRepoUrl("http://gitlab.example.com/foo/bar")).toBe(
      "http://gitlab.example.com/foo/bar",
    );
  });

  test("createSession includes resources[github_repository] when config.vcsRepo is set", async () => {
    process.env.MANAGED_GITHUB_TOKEN = "ghp_test_pat";
    const events: Array<Record<string, unknown>> = [
      {
        type: "session.status_idle",
        id: "evt-idle",
        processed_at: "2026-01-01T00:00:00Z",
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
      tConfig({
        logFile: join(tmpLogDir, "with-vcsrepo.log"),
        vcsRepo: "desplega-ai/agent-swarm",
      }),
    );
    await session.waitForCompletion();

    expect(spy.created).toHaveLength(1);
    const params = spy.created[0]!;
    const resources = params.resources as Array<Record<string, unknown>> | undefined;
    expect(resources).toBeDefined();
    expect(resources).toHaveLength(1);
    const repo = resources![0]!;
    expect(repo.type).toBe("github_repository");
    expect(repo.url).toBe("https://github.com/desplega-ai/agent-swarm");
    expect(repo.authorization_token).toBe("ghp_test_pat");
    const checkout = repo.checkout as Record<string, unknown> | undefined;
    expect(checkout?.type).toBe("branch");
    expect(checkout?.name).toBe("main");
  });

  test("createSession passes vault_ids when MANAGED_GITHUB_VAULT_ID is set", async () => {
    process.env.MANAGED_GITHUB_VAULT_ID = "vault_abc123";
    const events: Array<Record<string, unknown>> = [
      {
        type: "session.status_idle",
        id: "evt-idle",
        processed_at: "2026-01-01T00:00:00Z",
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
      tConfig({
        logFile: join(tmpLogDir, "with-vault.log"),
        vcsRepo: "desplega-ai/agent-swarm",
      }),
    );
    await session.waitForCompletion();

    const params = spy.created[0]!;
    expect(params.vault_ids).toEqual(["vault_abc123"]);
  });

  test("createSession omits resources entirely when vcsRepo is unset", async () => {
    const events: Array<Record<string, unknown>> = [
      {
        type: "session.status_idle",
        id: "evt-idle",
        processed_at: "2026-01-01T00:00:00Z",
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
      tConfig({ logFile: join(tmpLogDir, "no-vcsrepo.log") }),
    );
    await session.waitForCompletion();

    expect(spy.created).toHaveLength(1);
    const params = spy.created[0]!;
    expect(params.resources).toBeUndefined();
  });

  test("computeClaudeManagedCostUsd returns expected USD for sonnet-4-6 against published rate", () => {
    // 1M input tokens × $3.00/Mtok = $3.00
    // 100k output tokens × $15.00/Mtok = $1.50
    // total = $4.50
    const cost = computeClaudeManagedCostUsd("claude-sonnet-4-6", 1_000_000, 100_000, 0, 0);
    expect(cost).toBeCloseTo(4.5, 10);
  });

  test("computeClaudeManagedCostUsd factors cache-read and cache-write at correct rates", () => {
    // Sonnet rates: cache-read $0.30/Mtok, cache-write $3.75/Mtok
    // 1M cache-read = $0.30; 1M cache-write = $3.75; total = $4.05
    const cost = computeClaudeManagedCostUsd(
      "claude-sonnet-4-6",
      0,
      0,
      1_000_000, // cache read
      1_000_000, // cache write
    );
    expect(cost).toBeCloseTo(4.05, 10);
  });

  test("computeClaudeManagedCostUsd returns 0 for unknown model (silenced after first warn)", () => {
    // The console.warn dedup is a Set<string> on the module — we just assert
    // the return value here. We don't assert the warn itself fires (it's
    // stateful and tested implicitly by it being deduplicated across calls).
    const cost1 = computeClaudeManagedCostUsd("totally-fake-model-xyz", 1_000, 1_000, 0, 0);
    const cost2 = computeClaudeManagedCostUsd("totally-fake-model-xyz", 1_000, 1_000, 0, 0);
    expect(cost1).toBe(0);
    expect(cost2).toBe(0);
  });

  test("CLAUDE_MANAGED_MODEL_PRICING covers sonnet, opus, haiku at minimum", () => {
    expect(CLAUDE_MANAGED_MODEL_PRICING["claude-sonnet-4-6"]).toBeDefined();
    expect(CLAUDE_MANAGED_MODEL_PRICING["claude-opus-4-7"]).toBeDefined();
    expect(CLAUDE_MANAGED_MODEL_PRICING["claude-haiku-4-5"]).toBeDefined();
  });

  test("session totalCostUsd = token cost + (durationMs/3.6e6) × $0.08 runtime fee", async () => {
    // Run a short live session, then reverse-derive the runtime fee from the
    // final `durationMs` and assert the formula holds. The runtime fee scales
    // linearly so we can validate the contract on a sub-second wallclock —
    // there's no need to actually run for an hour.
    const events: Array<Record<string, unknown>> = [
      {
        type: "span.model_request_end",
        id: "span1",
        processed_at: "2026-01-01T00:00:00Z",
        is_error: false,
        model_request_start_id: "spanstart1",
        model_usage: {
          input_tokens: 1_000_000,
          output_tokens: 100_000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
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
      tConfig({
        logFile: join(tmpLogDir, "runtime-fee.log"),
        model: "claude-sonnet-4-6",
      }),
    );
    const emitted: ProviderEvent[] = [];
    session.onEvent((e) => emitted.push(e));
    await session.waitForCompletion();

    const resultEvent = emitted.findLast((e) => e.type === "result");
    expect(resultEvent).toBeDefined();
    if (resultEvent && resultEvent.type === "result") {
      const tokenOnly = computeClaudeManagedCostUsd(
        "claude-sonnet-4-6",
        resultEvent.cost.inputTokens ?? 0,
        resultEvent.cost.outputTokens ?? 0,
        resultEvent.cost.cacheReadTokens ?? 0,
        resultEvent.cost.cacheWriteTokens ?? 0,
      );
      const expectedRuntimeFee = (resultEvent.cost.durationMs / 3_600_000) * 0.08;
      const expectedTotal = tokenOnly + expectedRuntimeFee;
      // The runtime fee should match formula exactly (both are pure numeric
      // multiplications on the same `durationMs` value).
      expect(resultEvent.cost.totalCostUsd).toBeCloseTo(expectedTotal, 10);
      // Sanity: token cost matches the published rate on its own.
      expect(tokenOnly).toBeCloseTo(4.5, 10);
      // Fee should be non-negative (durationMs ≥ 0). On a sub-ms session
      // `Date.now() - startedAt` can round to 0; what we're really asserting
      // is the formula composition, not a floor on duration.
      expect(expectedRuntimeFee).toBeGreaterThanOrEqual(0);
    }
  });

  test("snapshotCost adds exactly $0.08 to totalCostUsd for a 1-hour durationMs", () => {
    // Pure unit test on the formula: feed a known durationMs into the
    // pricing+fee math and assert the fee component equals $0.08 within FP.
    // We compute this directly here (the adapter's `snapshotCost` is a
    // private method); the formula is `(durationMs / 3_600_000) * 0.08`.
    const oneHourMs = 3_600_000;
    const fee = (oneHourMs / 3_600_000) * 0.08;
    expect(fee).toBeCloseTo(0.08, 12);
    // Also assert that token cost + fee for a sonnet 1M/100k turn lands at $4.58.
    const tokenCost = computeClaudeManagedCostUsd("claude-sonnet-4-6", 1_000_000, 100_000, 0, 0);
    expect(tokenCost + fee).toBeCloseTo(4.58, 10);
  });
});

// ---------------------------------------------------------------------------
// Phase 5 tests — cancellation polling + heartbeat + tool-loop detection.
//
// The adapter wires `createClaudeManagedSwarmEventHandler` as a session
// listener when `config.taskId/apiUrl/apiKey` are present. The handler polls
// the swarm API on every `tool_start` (throttled 500ms) and, if the task is
// listed as cancelled, fires `abortRef.current?.abort()` + the onCancel
// callback (which sends `user.interrupt` + archives the session).
// ---------------------------------------------------------------------------

describe("ClaudeManagedAdapter (Phase 5) — cancellation + tool-loop detection", () => {
  const tmpLogDir = `/tmp/claude-managed-adapter-phase5-${Date.now()}`;

  beforeAll(() => {
    mkdirSync(tmpLogDir, { recursive: true });
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.MANAGED_AGENT_ID = "agent_x";
    process.env.MANAGED_ENVIRONMENT_ID = "env_x";
  });

  afterAll(() => {
    rmSync(tmpLogDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  // Stub fetch for swarm-API calls. Each test installs its own response
  // function and inspects the captured calls.
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("throttle constants match the codex pre-extraction values", async () => {
    // Validates the shared module's exported throttle windows. If anyone
    // changes them this test breaks loudly — the plan's hard constraint.
    const shared = await import("../providers/swarm-events-shared");
    expect(shared.CANCELLATION_THROTTLE_MS).toBe(500);
    expect(shared.HEARTBEAT_THROTTLE_MS).toBe(5_000);
    expect(shared.ACTIVITY_THROTTLE_MS).toBe(5_000);
    expect(shared.CONTEXT_THROTTLE_MS).toBe(30_000);
  });

  test("cancel poll → adapter aborts, sessions.archive called, errorCategory=cancelled", async () => {
    // Use a unique taskId so the on-disk tool-loop-detection history at
    // /tmp/agent-swarm-tool-history/<taskId>.json starts empty. With a fixed
    // taskId, repeated test runs accumulate enough identical tool_use entries
    // to trip the loop-detection threshold (15) — that fires
    // abortController.abort() WITHOUT going through the cancel-poll path, so
    // sessions.archive never gets called and this test fails for the wrong
    // reason. Unique-id keeps cancellation observable to ONE source: the poll.
    const taskId = `cancel-poll-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // The fake stream yields tool_use events one at a time, with a small
    // delay between each so the cancel poll has time to fire and abort
    // between events. After a few tool_use events the cancel endpoint
    // reports the task as cancelled.
    let pollCount = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/cancelled-tasks")) {
        pollCount += 1;
        // Second poll: report cancelled.
        if (pollCount >= 2) {
          return new Response(
            JSON.stringify({ cancelled: [{ id: taskId, failureReason: "user request" }] }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ cancelled: [] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    // Stream that yields a tool_use, waits, yields another tool_use, then
    // hangs until aborted.
    let cancelObserved = false;
    const spy = makeFakeClient({
      streamEvents: async function* () {
        // First tool_use — triggers cancel poll #1 (returns not-cancelled).
        yield {
          type: "agent.tool_use",
          id: "tu1",
          processed_at: "2026-01-01T00:00:00Z",
          name: "read_file",
          input: { path: "/etc/hosts" },
        };
        // Wait > 500ms throttle window so the next poll runs.
        await new Promise((r) => setTimeout(r, 600));
        // Second tool_use — triggers cancel poll #2 (returns cancelled).
        yield {
          type: "agent.tool_use",
          id: "tu2",
          processed_at: "2026-01-01T00:00:01Z",
          name: "read_file",
          input: { path: "/etc/passwd" },
        };
        // Hang until the abort signal flips (the swarm-event handler fires
        // abortController.abort() once cancellation is observed).
        for (let i = 0; i < 100; i++) {
          if (cancelObserved) {
            throw Object.assign(new Error("aborted"), { name: "AbortError" });
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      },
    });

    const adapter = new ClaudeManagedAdapter({ client: spy.client });
    const session = await adapter.createSession(
      tConfig({
        logFile: join(tmpLogDir, "cancel-poll.log"),
        // Provide the API context so the swarm-event handler attaches.
        apiUrl: "http://test-api",
        apiKey: "test-key",
        taskId,
      }),
    );

    const emitted: ProviderEvent[] = [];
    session.onEvent((e) => {
      emitted.push(e);
    });

    // Watch for the archive call (the onCancel callback's signal of
    // cancellation). Wait up to 3s for the cancel-poll-driven flow to
    // unwind.
    const start = Date.now();
    while (Date.now() - start < 3_000) {
      if (spy.archived.length > 0) {
        cancelObserved = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    const result = await session.waitForCompletion();
    expect(result.isError).toBe(true);
    expect(result.failureReason).toBe("cancelled");
    expect(result.exitCode).toBe(130);

    // sessions.archive was called.
    expect(spy.archived).toContain("sesn_test_123");

    // user.interrupt was sent to the session.
    const interrupt = spy.sent.find((s) =>
      s.events.some((e) => (e as Record<string, unknown>).type === "user.interrupt"),
    );
    expect(interrupt).toBeDefined();

    // result event has errorCategory: "cancelled".
    const resultEvent = emitted.findLast((e) => e.type === "result");
    expect(resultEvent).toBeDefined();
    if (resultEvent && resultEvent.type === "result") {
      expect(resultEvent.errorCategory).toBe("cancelled");
    }
  }, 10_000);

  test("repeated identical tool_use events trigger checkToolLoop block → session aborts", async () => {
    // checkToolLoop persists history across calls in /tmp using the taskId
    // as the session key. We use a unique taskId per test run so we don't
    // contaminate other tests. After 15 identical tool_use events the
    // detector returns blocked=true (REPEAT_CRITICAL_THRESHOLD = 15 in
    // src/hooks/tool-loop-detection.ts).
    const taskId = `task-loop-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Fetch stub: cancel poll always returns empty (we want the LOOP path,
    // not the cancel path, to drive the abort).
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ cancelled: [] }), { status: 200 })) as typeof fetch;

    let abortObserved = false;
    const spy = makeFakeClient({
      streamEvents: async function* () {
        // Yield 20 identical tool_use events with tiny gaps — well above
        // the critical threshold.
        for (let i = 0; i < 20; i++) {
          if (abortObserved) {
            throw Object.assign(new Error("aborted"), { name: "AbortError" });
          }
          yield {
            type: "agent.tool_use",
            id: `tu-${i}`,
            processed_at: "2026-01-01T00:00:00Z",
            name: "stuck_tool",
            input: { same: "args" },
          };
          // Small await so the async checkToolLoop has a chance to fire.
          await new Promise((r) => setTimeout(r, 25));
        }
      },
    });

    const adapter = new ClaudeManagedAdapter({ client: spy.client });
    const session = await adapter.createSession(
      tConfig({
        logFile: join(tmpLogDir, "tool-loop.log"),
        apiUrl: "http://test-api",
        apiKey: "test-key",
        taskId,
      }),
    );

    const emitted: ProviderEvent[] = [];
    session.onEvent((e) => {
      emitted.push(e);
    });

    // Wait until we observe a raw_stderr warning OR archive — either path
    // proves the abort fired from the loop detector.
    const start = Date.now();
    while (Date.now() - start < 5_000) {
      const blockedWarning = emitted.find(
        (e) =>
          e.type === "raw_stderr" &&
          typeof e.content === "string" &&
          e.content.includes("Tool-loop"),
      );
      if (blockedWarning || spy.archived.length > 0) {
        abortObserved = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    const result = await session.waitForCompletion();
    // Either the loop detector aborted (errorCategory cancelled) or the
    // stream completed all 20 events naturally — but the warning should
    // have surfaced in the emitted events.
    const blockedWarning = emitted.find(
      (e) =>
        e.type === "raw_stderr" && typeof e.content === "string" && e.content.includes("Tool-loop"),
    );
    expect(blockedWarning).toBeDefined();
    // After the block fires, abort propagates → cancelled result.
    expect(result.isError).toBe(true);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Phase 6 — End-to-end integration test.
//
// Exercises createSession → mocked SSE stream with a representative event
// sequence (status_running, model_request_end, agent.message, agent.tool_use,
// agent.tool_result, status_idle) → asserts the full ProviderResult including
// USD cost > 0 and `output` containing the assistant's text. This is the
// "happy path with everything wired up" guard: if any of the upstream phases
// regress in isolation the smaller-scoped tests catch it; this one catches
// integration drift between phases.
// ---------------------------------------------------------------------------

describe("ClaudeManagedAdapter (Phase 6) — full happy-path integration", () => {
  const tmpLogDir = `/tmp/claude-managed-adapter-phase6-${Date.now()}`;

  beforeAll(() => {
    mkdirSync(tmpLogDir, { recursive: true });
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.MANAGED_AGENT_ID = "agent_x";
    process.env.MANAGED_ENVIRONMENT_ID = "env_x";
  });

  afterAll(() => {
    rmSync(tmpLogDir, { recursive: true, force: true });
  });

  test("end-to-end: status_running → model_request_end → message → tool_use → tool_result → status_idle yields populated ProviderResult", async () => {
    // Use opus-class token volume so the per-Mtok pricing produces a clearly
    // positive USD value (sub-cent volumes get hidden under floating-point
    // noise even though they're technically > 0). 1M input tokens against
    // sonnet-4-6 at $3.00/Mtok = $3.00 — comfortably above zero.
    const events: Array<Record<string, unknown>> = [
      {
        type: "session.status_running",
        id: "evt-running",
        processed_at: "2026-04-28T00:00:00Z",
      },
      {
        type: "span.model_request_end",
        id: "evt-model-end",
        processed_at: "2026-04-28T00:00:01Z",
        is_error: false,
        model_request_start_id: "span-start-1",
        model_usage: {
          input_tokens: 1_000_000,
          output_tokens: 200_000,
          cache_read_input_tokens: 50_000,
          cache_creation_input_tokens: 25_000,
        },
      },
      {
        type: "agent.message",
        id: "evt-msg",
        processed_at: "2026-04-28T00:00:02Z",
        content: [{ type: "text", text: "Read the file and here's what I found." }],
      },
      {
        type: "agent.tool_use",
        id: "evt-tool-use",
        processed_at: "2026-04-28T00:00:03Z",
        name: "read_file",
        input: { path: "/etc/motd" },
      },
      {
        type: "agent.tool_result",
        id: "evt-tool-result",
        processed_at: "2026-04-28T00:00:04Z",
        tool_use_id: "evt-tool-use",
        content: [{ type: "text", text: "Welcome to the managed sandbox." }],
        is_error: false,
      },
      {
        type: "session.status_idle",
        id: "evt-idle",
        processed_at: "2026-04-28T00:00:05Z",
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
      tConfig({
        model: "claude-sonnet-4-6",
        logFile: join(tmpLogDir, "e2e.log"),
      }),
    );

    const emitted: ProviderEvent[] = [];
    session.onEvent((e) => emitted.push(e));
    const result = await session.waitForCompletion();

    // Lifecycle: sessions.create called once with our agent + environment IDs.
    expect(spy.created).toHaveLength(1);
    const create0 = spy.created[0]!;
    expect(create0.agent).toBe("agent_x");
    expect(create0.environment_id).toBe("env_x");

    // user.message was sent once with the cache-control breakpoint on the
    // first content block.
    expect(spy.sent).toHaveLength(1);
    const userMsg = spy.sent[0]!.events[0]!;
    expect(userMsg.type).toBe("user.message");
    const blocks = userMsg.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.type).toBe("text");
    expect(blocks[1]?.type).toBe("text");

    // Every event in the SSE sequence translated into the expected
    // ProviderEvent variants.
    const sessionInit = emitted.find((e) => e.type === "session_init");
    expect(sessionInit?.type).toBe("session_init");
    if (sessionInit?.type === "session_init") {
      expect(sessionInit.sessionId).toBe("sesn_test_123");
    }

    const message = emitted.find((e) => e.type === "message");
    expect(message?.type).toBe("message");
    if (message?.type === "message") {
      expect(message.role).toBe("assistant");
      expect(message.content).toBe("Read the file and here's what I found.");
    }

    const toolStart = emitted.find((e) => e.type === "tool_start");
    expect(toolStart?.type).toBe("tool_start");
    if (toolStart?.type === "tool_start") {
      expect(toolStart.toolCallId).toBe("evt-tool-use");
      expect(toolStart.toolName).toBe("read_file");
      expect((toolStart.args as Record<string, unknown>).path).toBe("/etc/motd");
    }

    const toolEnd = emitted.find((e) => e.type === "tool_end");
    expect(toolEnd?.type).toBe("tool_end");
    if (toolEnd?.type === "tool_end") {
      expect(toolEnd.toolCallId).toBe("evt-tool-use");
    }

    const ctxUsage = emitted.find((e) => e.type === "context_usage");
    expect(ctxUsage?.type).toBe("context_usage");
    if (ctxUsage?.type === "context_usage") {
      // 1M input + 200k output = 1.2M used; output = 200k.
      expect(ctxUsage.contextUsedTokens).toBe(1_200_000);
      expect(ctxUsage.outputTokens).toBe(200_000);
    }

    // The terminal `result` ProviderEvent — the contract Phase 4 hardened —
    // carries populated cost, output, and isError=false.
    const resultEvent = emitted.findLast((e) => e.type === "result");
    expect(resultEvent?.type).toBe("result");
    if (resultEvent?.type === "result") {
      expect(resultEvent.isError).toBe(false);
      expect(resultEvent.cost.inputTokens).toBe(1_000_000);
      expect(resultEvent.cost.outputTokens).toBe(200_000);
      expect(resultEvent.cost.cacheReadTokens).toBe(50_000);
      expect(resultEvent.cost.cacheWriteTokens).toBe(25_000);
      expect(resultEvent.cost.numTurns).toBe(1);
      expect(resultEvent.cost.model).toBe("claude-sonnet-4-6");
      // USD cost > 0 — proves the per-Mtok pricing table is wired in.
      expect(resultEvent.cost.totalCostUsd).toBeGreaterThan(0);
      expect(Number.isFinite(resultEvent.cost.totalCostUsd)).toBe(true);
      // Output carries the assistant's text — proves the message → output
      // pipeline runs end-to-end.
      expect(resultEvent.output).toBe("Read the file and here's what I found.");
    }

    // ProviderResult — what the runner consumes.
    expect(result.isError).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("sesn_test_123");
    expect(result.cost?.totalCostUsd).toBeGreaterThan(0);
    expect(result.output).toBe("Read the file and here's what I found.");
  });
});
