import { describe, expect, test } from "bun:test";
import { runScheduled, type ScheduledRunDeps, TIERS } from "./run-scheduled.ts";

const API = "https://evals.example.test";
const HOOK = "https://hooks.example.test/services/T/B/X";

interface Call {
  url: string;
  method: string;
  body: unknown;
}
type Reply = Response | Error;

/** Fake fetch: routes by method + URL suffix, replies from per-route queues (the last one repeats). */
function fakeWorld(routes: Record<string, Reply[]>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    // "POST /api/runs" matches one method; a bare "/regression" or URL matches any.
    const key = Object.keys(routes).find((k) => {
      const [m, ...rest] = k.split(" ");
      return rest.length > 0 ? m === method && u.endsWith(rest.join(" ")) : u.endsWith(k);
    });
    if (!key) throw new Error(`unrouted ${method} ${u}`);
    const queue = routes[key]!;
    const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (reply instanceof Error) throw reply;
    return reply.clone();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const report = (over: Record<string, unknown> = {}) =>
  json({
    runId: "run-1",
    status: "done",
    final: true,
    summaryPostedAt: "2026-10-01T04:00:00Z",
    text: ":white_check_mark: *Nightly canary: clean*",
    ...over,
  });

function harness(
  routes: Record<string, Reply[]>,
  over: Partial<ScheduledRunDeps> = {},
): {
  deps: ScheduledRunDeps;
  calls: Call[];
  summary: string[];
  logs: string[];
  clock: { t: number };
} {
  const world = fakeWorld(routes);
  const clock = { t: Date.parse("2026-10-01T03:00:00Z") };
  const summary: string[] = [];
  const logs: string[] = [];
  return {
    calls: world.calls,
    summary,
    logs,
    clock,
    deps: {
      tier: "canary",
      env: { EVALS_API_KEY: "test-key", EVALS_API_URL: `${API}/`, ...over.env },
      fetchImpl: world.fetchImpl,
      sleep: async (ms) => {
        clock.t += ms;
      },
      now: () => clock.t,
      log: (m) => logs.push(m),
      appendSummary: (md) => summary.push(md),
      ...over,
    },
  };
}

describe("runScheduled", () => {
  test("starts the preset with its tier's concurrency, waits, and finishes when the service posted", async () => {
    const h = harness({
      "POST /api/runs": [json({ runId: "run-1" }, 201)],
      "/api/runs/run-1/regression": [
        json({
          runId: "run-1",
          status: "running",
          final: false,
          summaryPostedAt: null,
          text: null,
        }),
        report(),
      ],
    });
    const result = await runScheduled(h.deps);
    expect(result).toEqual({ exitCode: 0, runId: "run-1", outcome: "done", slack: "service" });
    expect(h.calls[0]).toEqual({
      url: `${API}/api/runs`,
      method: "POST",
      body: { preset: "nightly-canary", name: "Nightly canary 2026-10-01", concurrency: 3 },
    });
    expect(h.calls.filter((c) => c.url.endsWith("/regression"))).toHaveLength(2);
    expect(h.summary.join("")).toContain("Nightly canary: clean");
  });

  test("the weekly tier starts weekly-matrix at concurrency 6; --concurrency overrides", async () => {
    const routes = () => ({
      "POST /api/runs": [json({ runId: "run-1" }, 201)],
      "/regression": [report()],
    });
    const weekly = harness(routes(), { tier: "weekly" });
    await runScheduled(weekly.deps);
    expect(weekly.calls[0]?.body).toMatchObject({ preset: "weekly-matrix", concurrency: 6 });
    const over = harness(routes(), { tier: "weekly", concurrency: 8 });
    await runScheduled(over.deps);
    expect(over.calls[0]?.body).toMatchObject({ concurrency: 8 });
  });

  test("sends the bearer token", async () => {
    let auth = "";
    const world = fakeWorld({
      "POST /api/runs": [json({ runId: "run-1" }, 201)],
      "/regression": [report()],
    });
    const h = harness({});
    h.deps.fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/runs"))
        auth = new Headers(init?.headers).get("authorization") ?? "";
      return world.fetchImpl(url, init);
    }) as typeof fetch;
    await runScheduled(h.deps);
    expect(auth).toBe("Bearer test-key");
  });

  test("when the service never posted, waits out the grace period, then posts the summary itself once", async () => {
    const unposted = () => report({ summaryPostedAt: null, text: "SUMMARY TEXT" });
    const h = harness(
      {
        "POST /api/runs": [json({ runId: "run-1" }, 201)],
        "/regression": [unposted()],
        [HOOK]: [new Response("ok")],
      },
      { env: { EVALS_API_KEY: "k", EVALS_API_URL: API, EVALS_SLACK_WEBHOOK_URL: HOOK } },
    );
    const result = await runScheduled(h.deps);
    expect(result).toMatchObject({ exitCode: 0, outcome: "done", slack: "workflow" });
    const hooks = h.calls.filter((c) => c.url === HOOK);
    expect(hooks).toEqual([{ url: HOOK, method: "POST", body: { text: "SUMMARY TEXT" } }]);
    // it polled more than once: the first final poll is inside the grace period
    expect(h.calls.filter((c) => c.url.endsWith("/regression")).length).toBeGreaterThan(1);
  });

  test("no webhook anywhere: the run still succeeds, and the log says no summary went out", async () => {
    const h = harness({
      "POST /api/runs": [json({ runId: "run-1" }, 201)],
      "/regression": [report({ summaryPostedAt: null, text: "SUMMARY TEXT" })],
    });
    const result = await runScheduled(h.deps);
    expect(result).toEqual({ exitCode: 0, runId: "run-1", outcome: "done", slack: null });
    expect(h.logs.join("\n")).toContain("no Slack summary went out");
    expect(h.summary.join("")).toContain("SUMMARY TEXT"); // still in the job summary
  });

  test("a run that ends failed exits 1 without a second Slack message (the service posted)", async () => {
    const h = harness(
      {
        "POST /api/runs": [json({ runId: "run-1" }, 201)],
        "/regression": [report({ status: "failed" })],
        [HOOK]: [new Response("ok")],
      },
      { env: { EVALS_API_KEY: "k", EVALS_API_URL: API, EVALS_SLACK_WEBHOOK_URL: HOOK } },
    );
    const result = await runScheduled(h.deps);
    expect(result).toMatchObject({ exitCode: 1, outcome: "run-not-done", slack: "service" });
    expect(h.calls.filter((c) => c.url === HOOK)).toEqual([]);
  });

  test("a start refused with 4xx is not retried and posts one failure notice", async () => {
    const h = harness(
      {
        "POST /api/runs": [json({ error: "max concurrent eval runs reached" }, 429)],
        [HOOK]: [new Response("ok")],
      },
      { env: { EVALS_API_KEY: "k", EVALS_API_URL: API, EVALS_SLACK_WEBHOOK_URL: HOOK } },
    );
    const result = await runScheduled(h.deps);
    expect(result).toEqual({
      exitCode: 1,
      runId: null,
      outcome: "start-failed",
      slack: "failure-notice",
    });
    expect(h.calls.filter((c) => c.url.endsWith("/api/runs"))).toHaveLength(1);
    const notice = h.calls.find((c) => c.url === HOOK)?.body as { text: string };
    expect(notice.text).toContain(":x: *Nightly canary: could not start the run");
    expect(notice.text).toContain("429");
  });

  test("a 5xx or a network error on start is retried up to 3 times, then fails", async () => {
    const h = harness({
      "POST /api/runs": [
        new Response("bad gateway", { status: 502 }),
        new Error("ECONNRESET"),
        new Response("down", { status: 503 }),
      ],
    });
    const result = await runScheduled(h.deps);
    expect(result).toMatchObject({ exitCode: 1, outcome: "start-failed", slack: null });
    expect(h.calls.filter((c) => c.url.endsWith("/api/runs"))).toHaveLength(3);
  });

  test("a run that never goes final times out with a failure notice", async () => {
    const h = harness(
      {
        "POST /api/runs": [json({ runId: "run-1" }, 201)],
        "/regression": [
          json({
            runId: "run-1",
            status: "running",
            final: false,
            summaryPostedAt: null,
            text: null,
          }),
        ],
        [HOOK]: [new Response("ok")],
      },
      { env: { EVALS_API_KEY: "k", EVALS_API_URL: API, EVALS_SLACK_WEBHOOK_URL: HOOK } },
    );
    const result = await runScheduled(h.deps);
    expect(result).toEqual({
      exitCode: 1,
      runId: "run-1",
      outcome: "timed-out",
      slack: "failure-notice",
    });
    expect(h.clock.t - Date.parse("2026-10-01T03:00:00Z")).toBeGreaterThanOrEqual(
      TIERS.canary.maxWaitMs,
    );
  });

  test("ten polls in a row failing means contact is lost", async () => {
    const h = harness({
      "POST /api/runs": [json({ runId: "run-1" }, 201)],
      "/regression": [new Error("ECONNREFUSED")],
    });
    const result = await runScheduled(h.deps);
    expect(result).toMatchObject({ exitCode: 1, outcome: "lost-contact" });
    expect(h.calls.filter((c) => c.url.endsWith("/regression"))).toHaveLength(10);
  });

  test("a poll error that clears does not count against the run", async () => {
    const h = harness({
      "POST /api/runs": [json({ runId: "run-1" }, 201)],
      "/regression": [new Error("blip"), report()],
    });
    expect(await runScheduled(h.deps)).toMatchObject({ exitCode: 0, outcome: "done" });
  });

  test("requires EVALS_API_KEY", async () => {
    const h = harness({}, { env: { EVALS_API_KEY: "" } });
    await expect(runScheduled(h.deps)).rejects.toThrow("EVALS_API_KEY is not set");
  });
});
