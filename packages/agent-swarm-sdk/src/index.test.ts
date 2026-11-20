import { describe, expect, test } from "bun:test";
import { createSwarm, SwarmError } from "./index.js";

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

/** A fetch that records each request and answers from `replies` in order. */
function mockFetch(
  replies: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>,
) {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const reply = replies.shift();
    if (!reply) throw new Error("unexpected request");
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: reply.headers,
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const task = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "t1",
  task: "hi",
  status,
  ...extra,
});

const swarmWith = (replies: Parameters<typeof mockFetch>[0], agentId?: string) => {
  const mock = mockFetch(replies);
  const swarm = createSwarm({
    apiKey: "k",
    baseUrl: "http://swarm.test/",
    fetch: mock.fetch,
    agentId,
  });
  return { swarm, calls: mock.calls };
};

describe("createSwarm", () => {
  test("throws missing_api_key with a hint when no key is configured", () => {
    const saved = { a: process.env.AGENT_SWARM_API_KEY, b: process.env.API_KEY };
    delete process.env.AGENT_SWARM_API_KEY;
    delete process.env.API_KEY;
    try {
      expect(() => createSwarm()).toThrow(SwarmError);
      try {
        createSwarm();
      } catch (error) {
        expect((error as SwarmError).code).toBe("missing_api_key");
        expect((error as SwarmError).hint).toContain("AGENT_SWARM_API_KEY");
      }
    } finally {
      if (saved.a !== undefined) process.env.AGENT_SWARM_API_KEY = saved.a;
      if (saved.b !== undefined) process.env.API_KEY = saved.b;
    }
  });

  test("reads the key and URL from the environment", async () => {
    const saved = { k: process.env.AGENT_SWARM_API_KEY, u: process.env.AGENT_SWARM_URL };
    process.env.AGENT_SWARM_API_KEY = "env-key";
    process.env.AGENT_SWARM_URL = "http://env.test";
    try {
      const mock = mockFetch([{ body: { agents: [] } }]);
      await createSwarm({ fetch: mock.fetch }).agents.list();
      expect(mock.calls[0]?.url).toBe("http://env.test/api/agents");
      expect(mock.calls[0]?.headers.authorization).toBe("Bearer env-key");
    } finally {
      process.env.AGENT_SWARM_API_KEY = saved.k;
      process.env.AGENT_SWARM_URL = saved.u;
      if (saved.k === undefined) delete process.env.AGENT_SWARM_API_KEY;
      if (saved.u === undefined) delete process.env.AGENT_SWARM_URL;
    }
  });
});

describe("tasks", () => {
  test("send posts a string as the task text with bearer auth and idempotency key", async () => {
    const { swarm, calls } = swarmWith([{ status: 201, body: task("pending") }]);
    const sent = await swarm.tasks.send("hi", { idempotencyKey: "abc" });
    expect(sent.id).toBe("t1");
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "http://swarm.test/api/tasks",
      body: { task: "hi" },
      headers: { authorization: "Bearer k", "idempotency-key": "abc" },
    });
  });

  test("get encodes the id and passes logsLimit", async () => {
    const { swarm, calls } = swarmWith([{ body: task("in_progress") }]);
    await swarm.tasks.get("a/b", { logsLimit: 5 });
    expect(calls[0]?.url).toBe("http://swarm.test/api/tasks/a%2Fb?logsLimit=5");
  });

  test("wait polls until a terminal status and retries transient 5xx", async () => {
    const { swarm, calls } = swarmWith([
      { body: task("pending") },
      { status: 502, body: { error: "bad gateway" } },
      { body: task("completed", { output: "done" }) },
    ]);
    const done = await swarm.tasks.wait("t1", { intervalMs: 1 });
    expect(done.output).toBe("done");
    expect(calls).toHaveLength(3);
  });

  test("wait throws timeout with the last task seen", async () => {
    const { swarm } = swarmWith([{ body: task("in_progress") }, { body: task("in_progress") }]);
    const error = await swarm.tasks.wait("t1", { timeoutMs: 5, intervalMs: 10 }).catch((e) => e);
    expect(error).toBeInstanceOf(SwarmError);
    expect(error.code).toBe("timeout");
    expect(error.task.status).toBe("in_progress");
  });

  test("wait stops on abort", async () => {
    const { swarm } = swarmWith([{ body: task("pending") }]);
    const controller = new AbortController();
    const pending = swarm.tasks.wait("t1", { intervalMs: 1000, signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    const error = await pending.catch((e) => e);
    expect(error.code).toBe("aborted");
  });

  test("run sends and waits, resolving with the completed task", async () => {
    const { swarm, calls } = swarmWith([
      { status: 201, body: task("pending") },
      { body: task("completed", { output: "42" }) },
    ]);
    const done = await swarm.tasks.run({ task: "hi", agentId: "a1" });
    expect(done.output).toBe("42");
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET"]);
    expect(calls[0]?.body).toEqual({ task: "hi", agentId: "a1" });
  });

  test("run throws task_failed with the task when it does not complete", async () => {
    const { swarm } = swarmWith([
      { status: 201, body: task("pending") },
      { body: task("failed", { failureReason: "boom" }) },
    ]);
    const error = await swarm.tasks.run("hi").catch((e) => e);
    expect(error.code).toBe("task_failed");
    expect(error.message).toContain("boom");
    expect(error.task.status).toBe("failed");
  });
});

/** Settle `promise` or report that it is still pending after `ms`. */
const within = (promise: Promise<unknown>, ms = 1000) =>
  Promise.race([
    promise.then(
      (value) => ({ resolved: value }),
      (error) => ({ rejected: error }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ pending: true }), ms)),
  ]) as Promise<{ resolved?: unknown; rejected?: SwarmError; pending?: true }>;

/** A fetch that never answers and ignores its signal, like a stalled proxy. */
const stalledFetch = (requests: string[] = []) =>
  (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(init?.method ?? "GET");
    return new Promise<Response>(() => {});
  }) as unknown as typeof fetch;

/** A 200 whose body stream errors with `error` (immediately, or when `signal` aborts). */
const brokenBodyFetch = (error: () => unknown, signal?: AbortSignal) =>
  (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          if (signal) signal.addEventListener("abort", () => controller.error(error()));
          else controller.error(error());
        },
      }),
    )) as unknown as typeof fetch;

describe("wait and run stop on time", () => {
  test("the timeout bounds a request that never answers", async () => {
    const swarm = createSwarm({ apiKey: "k", fetch: stalledFetch() });
    const out = await within(swarm.tasks.wait("t1", { timeoutMs: 10 }));
    expect(out.rejected?.code).toBe("timeout");
  });

  test("a terminal response that lands after the deadline is a timeout", async () => {
    const swarm = createSwarm({
      apiKey: "k",
      fetch: (async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return Response.json(task("completed"));
      }) as unknown as typeof fetch,
    });
    const out = await within(swarm.tasks.wait("t1", { timeoutMs: 10 }));
    expect(out.rejected?.code).toBe("timeout");
  });

  test("the caller's abort during a stalled request stays aborted, not timeout", async () => {
    const swarm = createSwarm({ apiKey: "k", fetch: stalledFetch() });
    const controller = new AbortController();
    const pending = within(swarm.tasks.wait("t1", { signal: controller.signal }));
    setTimeout(() => controller.abort(), 5);
    expect((await pending).rejected?.code).toBe("aborted");
  });

  test("wait removes its listener from the caller's signal on every exit", async () => {
    const controller = new AbortController();
    const live = new Set<unknown>();
    const { signal } = controller;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((type: string, fn: EventListener, o?: AddEventListenerOptions) => {
      live.add(fn);
      add(type, fn, o);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((type: string, fn: EventListener) => {
      live.delete(fn);
      remove(type, fn);
    }) as typeof signal.removeEventListener;
    const { swarm } = swarmWith([{ body: task("completed") }]);
    await swarm.tasks.wait("t1", { signal });
    expect(live.size).toBe(0);
    const stalled = createSwarm({ apiKey: "k", fetch: stalledFetch() });
    await stalled.tasks.wait("t1", { signal, timeoutMs: 5 }).catch(() => {});
    expect(live.size).toBe(0);
  });

  test("run with an already-aborted signal never submits the task", async () => {
    const requests: string[] = [];
    const swarm = createSwarm({ apiKey: "k", fetch: stalledFetch(requests) });
    const controller = new AbortController();
    controller.abort();
    const out = await within(swarm.tasks.run("hi", { signal: controller.signal }));
    expect(out.rejected?.code).toBe("aborted");
    expect(requests).toEqual([]);
  });

  test("abort stops run while the submit is stalled", async () => {
    const requests: string[] = [];
    const swarm = createSwarm({ apiKey: "k", fetch: stalledFetch(requests) });
    const controller = new AbortController();
    const pending = within(swarm.tasks.run("hi", { signal: controller.signal }));
    setTimeout(() => controller.abort(), 5);
    expect((await pending).rejected?.code).toBe("aborted");
    expect(requests).toEqual(["POST"]);
  });
});

describe("errors", () => {
  test("a body that fails mid-read becomes network_error, and wait retries it", async () => {
    const reset = () => new TypeError("connection reset during body");
    const swarm = createSwarm({ apiKey: "k", fetch: brokenBodyFetch(reset) });
    const error = await swarm.tasks.get("t1").catch((e) => e);
    expect(error).toBeInstanceOf(SwarmError);
    expect(error.code).toBe("network_error");

    let first = true;
    const flaky = createSwarm({
      apiKey: "k",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!first) return Response.json(task("completed"));
        first = false;
        return brokenBodyFetch(reset)(input, init);
      }) as unknown as typeof fetch,
    });
    const done = await flaky.tasks.wait("t1", { intervalMs: 1 });
    expect(done.status).toBe("completed");
  });

  test("an abort mid-body becomes an aborted SwarmError", async () => {
    const controller = new AbortController();
    const swarm = createSwarm({
      apiKey: "k",
      fetch: brokenBodyFetch(() => controller.signal.reason, controller.signal),
    });
    const pending = within(swarm.tasks.wait("t1", { signal: controller.signal }));
    setTimeout(() => controller.abort(), 5);
    const out = await pending;
    expect(out.rejected).toBeInstanceOf(SwarmError);
    expect(out.rejected?.code).toBe("aborted");
  });

  test("maps status to code and keeps the server message, body and Retry-After", async () => {
    const { swarm } = swarmWith([
      { status: 429, body: { error: "slow down" }, headers: { "retry-after": "7" } },
    ]);
    const error = await swarm.tasks.get("t1").catch((e) => e);
    expect(error).toMatchObject({ code: "rate_limited", status: 429, retryAfter: 7 });
    expect(error.message).toContain("slow down");
    expect(error.body).toEqual({ error: "slow down" });
  });

  test("401 carries a hint", async () => {
    const { swarm } = swarmWith([{ status: 401, body: { error: "Unauthorized" } }]);
    const error = await swarm.agents.list().catch((e) => e);
    expect(error.code).toBe("unauthorized");
    expect(error.hint).toContain("API key");
  });

  test("a fetch that throws becomes network_error", async () => {
    const swarm = createSwarm({
      apiKey: "k",
      fetch: (async () => {
        throw new TypeError("connection refused");
      }) as unknown as typeof fetch,
    });
    const error = await swarm.agents.list().catch((e) => e);
    expect(error.code).toBe("network_error");
    expect(error.message).toContain("connection refused");
  });
});

describe("agents, memory, scripts", () => {
  test("agents.list unwraps the page and builds the query", async () => {
    const { swarm, calls } = swarmWith([{ body: { agents: [{ id: "a1", name: "Lead" }] } }]);
    const agents = await swarm.agents.list({ q: "lead", limit: 5 });
    expect(agents[0]?.name).toBe("Lead");
    expect(calls[0]?.url).toBe("http://swarm.test/api/agents?q=lead&limit=5");
  });

  test("memory.search posts the query and returns results", async () => {
    const { swarm, calls } = swarmWith([{ body: { results: [{ id: "m1", name: "n" }] } }]);
    const results = await swarm.memory.search("deploys", { limit: 3 });
    expect(results[0]?.id).toBe("m1");
    expect(calls[0]?.body).toEqual({ limit: 3, query: "deploys" });
  });

  test("scripts.run sends X-Agent-ID and returns the run", async () => {
    const run = { result: { n: 1 }, stdout: "", stderr: "", exitCode: 0, durationMs: 3 };
    const { swarm, calls } = swarmWith([{ body: run }], "agent-1");
    const out = await swarm.scripts.run("count", { x: 1 }, { scope: "global" });
    expect(out.result).toEqual({ n: 1 });
    expect(calls[0]?.headers["x-agent-id"]).toBe("agent-1");
    expect(calls[0]?.body).toEqual({ scope: "global", name: "count", args: { x: 1 } });
  });

  test("scripts.run throws script_failed with the run on a runtime error", async () => {
    const run = {
      stdout: "",
      stderr: "x",
      exitCode: 1,
      durationMs: 3,
      runtimeError: { name: "Error", message: "nope", stack: "", userFrames: [] },
    };
    const { swarm } = swarmWith([{ body: run }], "agent-1");
    const error = await swarm.scripts.run("count").catch((e) => e);
    expect(error.code).toBe("script_failed");
    expect(error.message).toContain("nope");
    expect(error.run.exitCode).toBe(1);
  });
});
