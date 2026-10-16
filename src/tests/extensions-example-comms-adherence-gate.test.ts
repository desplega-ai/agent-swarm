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
    expect(Object.keys(call.body.questions).sort()).toEqual(["language", "tone", "verbosity"]);
    expect(call.body.state.latest_request).toBe("which option did you pick?");
  });

  test("non-Slack tasks, requesters without prefs, non-completions and other agents' tasks skip Jev", async () => {
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
      const { ctx } = makeCtx({ mode: "enforce" }, { row });
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

  test("mode off never reads the task", async () => {
    jevScores(0.1);
    const { ctx, queries } = makeCtx({ mode: "off" });
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
    mockJev((body) =>
      Response.json({
        answers: {
          verbosity: { noul: String(body.state.agent_message).startsWith("Great") ? 0.1 : 0.9 },
        },
      }),
    );
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
      provider: "typesafe",
    });
    expect(queries).toHaveLength(0);
    expect(counters.total).toBeUndefined();
  });
});
