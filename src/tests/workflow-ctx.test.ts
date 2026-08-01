import { describe, expect, test } from "bun:test";
import { buildWorkflowCtx } from "../script-workflows/workflow-ctx";

describe("workflow-ctx: ctx.swarm proxy tool name resolution", () => {
  test("non-mechanical SDK→MCP mappings are routed correctly", async () => {
    const captured: string[] = [];
    const origFetch = globalThis.fetch;

    globalThis.fetch = async (url: unknown, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/api/mcp-bridge")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        captured.push(body.tool);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return origFetch(url as URL, init);
    };

    try {
      const { ctx } = buildWorkflowCtx({
        runId: "test-run",
        agentId: "test-agent",
        apiKey: "test-key",
        baseUrl: "http://localhost:9999",
        args: {},
      });

      // Non-mechanical: SDK method name ≠ kebab-cased MCP name
      await ctx.swarm.workflow_trigger({ id: "wf-1" }); // → "trigger-workflow" (not "workflow-trigger")
      await ctx.swarm.page_create({ title: "T" }); // → "create_page"       (not "page-create")
      await ctx.swarm.memory_rate({ id: "x" }); // → "memory_rate"       (not "memory-rate")

      // Mechanical: verify mechanical mappings still work
      await ctx.swarm.memory_search({ query: "q" }); // → "memory-search"
    } finally {
      globalThis.fetch = origFetch;
    }

    expect(captured[0]).toBe("trigger-workflow");
    expect(captured[1]).toBe("create_page");
    expect(captured[2]).toBe("memory_rate");
    expect(captured[3]).toBe("memory-search");
  });
});

function installFetchMock(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) =>
    handler(String(url), init)) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

function buildCtxWithBaseline(runId: string) {
  return buildWorkflowCtx({
    runId,
    agentId: "agent-1",
    apiKey: "key",
    baseUrl: "http://localhost:9999",
    args: {},
  });
}

// Env vars the harness passes to a real subprocess (see executor.ts) so
// ctx.step.agentTask can compute the shared run-level wall-clock deadline.
// Wraps the whole async body — runWallDeadlineMs() reads process.env fresh
// on every call, so the env must stay set for the full duration, not just
// while building ctx.
async function withRunWallEnv<T>(
  startedAt: string,
  maxWallMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const savedStarted = process.env.SCRIPT_RUN_STARTED_AT;
  const savedMaxWall = process.env.SCRIPT_RUN_MAX_WALL_MS;
  process.env.SCRIPT_RUN_STARTED_AT = startedAt;
  process.env.SCRIPT_RUN_MAX_WALL_MS = String(maxWallMs);
  try {
    return await fn();
  } finally {
    if (savedStarted === undefined) delete process.env.SCRIPT_RUN_STARTED_AT;
    else process.env.SCRIPT_RUN_STARTED_AT = savedStarted;
    if (savedMaxWall === undefined) delete process.env.SCRIPT_RUN_MAX_WALL_MS;
    else process.env.SCRIPT_RUN_MAX_WALL_MS = savedMaxWall;
  }
}

function sleepReal(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("workflow-ctx: ctx.step.agentTask waits for a terminal status", () => {
  test("polls through several pending responses and journals the real terminal output, not status:pending", async () => {
    const journaled: Array<Record<string, unknown>> = [];
    let pollCount = 0;

    const restore = installFetchMock(async (url, init) => {
      if (url.includes("/steps/step-1")) {
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      if (url.endsWith("/agent-task")) {
        pollCount++;
        if (pollCount < 3) {
          return new Response(JSON.stringify({ taskId: "task-1", status: "pending" }), {
            status: 202,
          });
        }
        return new Response(JSON.stringify({ taskId: "task-1", taskOutput: { ok: true } }), {
          status: 200,
        });
      }
      if (url.endsWith("/steps")) {
        journaled.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    try {
      const result = await buildCtxWithBaseline("run-1").ctx.step.agentTask("step-1", {
        task: "do it",
      });
      expect(result).toEqual({ ok: true });
      expect(pollCount).toBe(3); // did not return early on the first 202
      expect(journaled).toHaveLength(1);
      expect(journaled[0]?.status).toBe("completed");
      expect(journaled[0]?.result).toEqual({ ok: true }); // not {taskId, status:"pending"}
    } finally {
      restore();
    }
  });

  test("throws by default when the task fails, and journals the failure", async () => {
    const journaled: Array<Record<string, unknown>> = [];
    const restore = installFetchMock(async (url, init) => {
      if (url.includes("/steps/fail-step")) {
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      if (url.endsWith("/agent-task")) {
        return new Response(JSON.stringify({ error: "Agent task failed", taskId: "task-2" }), {
          status: 409,
        });
      }
      if (url.endsWith("/steps")) {
        journaled.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    try {
      await expect(
        buildCtxWithBaseline("run-2").ctx.step.agentTask("fail-step", { task: "x" }),
      ).rejects.toThrow(/failed/i);
      expect(journaled[0]?.status).toBe("failed");
      expect(String(journaled[0]?.error)).toContain("task-2");
    } finally {
      restore();
    }
  });

  test("failOnTaskFailure:false resolves with a structured failure instead of throwing", async () => {
    const journaled: Array<Record<string, unknown>> = [];
    const restore = installFetchMock(async (url, init) => {
      if (url.includes("/steps/fail-step-2")) {
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      if (url.endsWith("/agent-task")) {
        return new Response(JSON.stringify({ error: "Agent task cancelled", taskId: "task-3" }), {
          status: 409,
        });
      }
      if (url.endsWith("/steps")) {
        journaled.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    try {
      const result = await buildCtxWithBaseline("run-3").ctx.step.agentTask("fail-step-2", {
        task: "x",
        failOnTaskFailure: false,
      });
      expect(result).toEqual({ taskId: "task-3", status: "failed", error: "Agent task cancelled" });
      // The STEP itself succeeded (the author opted out of failure-as-throw).
      expect(journaled[0]?.status).toBe("completed");
      expect(journaled[0]?.result).toEqual(result);
    } finally {
      restore();
    }
  });

  test("waitForCompletion:false preserves the legacy single-call, non-blocking shape", async () => {
    let calls = 0;
    const restore = installFetchMock(async (url) => {
      if (url.includes("/steps/legacy-step")) {
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      if (url.endsWith("/agent-task")) {
        calls++;
        return new Response(JSON.stringify({ taskId: "task-4", status: "pending" }), {
          status: 202,
        });
      }
      if (url.endsWith("/steps"))
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      throw new Error(`unexpected fetch ${url}`);
    });

    try {
      const result = await buildCtxWithBaseline("run-4").ctx.step.agentTask("legacy-step", {
        task: "x",
        waitForCompletion: false,
      });
      expect(result).toEqual({ taskId: "task-4", status: "pending" });
      expect(calls).toBe(1); // exactly one dispatch call — no polling loop entered
    } finally {
      restore();
    }
  });

  test("times out loudly when the task never reaches a terminal state within timeoutMs", async () => {
    const restore = installFetchMock(async (url) => {
      if (url.includes("/steps/slow-step")) {
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      if (url.endsWith("/agent-task")) {
        return new Response(JSON.stringify({ taskId: "task-5", status: "pending" }), {
          status: 202,
        });
      }
      if (url.endsWith("/steps"))
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      throw new Error(`unexpected fetch ${url}`);
    });

    try {
      await expect(
        buildCtxWithBaseline("run-5").ctx.step.agentTask("slow-step", { task: "x", timeoutMs: 1 }),
      ).rejects.toThrow(/timed out/i);
    } finally {
      restore();
    }
  });

  test("replay mid-wait re-issues the identical dispatch and resumes to a terminal result", async () => {
    const requestBodies: unknown[] = [];
    const restore = installFetchMock(async (url, init) => {
      if (url.includes("/steps/resume-step")) {
        // Never journaled — the simulated crash happened before this step
        // ever wrote a journal row.
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      if (url.endsWith("/agent-task")) {
        requestBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ taskId: "task-6", taskOutput: { done: true } }), {
          status: 200,
        });
      }
      if (url.endsWith("/steps"))
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      throw new Error(`unexpected fetch ${url}`);
    });

    try {
      const config = { task: "long job" };

      // "Process A": dispatches the step, then the harness process dies
      // before anything is journaled (a real crash never reaches that far
      // either — durableStep only journals after execute() resolves).
      await buildCtxWithBaseline("run-6").ctx.step.agentTask("resume-step", config);

      // "Process B": a fresh subprocess replays the source from the top.
      // completedStep finds no journal row, so it re-enters the step and
      // posts the IDENTICAL (stepKey, config) body — which is exactly what
      // lets the real server's (runId, stepKey) contextKey lookup resolve
      // the SAME task instead of dispatching a duplicate (that dedup path
      // is exercised directly against the real server in the HTTP-level
      // test in script-runs-http.test.ts).
      const result = await buildCtxWithBaseline("run-6").ctx.step.agentTask("resume-step", config);

      expect(result).toEqual({ done: true });
      expect(requestBodies).toHaveLength(2);
      expect(requestBodies[0]).toEqual(requestBodies[1]);
    } finally {
      restore();
    }
  });
});

describe("workflow-ctx: ctx.step.agentTask under Promise.all concurrency", () => {
  test("dispatches concurrently and waits in parallel — wall time ~max(steps) not sum, results in argument order, distinct journal rows", async () => {
    const journaled: Record<string, unknown> = {};
    const dispatchOrder: string[] = [];
    const pollCounts: Record<string, number> = { a: 0, b: 0, c: 0 };
    const targetPolls: Record<string, number> = { a: 2, b: 4, c: 6 };
    const POLL_DELAY_MS = 25;

    const restore = installFetchMock(async (url, init) => {
      if (url.includes("/steps/step-")) {
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      if (url.endsWith("/agent-task")) {
        const body = JSON.parse(String(init?.body)) as { stepKey: string };
        const label = body.stepKey.replace("step-", "");
        if (pollCounts[label] === 0) dispatchOrder.push(label);
        pollCounts[label] = (pollCounts[label] ?? 0) + 1;
        await sleepReal(POLL_DELAY_MS); // simulates the server's per-call long-poll latency
        if ((pollCounts[label] ?? 0) < (targetPolls[label] ?? 0)) {
          return new Response(JSON.stringify({ taskId: `task-${label}`, status: "pending" }), {
            status: 202,
          });
        }
        return new Response(JSON.stringify({ taskId: `task-${label}`, taskOutput: { label } }), {
          status: 200,
        });
      }
      if (url.endsWith("/steps")) {
        const body = JSON.parse(String(init?.body)) as { stepKey: string };
        journaled[body.stepKey] = body;
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    try {
      const { ctx } = buildCtxWithBaseline("run-parallel");
      const start = Date.now();
      const results = await Promise.all([
        ctx.step.agentTask("step-a", { task: "a" }),
        ctx.step.agentTask("step-b", { task: "b" }),
        ctx.step.agentTask("step-c", { task: "c" }),
      ]);
      const elapsed = Date.now() - start;

      // All three dispatch before any of them polls to completion — proof
      // Promise.all fired them concurrently, not one after another (no
      // shared mutex, no serializing queue, no global poll cursor).
      expect(dispatchOrder).toEqual(["a", "b", "c"]);

      // Sequential would take (2+4+6)*25ms = 300ms; parallel is bounded by
      // the slowest step: max(2,4,6)*25ms = 150ms (+ scheduling overhead).
      expect(elapsed).toBeLessThan(250);

      // Promise.all preserves argument order regardless of completion order.
      expect(results).toEqual([{ label: "a" }, { label: "b" }, { label: "c" }]);

      expect(Object.keys(journaled).sort()).toEqual(["step-a", "step-b", "step-c"]);
    } finally {
      restore();
    }
  });

  test("N parallel waits share ONE absolute wall-clock deadline — not per-step, not divided by N", async () => {
    const restore = installFetchMock(async (url) => {
      if (url.includes("/steps/wall-")) {
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      if (url.endsWith("/agent-task")) {
        // Always pending — forces every step toward its deadline.
        return new Response(JSON.stringify({ taskId: "task-x", status: "pending" }), {
          status: 202,
        });
      }
      if (url.endsWith("/steps"))
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      throw new Error(`unexpected fetch ${url}`);
    });

    try {
      // Run "started" 950ms ago with a 1000ms total wall budget — ~50ms of
      // shared budget left, no matter how many steps are racing for it.
      const startedAt = new Date(Date.now() - 950).toISOString();
      const settled = await withRunWallEnv(startedAt, 1000, async () => {
        const { ctx } = buildCtxWithBaseline("run-wall");
        return Promise.allSettled([
          ctx.step.agentTask("wall-a", { task: "a", timeoutMs: 60 * 60 * 1000 }), // huge per-step budget
          ctx.step.agentTask("wall-b", { task: "b" }), // default 2h per-step budget
        ]);
      });

      // Both clamp to the SAME shared run deadline (~50ms out), not their
      // own (much larger) per-step timeoutMs, and not that budget /2.
      const [a, b] = settled;
      expect(a?.status).toBe("rejected");
      expect(b?.status).toBe("rejected");
      expect(a?.status === "rejected" && String(a.reason)).toMatch(/timed out/i);
      expect(b?.status === "rejected" && String(b.reason)).toMatch(/timed out/i);
    } finally {
      restore();
    }
  });

  test("a Promise.all rejection does not orphan an in-flight sibling — drainInFlightSteps lets it journal", async () => {
    const journaled: Record<string, { status?: string; result?: unknown }> = {};
    let bPolls = 0;

    const restore = installFetchMock(async (url, init) => {
      if (url.includes("/steps/orphan-")) {
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      if (url.endsWith("/agent-task")) {
        const body = JSON.parse(String(init?.body)) as { stepKey: string };
        if (body.stepKey === "orphan-a") {
          // Fails immediately — this is what makes Promise.all reject right
          // away, potentially while "orphan-b" is still mid-poll.
          return new Response(JSON.stringify({ error: "Agent task failed", taskId: "task-a" }), {
            status: 409,
          });
        }
        bPolls++;
        await sleepReal(10);
        if (bPolls < 3) {
          return new Response(JSON.stringify({ taskId: "task-b", status: "pending" }), {
            status: 202,
          });
        }
        return new Response(JSON.stringify({ taskId: "task-b", taskOutput: { ok: true } }), {
          status: 200,
        });
      }
      if (url.endsWith("/steps")) {
        const body = JSON.parse(String(init?.body)) as { stepKey: string; status?: string };
        journaled[body.stepKey] = body;
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    try {
      const { ctx, drainInFlightSteps } = buildCtxWithBaseline("run-orphan");

      await expect(
        Promise.all([
          ctx.step.agentTask("orphan-a", { task: "a" }),
          ctx.step.agentTask("orphan-b", { task: "b" }),
        ]),
      ).rejects.toThrow(/failed/i);

      // This is the exact moment harness.ts calls drainInFlightSteps() —
      // right before it would otherwise finalize the run and process.exit,
      // potentially killing "orphan-b" mid-poll with nothing journaled.
      await drainInFlightSteps();

      expect(journaled["orphan-a"]?.status).toBe("failed");
      expect(journaled["orphan-b"]?.status).toBe("completed"); // not orphaned
      expect(journaled["orphan-b"]?.result).toEqual({ ok: true });
    } finally {
      restore();
    }
  });

  test("resume with N steps in flight re-attaches to the SAME taskIds and creates zero duplicates", async () => {
    const requestBodiesByLabel: Record<string, unknown[]> = {
      "resume-a": [],
      "resume-b": [],
      "resume-c": [],
    };

    const restore = installFetchMock(async (url, init) => {
      if (url.includes("/steps/resume-")) {
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      if (url.endsWith("/agent-task")) {
        const body = JSON.parse(String(init?.body)) as { stepKey: string };
        requestBodiesByLabel[body.stepKey]?.push(body);
        return new Response(
          JSON.stringify({ taskId: `task-${body.stepKey}`, taskOutput: { label: body.stepKey } }),
          { status: 200 },
        );
      }
      if (url.endsWith("/steps"))
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      throw new Error(`unexpected fetch ${url}`);
    });

    try {
      const configs: Record<string, unknown> = {
        "resume-a": { task: "a" },
        "resume-b": { task: "b" },
        "resume-c": { task: "c" },
      };

      // "Process A": dispatches all three concurrently, then the harness
      // process dies before any of them is journaled.
      const { ctx: ctxA } = buildCtxWithBaseline("run-resume-n");
      await Promise.all(
        Object.entries(configs).map(([label, config]) => ctxA.step.agentTask(label, config)),
      );

      // "Process B": a fresh subprocess replays all three labels
      // concurrently. Nothing was journaled, so each re-enters and posts
      // the IDENTICAL body — exactly what lets the real server's per-label
      // (runId, stepKey) contextKey lookup resolve the SAME task instead of
      // creating a duplicate (server-side dedup is exercised directly
      // against the real server in script-runs-http.test.ts).
      const { ctx: ctxB } = buildCtxWithBaseline("run-resume-n");
      const results = await Promise.all(
        Object.entries(configs).map(([label, config]) => ctxB.step.agentTask(label, config)),
      );

      expect(results).toEqual([
        { label: "resume-a" },
        { label: "resume-b" },
        { label: "resume-c" },
      ]);
      for (const label of Object.keys(configs)) {
        expect(requestBodiesByLabel[label]).toHaveLength(2); // process A + process B
        expect(requestBodiesByLabel[label]?.[0]).toEqual(requestBodiesByLabel[label]?.[1]);
      }
    } finally {
      restore();
    }
  });

  test("a sibling still awaiting its INITIAL journal lookup is drained, not orphaned (delayed-GET race)", async () => {
    const journaled: Record<string, { status?: string; result?: unknown }> = {};
    let raceBLookupStarted = false;

    const restore = installFetchMock(async (url, init) => {
      if (url.includes("/steps/race-a")) {
        // A's journal lookup resolves immediately, so A races ahead to its
        // terminal failure while B is still blocked on its own lookup.
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      if (url.includes("/steps/race-b")) {
        // THE RACE: B's very first GET is slow (a loaded API server, a
        // retried connection, ordinary latency). Before the fix, B was not
        // registered as in-flight until this resolved — so drainInFlightSteps
        // saw an empty set and process.exit(1) killed B before it dispatched.
        raceBLookupStarted = true;
        await sleepReal(60);
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      if (url.endsWith("/agent-task")) {
        const body = JSON.parse(String(init?.body)) as { stepKey: string };
        if (body.stepKey === "race-a") {
          return new Response(JSON.stringify({ error: "Agent task failed", taskId: "task-a" }), {
            status: 409,
          });
        }
        return new Response(JSON.stringify({ taskId: "task-b", taskOutput: { ok: true } }), {
          status: 200,
        });
      }
      if (url.endsWith("/steps")) {
        const body = JSON.parse(String(init?.body)) as { stepKey: string; status?: string };
        journaled[body.stepKey] = body;
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    try {
      const { ctx, drainInFlightSteps } = buildCtxWithBaseline("run-race");

      await expect(
        Promise.all([
          ctx.step.agentTask("race-a", { task: "a" }),
          ctx.step.agentTask("race-b", { task: "b" }),
        ]),
      ).rejects.toThrow(/failed/i);

      // Pin the race window: at the moment the harness would drain, B has
      // started but not finished its initial lookup — it has not dispatched
      // and has nothing journaled.
      expect(raceBLookupStarted).toBe(true);
      expect(journaled["race-b"]).toBeUndefined();

      await drainInFlightSteps();

      expect(journaled["race-a"]?.status).toBe("failed");
      expect(journaled["race-b"]?.status).toBe("completed"); // not orphaned
      expect(journaled["race-b"]?.result).toEqual({ ok: true });
    } finally {
      restore();
    }
  });
});

describe("workflow-ctx: replay of a journaled failure", () => {
  test("crash after a failed journal write rethrows the recorded failure instead of replaying undefined", async () => {
    const recordedError = "agent-task crashed-step failed: Agent task failed (taskId task-9)";
    let agentTaskCalls = 0;
    let journalWrites = 0;

    const restore = installFetchMock(async (url) => {
      if (url.includes("/steps/crashed-step")) {
        // What the previous harness process journaled right before it died —
        // status "failed" plus the recorded error, never reported as a run
        // failure because the process never got that far.
        return new Response(
          JSON.stringify({
            stepKey: "crashed-step",
            stepType: "agent-task",
            status: "failed",
            result: null,
            error: recordedError,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/agent-task")) {
        agentTaskCalls++;
        return new Response(JSON.stringify({ taskId: "task-9", taskOutput: { ok: true } }), {
          status: 200,
        });
      }
      if (url.endsWith("/steps")) {
        journalWrites++;
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    try {
      // The resumed process replays the source from the top and hits the
      // same step. It must NOT resolve `undefined` (which would let the
      // workflow continue and finish "completed" past a failed child).
      await expect(
        buildCtxWithBaseline("run-crash-replay").ctx.step.agentTask("crashed-step", { task: "x" }),
      ).rejects.toThrow(recordedError);

      expect(agentTaskCalls).toBe(0); // replayed from the journal, not re-dispatched
      expect(journalWrites).toBe(0); // the existing failed entry is left untouched
    } finally {
      restore();
    }
  });

  test("a journaled completion still replays its result, and a status-less entry stays backward compatible", async () => {
    const restore = installFetchMock(async (url) => {
      if (url.includes("/steps/done-step")) {
        return new Response(
          JSON.stringify({
            stepKey: "done-step",
            stepType: "agent-task",
            status: "completed",
            result: { text: "hi" },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/steps/legacy-step")) {
        // An older API build that returned `result` with no `status` field.
        return new Response(
          JSON.stringify({ stepKey: "legacy-step", stepType: "raw-llm", result: { text: "old" } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    try {
      const { ctx } = buildCtxWithBaseline("run-replay-ok");
      expect(await ctx.step.agentTask("done-step", { task: "x" })).toEqual({ text: "hi" });
      expect(await ctx.step.rawLlm("legacy-step", { prompt: "x" })).toEqual({ text: "old" });
    } finally {
      restore();
    }
  });
});
