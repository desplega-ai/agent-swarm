import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as contractRuntime from "../extensions/contract-runtime";

// Unit tests for templates/extensions/comms-adherence-gate/hooks.ts. Every Jev call goes
// to a mocked fetch and the DB read to a mocked ctx.swarm.db_query; nothing reaches the
// network.

// `swarm-extension` is a bare import the extension loader shims to contract-runtime.
mock.module("swarm-extension", () => contractRuntime);

type Handler = (event: any, ctx: any) => Promise<any>;
let handler: Handler;
let mod: any;

const ENV_KEYS = ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY"];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  mod = await import("../../templates/extensions/comms-adherence-gate/hooks.ts");
  mod.default({
    on: (name: string, h: Handler) => {
      if (name === "pre.tool.call") handler = h;
    },
  });
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const TASK_ID = "11111111-2222-3333-4444-555555555555";
const PREFS = { verbosity: "very terse", tone: "direct, plain", language: "English" };
const TASK_TEXT =
  "<thread_context>\n<@U1|Alice>: earlier chatter about deploys\n</thread_context>\n\nwhich option did you pick?";

const realFetch = globalThis.fetch;
let jevCalls: Array<{ url: string; body: any; auth: string }> = [];

const mockJev = (reply: (body: any) => Response | Promise<Response>) => {
  globalThis.fetch = (async (url: any, init: any) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    jevCalls.push({ url: String(url), body, auth: String(init?.headers?.Authorization ?? "") });
    return reply(body);
  }) as typeof fetch;
};
/** Answer every question with the same score, or per-question scores. */
const jevScores = (scores: number | Record<string, number>) =>
  mockJev((body) => {
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions ?? {})) {
      const s = typeof scores === "number" ? scores : (scores[id] ?? 1);
      answers[id] = { type: "noul", noul: s };
    }
    return Response.json({ model: "jev-1.13.0", answers });
  });

type Row = Record<string, unknown> | null;
const taskRow = (over: Record<string, unknown> = {}): Row => ({
  source: "slack",
  slackThreadTs: "1700000000.000100",
  agentId: "agent-1",
  requestedByUserId: "user-1",
  comms: JSON.stringify(PREFS),
  name: "Alice",
  askHead: TASK_TEXT.slice(0, 400),
  askTail: TASK_TEXT.slice(-1400),
  ...over,
});

const makeCtx = (
  config: Record<string, unknown> = {},
  opts: {
    row?: Row;
    key?: string;
    openrouterKey?: string;
    dbThrows?: boolean;
    /** The caller's agents.isLead; null means no agents row. */
    callerIsLead?: boolean | null;
    /** user_external_ids x users rows for the mention lookup. */
    addressees?: Record<string, unknown>[];
  } = {},
) => {
  const kv: Record<string, unknown> = {};
  const counters: Record<string, number> = {};
  const queries: any[] = [];
  const setEnv = (name: string, value: string) => {
    if (value) process.env[name] = value;
    else delete process.env[name];
  };
  setEnv("TYPESAFE_API_KEY", opts.key ?? "tsk-test");
  setEnv("OPENROUTER_API_KEY", opts.openrouterKey ?? "");
  const row = opts.row === undefined ? taskRow() : opts.row;
  const swarm = {
    db_query: async (args: any) => {
      queries.push(args);
      if (opts.dbThrows) throw new Error("db down");
      if (String(args.sql).includes("user_external_ids")) {
        const rows = (opts.addressees ?? []).filter((r) => args.params.includes(r.externalId));
        return { success: true, data: { rows } };
      }
      if (String(args.sql).includes("FROM agents")) {
        const lead = opts.callerIsLead ?? false;
        return {
          success: true,
          data: { rows: opts.callerIsLead === null ? [] : [{ isLead: lead ? 1 : 0 }] },
        };
      }
      return { success: true, data: { rows: row ? [row] : [] } };
    },
    kv_set: async ({ key, value }: any) => {
      kv[key] = value;
      return { success: true };
    },
    kv_get: async ({ key }: any) =>
      key in counters ? { success: true, data: { value: counters[key] } } : { success: false },
    kv_incr: async ({ key }: any) => {
      counters[key] = (counters[key] ?? 0) + 1;
      return { success: true };
    },
  };
  const warns: unknown[] = [];
  return {
    ctx: {
      swarm,
      config,
      state: {},
      log: { debug() {}, info() {}, warn: (...a: unknown[]) => warns.push(a), error() {} },
      signal: new AbortController().signal,
    },
    kv,
    counters,
    queries,
    warns,
  };
};

const completion = (output: string, extra: Record<string, unknown> = {}) => ({
  tool: "store-progress",
  args: { taskId: TASK_ID, status: "completed", output, ...extra },
  requestInfo: { callOrigin: "mcp", agentId: "agent-1" },
});

beforeEach(() => {
  jevCalls = [];
  mod.resetKeyCache();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("defaults", () => {
  test("a new install defaults to shadow", () => {
    expect(mod.cfgOf(undefined)).toMatchObject({
      mode: "shadow",
      threshold: 0.5,
      timeoutMs: 4000,
      maxBlocksPerTask: 1,
      provider: "auto",
      plainMode: "shadow",
      plainThreshold: 0.25,
    });
  });

  test("an invalid config falls back to defaults", () => {
    expect(mod.cfgOf({ mode: "loud" }).mode).toBe("shadow");
  });
});

describe("latestAsk", () => {
  test("takes the text after the last thread context", () => {
    expect(mod.latestAsk(TASK_TEXT)).toBe("which option did you pick?");
  });

  test("strips the thread follow-up header", () => {
    const text =
      "<thread_context>\nx\n</thread_context>\n\n[Thread follow-up — 1 message(s) buffered]\n\ntell me a long joke";
    expect(mod.latestAsk(text)).toBe("tell me a long joke");
  });

  test("falls back to the end of the context when nothing follows it", () => {
    expect(mod.latestAsk("<thread_context>\nplease explain in detail\n</thread_context>")).toBe(
      "<thread_context>\nplease explain in detail",
    );
  });
});

describe("pass", () => {
  test("scores at or above threshold pass and are recorded", async () => {
    jevScores(0.9);
    const { ctx, kv, counters, queries } = makeCtx({ mode: "enforce" });
    const result = await handler(completion("Picked B: it keeps the migration reversible."), ctx);
    expect(result).toBeUndefined();
    expect(counters).toMatchObject({ total: 1, pass: 1 });
    expect(counters.fail).toBeUndefined();
    expect(kv.last).toMatchObject({ taskId: TASK_ID, failed: [], provider: "typesafe" });
    // The task id is bound, never interpolated into the SQL.
    expect(queries[0].params).toEqual([TASK_ID]);
    expect(queries[0].sql).not.toContain(TASK_ID);
    const call = jevCalls[0]!;
    expect(call.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(call.auth).toBe("Bearer tsk-test");
    expect(Object.keys(call.body.questions).sort()).toEqual([
      "language",
      "plain",
      "tone",
      "verbosity",
    ]);
    expect(call.body.state.plain_language_rules).toEqual(mod.PLAIN_RULES);
    expect(call.body.state.latest_request).toBe("which option did you pick?");
  });

  test("with plain off: non-Slack tasks, requesters without prefs, non-completions and other agents' tasks skip Jev", async () => {
    jevScores(0.1);
    const cases: Array<[any, Row]> = [
      [completion("x"), taskRow({ source: "mcp", slackThreadTs: null })],
      [completion("x"), taskRow({ comms: null })],
      [completion("x"), taskRow({ comms: JSON.stringify({ timezone: "Europe/Madrid" }) })],
      [
        { ...completion("x"), args: { taskId: TASK_ID, status: "in_progress", progress: "hi" } },
        taskRow(),
      ],
      [{ ...completion("x"), tool: "send-task" }, taskRow()],
      [{ ...completion("x"), requestInfo: { callOrigin: "extension" } }, taskRow()],
      // Another agent's task, or a caller with no agent id.
      [completion("x"), taskRow({ agentId: "agent-2" })],
      [{ ...completion("x"), requestInfo: { callOrigin: "mcp" } }, taskRow()],
      [completion("x", { taskId: "not-a-uuid" }), taskRow()],
    ];
    for (const [event, row] of cases) {
      const { ctx } = makeCtx({ mode: "enforce", plainMode: "off" }, { row });
      expect(await handler(event, ctx)).toBeUndefined();
    }
    expect(jevCalls).toHaveLength(0);
  });

  test("a non-lead worker completing another agent's task causes zero judge egress", async () => {
    jevScores(0.1);
    for (const callerIsLead of [false, null]) {
      const { ctx, queries } = makeCtx(
        { mode: "enforce" },
        { row: taskRow({ agentId: "agent-2" }), callerIsLead },
      );
      expect(await handler(completion("x"), ctx)).toBeUndefined();
      // Lead status is read for the caller from the agents row.
      expect(queries[1]).toMatchObject({ params: ["agent-1"] });
    }
    expect(jevCalls).toHaveLength(0);
  });

  test("a lead completing a worker-owned task reaches the judge", async () => {
    jevScores(0.1);
    const { ctx, counters } = makeCtx(
      { mode: "enforce" },
      { row: taskRow({ agentId: "agent-2" }), callerIsLead: true },
    );
    expect(await handler(completion("x"), ctx)).toMatchObject({ action: "block" });
    expect(jevCalls).toHaveLength(1);
    expect(counters).toMatchObject({ total: 1, fail: 1, blocked: 1 });
  });

  test("a completion on an unassigned task reaches the judge", async () => {
    jevScores(0.1);
    const { ctx, counters, queries } = makeCtx(
      { mode: "enforce" },
      { row: taskRow({ agentId: null }) },
    );
    expect(await handler(completion("x"), ctx)).toMatchObject({ action: "block" });
    expect(jevCalls).toHaveLength(1);
    expect(counters).toMatchObject({ total: 1, fail: 1, blocked: 1 });
    // Owner and unassigned cases never need the caller's agents row.
    expect(queries).toHaveLength(1);
  });

  test("mode off and plainMode off never read the task", async () => {
    jevScores(0.1);
    const { ctx, queries } = makeCtx({ mode: "off", plainMode: "off" });
    expect(await handler(completion("x"), ctx)).toBeUndefined();
    expect(queries).toHaveLength(0);
  });
});

describe("block", () => {
  test("enforce blocks a failing output once per task, then lets it through", async () => {
    jevScores({ verbosity: 0.2, tone: 0.9, language: 0.95 });
    const { ctx, kv, counters } = makeCtx({ mode: "enforce" });
    const first = await handler(completion("Great question! Let me walk you through..."), ctx);
    expect(first).toMatchObject({ action: "block" });
    expect(first.reason).toContain("Alice's stated preferences");
    expect(first.reason).toContain("verbosity (0.20 vs 0.5)");
    expect(first.reason).toContain("very terse");
    expect(counters).toMatchObject({ total: 1, fail: 1, blocked: 1, "dim:verbosity": 1 });
    expect(counters[`blocks:${TASK_ID}`]).toBe(1);
    expect(Object.values(kv).some((v: any) => v?.action === "blocked")).toBe(true);

    const second = await handler(completion("Still long."), ctx);
    expect(second).toBeUndefined();
    expect(counters).toMatchObject({ total: 2, fail: 2, blocked: 1, escaped: 1 });
  });

  test("enforce with the default threshold passes a 0.6 score", async () => {
    jevScores({ verbosity: 0.6, tone: 0.9, language: 0.95 });
    const { ctx, counters } = makeCtx({ mode: "enforce" });
    expect(await handler(completion("Picked B."), ctx)).toBeUndefined();
    expect(counters).toMatchObject({ total: 1, pass: 1 });
    expect(counters.blocked).toBeUndefined();
  });

  test("enforce with threshold 0.75 blocks a 0.6 score", async () => {
    jevScores({ verbosity: 0.6, tone: 0.9, language: 0.95 });
    const { ctx, counters } = makeCtx({ mode: "enforce", threshold: 0.75 });
    const result = await handler(completion("Picked B."), ctx);
    expect(result).toMatchObject({ action: "block" });
    expect(result.reason).toContain("verbosity (0.60 vs 0.75)");
    expect(counters).toMatchObject({ total: 1, fail: 1, blocked: 1 });
  });

  test("shadow records the failure and never blocks", async () => {
    jevScores(0.1);
    const { ctx, counters } = makeCtx();
    expect(await handler(completion("x"), ctx)).toBeUndefined();
    expect(counters).toMatchObject({ fail: 1, shadowed: 1 });
    expect(counters.blocked).toBeUndefined();
  });

  test("openrouter carries the same request with its own model", async () => {
    jevScores(0.1);
    const { ctx } = makeCtx({ mode: "enforce" }, { key: "", openrouterKey: "or-test" });
    const result = await handler(completion("x"), ctx);
    expect(result).toMatchObject({ action: "block" });
    expect(jevCalls[0]!.url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(jevCalls[0]!.auth).toBe("Bearer or-test");
    expect(jevCalls[0]!.body.model).toBe("typesafe/jev-1.13");
  });
});

describe("fail open", () => {
  const expectFailOpen = async (ctxBundle: ReturnType<typeof makeCtx>, pattern: RegExp) => {
    const result = await handler(completion("x"), ctxBundle.ctx);
    expect(result).toBeUndefined();
    expect(ctxBundle.counters.error).toBe(1);
    expect(String((ctxBundle.kv["error:last"] as any)?.error)).toMatch(pattern);
    expect(ctxBundle.counters.blocked).toBeUndefined();
  };

  test("no key", async () => {
    jevScores(0.1);
    await expectFailOpen(
      makeCtx({ mode: "enforce" }, { key: "" }),
      /no TYPESAFE_API_KEY or OPENROUTER_API_KEY/,
    );
    expect(jevCalls).toHaveLength(0);
  });

  test("a redacted key counts as missing", async () => {
    jevScores(0.1);
    await expectFailOpen(
      makeCtx({ mode: "enforce", provider: "typesafe" }, { key: "[REDACTED:TYPESAFE_API_KEY]" }),
      /no TYPESAFE_API_KEY/,
    );
  });

  test("HTTP error", async () => {
    mockJev(() => new Response("nope", { status: 503 }));
    await expectFailOpen(makeCtx({ mode: "enforce" }), /typesafe 503/);
  });

  test("network error", async () => {
    mockJev(() => {
      throw new Error("ECONNRESET");
    });
    await expectFailOpen(makeCtx({ mode: "enforce" }), /ECONNRESET/);
  });

  test("malformed answer", async () => {
    mockJev(() => Response.json({ answers: { verbosity: { noul: "high" } } }));
    await expectFailOpen(makeCtx({ mode: "enforce" }), /no scores in response/);
  });

  test("timeout", async () => {
    // Honors the abort signal like real fetch; never answers on its own.
    globalThis.fetch = ((_url: any, init: any) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted by signal")));
      })) as typeof fetch;
    await expectFailOpen(makeCtx({ mode: "enforce", timeoutMs: 10 }), /aborted by signal/);
  });

  test("DB read failure", async () => {
    jevScores(0.1);
    await expectFailOpen(makeCtx({ mode: "enforce" }, { dbThrows: true }), /db down/);
    expect(jevCalls).toHaveLength(0);
  });
});

describe("self-test", () => {
  test("records both controls without judging real traffic", async () => {
    mockJev((body) => {
      const msg = String(body.state.agent_message);
      const bad = msg.startsWith("Great") || msg.startsWith("Prompt cache monitor");
      const [dim] = Object.keys(body.questions);
      return Response.json({ answers: { [dim!]: { noul: bad ? 0.1 : 0.9 } } });
    });
    const { ctx, kv, queries, counters } = makeCtx();
    const event = {
      tool: "store-progress",
      args: { taskId: TASK_ID, status: "in_progress", progress: "comms-gate-selftest now" },
      requestInfo: { callOrigin: "mcp" },
    };
    expect(await handler(event, ctx)).toBeUndefined();
    expect(kv["selftest:last"]).toMatchObject({
      positiveControlBadScore: 0.1,
      negativeControlGoodScore: 0.9,
      controlsOk: true,
      plainPositiveControlBadScore: 0.1,
      plainNegativeControlGoodScore: 0.9,
      plainControlsOk: true,
      provider: "typesafe",
    });
    // Two verbosity calls and two plain calls, each asking one question.
    expect(jevCalls.map((c) => Object.keys(c.body.questions)[0]).sort()).toEqual([
      "plain",
      "plain",
      "verbosity",
      "verbosity",
    ]);
    expect(queries).toHaveLength(0);
    expect(counters.total).toBeUndefined();
  });
});

describe("plain", () => {
  const slackReply = (message: string, extra: Record<string, unknown> = {}) => ({
    tool: "slack-reply",
    args: { taskId: TASK_ID, message, ...extra },
    requestInfo: { callOrigin: "mcp", agentId: "agent-1" },
  });

  test("a requester without prefs still gets the plain question", async () => {
    jevScores(0.9);
    const { ctx, counters } = makeCtx({}, { row: taskRow({ comms: null }) });
    expect(await handler(completion("Picked B."), ctx)).toBeUndefined();
    expect(Object.keys(jevCalls[0]!.body.questions)).toEqual(["plain"]);
    expect(counters).toMatchObject({ total: 1, pass: 1 });
  });

  test("mode off with plainMode shadow asks only plain", async () => {
    jevScores(0.9);
    const { ctx } = makeCtx({ mode: "off" });
    await handler(completion("Picked B."), ctx);
    expect(Object.keys(jevCalls[0]!.body.questions)).toEqual(["plain"]);
  });

  test("plain uses plainThreshold, not threshold", async () => {
    jevScores({ plain: 0.3 });
    const passing = makeCtx({ mode: "enforce", plainMode: "enforce", threshold: 0.75 });
    expect(await handler(completion("Picked B."), passing.ctx)).toBeUndefined();
    expect(passing.counters).toMatchObject({ pass: 1 });

    jevScores({ plain: 0.2 });
    const failing = makeCtx({ mode: "enforce", plainMode: "enforce", threshold: 0.75 });
    const result = await handler(completion("p50 Δ +120ms (n=37)"), failing.ctx);
    expect(result).toMatchObject({ action: "block" });
    expect(result.reason).toContain("plain (0.20 vs 0.25)");
  });

  test("plainMode shadow records a plain failure and never blocks, even with mode enforce", async () => {
    jevScores({ plain: 0.05 });
    const { ctx, counters, kv } = makeCtx({ mode: "enforce" });
    expect(await handler(completion("p50 Δ +120ms (n=37)"), ctx)).toBeUndefined();
    expect(counters).toMatchObject({ fail: 1, shadowed: 1, "dim:plain": 1 });
    expect(counters.blocked).toBeUndefined();
    expect(kv.last).toMatchObject({ failed: ["plain"], plainMode: "shadow" });
  });

  test("plainMode enforce blocks and points the agent at the comms skill", async () => {
    jevScores({ plain: 0.05 });
    const { ctx, counters } = makeCtx({ mode: "shadow", plainMode: "enforce" });
    const result = await handler(completion("p50 Δ +120ms (n=37)"), ctx);
    expect(result).toMatchObject({ action: "block" });
    expect(result.reason).toContain("plain (0.05 vs 0.25)");
    expect(result.reason).toContain("`comms` skill (Simpler mode)");
    expect(result.reason).toContain("Keep every number, name, link and hedge verbatim");
    expect(result.reason).toContain("call store-progress again");
    expect(counters).toMatchObject({ blocked: 1, "dim:plain": 1 });
  });

  test("a failing preference in shadow is left out of a plain block", async () => {
    jevScores({ plain: 0.05, verbosity: 0.1 });
    const { ctx } = makeCtx({ mode: "shadow", plainMode: "enforce" });
    const result = await handler(completion("x"), ctx);
    expect(result.reason).toContain("plain (");
    expect(result.reason).not.toContain("verbosity (");
  });

  test("structured JSON output skips the plain question", async () => {
    jevScores(0.9);
    const { ctx } = makeCtx({ mode: "enforce", plainMode: "enforce" });
    await handler(completion('{"prUrl":"https://example.com/pull/1","n":3}'), ctx);
    expect(Object.keys(jevCalls[0]!.body.questions)).not.toContain("plain");
    expect(mod.looksLikeJson("{not json")).toBe(false);
  });

  test("a JSON message on any Slack tool is still judged plain, even with mode off", async () => {
    const json = '{"p50":"+120ms","n":37}';
    for (const tool of ["slack-reply", "slack-post", "slack-start-thread", "slack-update"]) {
      jevCalls = [];
      jevScores({ plain: 0.05 });
      const { ctx } = makeCtx({ mode: "off", plainMode: "enforce" });
      const result = await handler(
        {
          tool,
          args: { taskId: TASK_ID, channelId: "C1", message: json },
          requestInfo: { callOrigin: "mcp", agentId: "agent-1", sourceTaskId: TASK_ID },
        },
        ctx,
      );
      expect(jevCalls).toHaveLength(1);
      expect(Object.keys(jevCalls[0]!.body.questions)).toEqual(["plain"]);
      expect(result).toMatchObject({ action: "block" });
    }
  });

  test("slack-reply is judged on its message with the named task", async () => {
    jevScores({ plain: 0.05 });
    const { ctx, queries } = makeCtx({ plainMode: "enforce" });
    const result = await handler(slackReply("p50 Δ +120ms (n=37)"), ctx);
    expect(result).toMatchObject({ action: "block" });
    expect(result.reason).toContain("call slack-reply again");
    expect(queries[0].params).toEqual([TASK_ID]);
    expect(jevCalls[0]!.body.state.agent_message).toBe("p50 Δ +120ms (n=37)");
  });

  test("slack-post, slack-start-thread and slack-update use the caller's task context", async () => {
    for (const tool of ["slack-post", "slack-start-thread", "slack-update"]) {
      jevCalls = [];
      jevScores(0.9);
      const { ctx, queries } = makeCtx();
      await handler(
        {
          tool,
          args: { channelId: "C1", message: "Deploys take 4 minutes now." },
          requestInfo: { callOrigin: "mcp", agentId: "agent-1", sourceTaskId: TASK_ID },
        },
        ctx,
      );
      expect(queries[0].params).toEqual([TASK_ID]);
      expect(jevCalls).toHaveLength(1);
    }
  });

  test("a Slack post from a non-Slack task is still judged", async () => {
    jevScores(0.9);
    const { ctx } = makeCtx({}, { row: taskRow({ source: "mcp", slackThreadTs: null }) });
    await handler(slackReply("Deploys take 4 minutes now."), ctx);
    expect(jevCalls).toHaveLength(1);
  });

  test("a Slack post without a task, or on another agent's task, skips Jev", async () => {
    jevScores(0.05);
    const noTask = makeCtx({ plainMode: "enforce" });
    expect(
      await handler(
        {
          tool: "slack-post",
          args: { channelId: "C1", message: "x" },
          requestInfo: { callOrigin: "mcp", agentId: "agent-1" },
        },
        noTask.ctx,
      ),
    ).toBeUndefined();
    const other = makeCtx({ plainMode: "enforce" }, { row: taskRow({ agentId: "agent-2" }) });
    expect(await handler(slackReply("x"), other.ctx)).toBeUndefined();
    expect(jevCalls).toHaveLength(0);
  });

  test("a Slack post on an unassigned task the caller did not create skips Jev", async () => {
    // slack-reply itself rejects this task, so nothing from it may reach the judge,
    // even though store-progress may write to an unassigned task.
    jevScores(0.05);
    const unassigned = makeCtx({ plainMode: "enforce" }, { row: taskRow({ agentId: null }) });
    expect(await handler(slackReply("x"), unassigned.ctx)).toBeUndefined();
    const lead = makeCtx(
      { plainMode: "enforce" },
      { row: taskRow({ agentId: "agent-2" }), callerIsLead: true },
    );
    expect(await handler(slackReply("x"), lead.ctx)).toBeUndefined();
    expect(jevCalls).toHaveLength(0);
  });

  test("the task's creator may post and is judged", async () => {
    jevScores(0.9);
    const { ctx } = makeCtx(
      {},
      { row: taskRow({ agentId: "agent-2", creatorAgentId: "agent-1" }) },
    );
    await handler(slackReply("Deploys take 4 minutes now."), ctx);
    expect(jevCalls).toHaveLength(1);
  });

  test("store-progress and slack-reply share one block budget per task", async () => {
    jevScores({ plain: 0.05 });
    const { ctx, counters } = makeCtx({ plainMode: "enforce" });
    expect(await handler(slackReply("p50 Δ"), ctx)).toMatchObject({ action: "block" });
    expect(await handler(completion("p50 Δ"), ctx)).toBeUndefined();
    expect(counters).toMatchObject({ blocked: 1, escaped: 1 });
  });

  test("a script SDK call is recorded and never blocked", async () => {
    jevScores({ plain: 0.05 });
    const { ctx, counters } = makeCtx({ mode: "enforce", plainMode: "enforce" });
    const event = {
      ...slackReply("p50 Δ"),
      requestInfo: { callOrigin: "script-sdk", agentId: "agent-1" },
    };
    expect(await handler(event, ctx)).toBeUndefined();
    expect(counters).toMatchObject({ fail: 1, shadowed: 1 });
    expect(counters.blocked).toBeUndefined();
  });
});

describe("multi-person threads", () => {
  const BOB_PREFS = { language: "Spanish", tone: "warm" };
  const bob = { externalId: "UBOB", id: "user-2", name: "Bob", comms: JSON.stringify(BOB_PREFS) };
  const post = (message: string) => ({
    tool: "slack-reply",
    args: { taskId: TASK_ID, message },
    requestInfo: { callOrigin: "mcp", agentId: "agent-1" },
  });

  test("mentionedSlackIds keeps first-appearance order and drops duplicates", () => {
    expect(mod.mentionedSlackIds("<@UBOB|bob> and <@U1> then <@UBOB>")).toEqual(["UBOB", "U1"]);
    expect(mod.mentionedSlackIds("no mentions, @bob")).toEqual([]);
  });

  test("a message that mentions another person is judged against that person's prefs", async () => {
    jevScores({ language: 0.1 });
    const { ctx, kv } = makeCtx({ mode: "enforce" }, { addressees: [bob] });
    const result = await handler(post("<@UBOB> hola, el deploy tarda 4 minutos."), ctx);
    const state = jevCalls[0]!.body.state;
    expect(state.requester).toBe("Bob");
    expect(state.requester_preferences).toEqual(BOB_PREFS);
    expect(Object.keys(jevCalls[0]!.body.questions).sort()).toEqual(["language", "plain", "tone"]);
    expect(result).toMatchObject({ action: "block" });
    expect(result.reason).toContain("Bob's stated preferences");
    expect(kv.last).toMatchObject({
      judgedFor: "mention",
      audienceId: "user-2",
      requester: "Alice",
    });
  });

  test("the first mentioned person with prefs wins; one without prefs is skipped", async () => {
    jevScores(0.9);
    const carol = { externalId: "UCAROL", id: "user-3", name: "Carol", comms: null };
    const { ctx } = makeCtx({}, { addressees: [carol, bob] });
    await handler(post("<@UCAROL> <@UBOB> deploys take 4 minutes."), ctx);
    expect(jevCalls[0]!.body.state.requester).toBe("Bob");
  });

  test("no mention, or an unknown one, falls back to the requester", async () => {
    for (const message of ["Deploys take 4 minutes.", "<@UNOBODY> deploys take 4 minutes."]) {
      jevCalls = [];
      jevScores(0.9);
      const { ctx, kv } = makeCtx({}, { addressees: [bob] });
      await handler(post(message), ctx);
      expect(jevCalls[0]!.body.state.requester_preferences).toEqual(PREFS);
      expect(kv.last).toMatchObject({ judgedFor: "requester", audience: "Alice" });
    }
  });

  test("mentioning the requester keeps the requester's prefs", async () => {
    jevScores(0.9);
    const alice = {
      externalId: "U1",
      id: "user-1",
      name: "Alice",
      comms: JSON.stringify(BOB_PREFS),
    };
    const { ctx } = makeCtx({}, { addressees: [alice] });
    await handler(post("<@U1> deploys take 4 minutes."), ctx);
    expect(jevCalls[0]!.body.state.requester_preferences).toEqual(PREFS);
  });

  test.each([
    null,
    "{}",
  ])("a self-mention without requester prefs (%s) skips to the next mentioned person with prefs", async (comms) => {
    jevScores(0.9);
    const alice = { externalId: "U1", id: "user-1", name: "Alice", comms };
    const { ctx, kv } = makeCtx(
      { mode: "enforce", plainMode: "off" },
      { row: taskRow({ comms }), addressees: [alice, bob] },
    );
    await handler(post("<@U1> <@UBOB> deploys take 4 minutes."), ctx);
    expect(jevCalls).toHaveLength(1);
    expect(jevCalls[0]!.body.state.requester).toBe("Bob");
    expect(jevCalls[0]!.body.state.requester_preferences).toEqual(BOB_PREFS);
    expect(kv.last).toMatchObject({ judgedFor: "mention", audienceId: "user-2" });
  });

  test("a completion that mentions someone is judged for them too", async () => {
    jevScores(0.9);
    const { ctx } = makeCtx({}, { addressees: [bob] });
    await handler(completion("<@UBOB> done, PR #12."), ctx);
    expect(jevCalls[0]!.body.state.requester).toBe("Bob");
  });

  test("with mode off, plain alone skips the mention lookup", async () => {
    jevScores(0.9);
    const { ctx, queries } = makeCtx({ mode: "off" }, { addressees: [bob] });
    await handler(post("<@UBOB> deploys take 4 minutes."), ctx);
    expect(queries.some((q) => String(q.sql).includes("user_external_ids"))).toBe(false);
    expect(jevCalls).toHaveLength(1);
  });
});
