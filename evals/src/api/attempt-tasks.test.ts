import { afterEach, describe, expect, test } from "bun:test";
import type { SandboxInfo } from "../types.ts";
import { buildAttemptTaskRecords, fetchLiveTaskRecords } from "./server.ts";

/**
 * GET /api/attempts/:id/tasks assembly (v7.5 items 2/5/6 — frozen contract).
 * Fixtures mirror the shapes verified against live evals.db: tasks.json
 * entries carry id / title (often "") / status / output + result /
 * failureReason / dependsOn (UUID[]) / agentId / runner-set skipped;
 * session-costs.json is [{ taskId, rows: SessionCostRow[] }].
 */

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const T3 = "33333333-3333-4333-8333-333333333333";

/** Realistic tasks.json entry (verified key set from live evals.db rows). */
function artifactEntry(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: T1,
    agentId: "agent-1",
    task: "Title\n\nLong description body",
    title: "",
    description: "Long description body",
    status: "completed",
    source: "api",
    dependsOn: [],
    output: "final output",
    result: "final output",
    progress: "final output",
    createdAt: "2026-06-12T13:32:52.211Z",
    ...overrides,
  };
}

function build(opts: {
  taskIds?: string[];
  tasks?: unknown;
  costs?: unknown;
  tasksRaw?: string | null;
  costsRaw?: string | null;
}) {
  return buildAttemptTaskRecords({
    taskIds: opts.taskIds ?? [],
    tasksArtifact:
      opts.tasksRaw !== undefined
        ? opts.tasksRaw
        : opts.tasks !== undefined
          ? JSON.stringify(opts.tasks)
          : null,
    costsArtifact:
      opts.costsRaw !== undefined
        ? opts.costsRaw
        : opts.costs !== undefined
          ? JSON.stringify(opts.costs)
          : null,
  });
}

describe("buildAttemptTaskRecords — tasks-artifact source", () => {
  test("realistic entry normalizes to the frozen record shape", () => {
    const res = build({ taskIds: [T1], tasks: [artifactEntry({})] });
    expect(res.source).toBe("tasks-artifact");
    expect(res.live).toBe(false);
    expect(res.tasks).toEqual([
      {
        id: T1,
        title: null, // "" title → null
        status: "completed",
        outcome: "final output",
        error: null,
        skipped: false,
        dependsOn: [],
        agentId: "agent-1",
        origin: "run", // no origin tag on the entry → defaults to run
        costUsd: null, // no session-costs.json
        tokens: null,
        createdAt: "2026-06-12T13:32:52.211Z", // v7.7 item 7: verbatim passthrough
        finishedAt: null,
        durationMs: null, // no finishedAt → null
      },
    ]);
  });

  test("origin: seed entries pass through; missing/other values default to run", () => {
    const res = build({
      taskIds: [T1, T2, T3],
      tasks: [
        artifactEntry({ id: T1, origin: "seed" }),
        artifactEntry({ id: T2, origin: "run" }),
        artifactEntry({ id: T3 }), // no origin tag → run
      ],
    });
    expect(res.tasks.map((t) => t.origin)).toEqual(["seed", "run", "run"]);
  });

  test("outcome precedence: result first, output fallback, null when both empty", () => {
    const res = build({
      taskIds: [T1, T2, T3],
      tasks: [
        artifactEntry({ id: T1, result: "from result", output: "from output" }),
        artifactEntry({ id: T2, result: "", output: "from output" }),
        artifactEntry({ id: T3, result: null, output: "" }),
      ],
    });
    expect(res.tasks.map((t) => t.outcome)).toEqual(["from result", "from output", null]);
  });

  test("outcome and error are clipped to 4000 chars", () => {
    const long = "x".repeat(5000);
    const res = build({
      taskIds: [T1],
      tasks: [artifactEntry({ result: long, output: "", status: "failed", failureReason: long })],
    });
    const rec = res.tasks[0];
    expect(rec?.outcome).toHaveLength(4000);
    expect(rec?.error).toHaveLength(4000);
  });

  test("non-empty title survives; error carries failureReason", () => {
    const res = build({
      taskIds: [T1],
      tasks: [
        artifactEntry({
          title: "Deploy the fix",
          status: "failed",
          result: "",
          output: "",
          failureReason: "exit code 1",
        }),
      ],
    });
    expect(res.tasks[0]?.title).toBe("Deploy the fix");
    expect(res.tasks[0]?.error).toBe("exit code 1");
    expect(res.tasks[0]?.skipped).toBe(false); // real failure, not cascade-skip
  });

  test("skipped: runner-set flag wins; cascade failureReason re-derives when absent", () => {
    const cascade = "Blocked dependency abcd1234 was failed";
    const res = build({
      taskIds: [T1, T2, T3],
      tasks: [
        // runner-set skipped: true (only present when true in stored artifacts)
        artifactEntry({ id: T1, status: "failed", skipped: true, failureReason: cascade }),
        // absent skipped + cascade reason → derived true (v6 §9 semantics)
        artifactEntry({ id: T2, status: "failed", failureReason: cascade }),
        // explicit false is trusted — never re-derived
        artifactEntry({ id: T3, status: "failed", skipped: false, failureReason: cascade }),
      ],
    });
    expect(res.tasks.map((t) => t.skipped)).toEqual([true, true, false]);
  });

  test("dependsOn passes through as UUID array; non-strings filtered", () => {
    const res = build({
      taskIds: [T1, T2],
      tasks: [
        artifactEntry({ id: T1 }),
        artifactEntry({ id: T2, dependsOn: [T1, 42, null, "extra-dep"] }),
      ],
    });
    expect(res.tasks[1]?.dependsOn).toEqual([T1, "extra-dep"]);
  });

  test("agentId falls back to assignedAgentId, then null", () => {
    const res = build({
      taskIds: [T1, T2],
      tasks: [
        artifactEntry({ id: T1, agentId: undefined, assignedAgentId: "agent-2" }),
        artifactEntry({ id: T2, agentId: undefined }),
      ],
    });
    expect(res.tasks.map((t) => t.agentId)).toEqual(["agent-2", null]);
  });

  test("ordering: attempt.taskIds first, artifact-only extras appended in artifact order", () => {
    const res = build({
      taskIds: [T2, T1], // creation order differs from artifact order
      tasks: [
        artifactEntry({ id: "extra-b", title: "B" }),
        artifactEntry({ id: T1 }),
        artifactEntry({ id: "extra-a", title: "A" }),
        artifactEntry({ id: T2 }),
      ],
    });
    expect(res.tasks.map((t) => t.id)).toEqual([T2, T1, "extra-b", "extra-a"]);
  });

  test("taskId missing from the artifact gets an all-null record at its position", () => {
    const res = build({ taskIds: [T1, T2], tasks: [artifactEntry({ id: T2 })] });
    expect(res.source).toBe("tasks-artifact");
    expect(res.tasks[0]).toEqual({
      id: T1,
      title: null,
      status: null,
      outcome: null,
      error: null,
      skipped: false,
      dependsOn: [],
      agentId: null,
      origin: "run",
      costUsd: null,
      tokens: null,
      createdAt: null,
      finishedAt: null,
      durationMs: null,
    });
    expect(res.tasks[1]?.status).toBe("completed");
  });
});

describe("buildAttemptTaskRecords — task timestamps + durationMs (v7.7 item 7, frozen)", () => {
  test("both timestamps present and ordered → durationMs = finishedAt − createdAt", () => {
    const res = build({
      taskIds: [T1],
      tasks: [
        artifactEntry({
          createdAt: "2026-06-12T13:32:52.211Z",
          finishedAt: "2026-06-12T13:34:04.211Z",
        }),
      ],
    });
    expect(res.tasks[0]?.createdAt).toBe("2026-06-12T13:32:52.211Z");
    expect(res.tasks[0]?.finishedAt).toBe("2026-06-12T13:34:04.211Z");
    expect(res.tasks[0]?.durationMs).toBe(72_000);
  });

  test("finishedAt before createdAt → durationMs null, timestamps still pass through", () => {
    const res = build({
      taskIds: [T1],
      tasks: [
        artifactEntry({
          createdAt: "2026-06-12T13:34:04.211Z",
          finishedAt: "2026-06-12T13:32:52.211Z",
        }),
      ],
    });
    expect(res.tasks[0]?.createdAt).toBe("2026-06-12T13:34:04.211Z");
    expect(res.tasks[0]?.finishedAt).toBe("2026-06-12T13:32:52.211Z");
    expect(res.tasks[0]?.durationMs).toBeNull();
  });

  test("zero-length span is a valid duration (diff >= 0 rule)", () => {
    const ts = "2026-06-12T13:32:52.211Z";
    const res = build({ taskIds: [T1], tasks: [artifactEntry({ createdAt: ts, finishedAt: ts })] });
    expect(res.tasks[0]?.durationMs).toBe(0);
  });

  test("unparseable timestamp passes through verbatim (never reformatted) with null duration", () => {
    const res = build({
      taskIds: [T1],
      tasks: [artifactEntry({ createdAt: "not-a-date", finishedAt: "2026-06-12T13:34:04.211Z" })],
    });
    expect(res.tasks[0]?.createdAt).toBe("not-a-date");
    expect(res.tasks[0]?.finishedAt).toBe("2026-06-12T13:34:04.211Z");
    expect(res.tasks[0]?.durationMs).toBeNull();
  });

  test("empty-string / non-string timestamps degrade to null", () => {
    const res = build({
      taskIds: [T1, T2],
      tasks: [
        artifactEntry({ id: T1, createdAt: "", finishedAt: "" }),
        artifactEntry({ id: T2, createdAt: 1765546372211, finishedAt: null }),
      ],
    });
    for (const rec of res.tasks) {
      expect(rec.createdAt).toBeNull();
      expect(rec.finishedAt).toBeNull();
      expect(rec.durationMs).toBeNull();
    }
  });
});

describe("buildAttemptTaskRecords — per-task cost join (item 6)", () => {
  const row = (overrides: Record<string, unknown>) => ({
    totalCostUsd: 0.1,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 1000,
    cacheWriteTokens: 200,
    model: "claude-haiku-4-5-20251001",
    costSource: "harness",
    ...overrides,
  });

  test("costUsd = Σ priced rows; tokens = field-wise Σ with first non-null model", () => {
    const res = build({
      taskIds: [T1],
      tasks: [artifactEntry({})],
      costs: [
        {
          taskId: T1,
          rows: [
            row({ totalCostUsd: 0.1, model: null }),
            row({ totalCostUsd: 0.25, model: "claude-haiku-4-5-20251001" }),
            row({ totalCostUsd: null, inputTokens: 10, outputTokens: 5 }), // unpriced row still counts tokens
          ],
        },
      ],
    });
    const rec = res.tasks[0];
    expect(rec?.costUsd).toBeCloseTo(0.35, 10);
    expect(rec?.tokens).toEqual({
      model: "claude-haiku-4-5-20251001",
      inputTokens: 210,
      outputTokens: 105,
      cacheReadTokens: 3000,
      cacheWriteTokens: 600,
    });
  });

  test("zero priced rows → costUsd null but tokens still summed (claude OAuth shape)", () => {
    const res = build({
      taskIds: [T1],
      tasks: [artifactEntry({})],
      costs: [{ taskId: T1, rows: [row({ totalCostUsd: null })] }],
    });
    expect(res.tasks[0]?.costUsd).toBeNull();
    expect(res.tasks[0]?.tokens?.inputTokens).toBe(100);
  });

  test("rows with no token columns → tokens null", () => {
    const res = build({
      taskIds: [T1],
      tasks: [artifactEntry({})],
      costs: [
        {
          taskId: T1,
          rows: [
            row({
              totalCostUsd: 0.5,
              inputTokens: null,
              outputTokens: null,
              cacheReadTokens: null,
              cacheWriteTokens: null,
            }),
          ],
        },
      ],
    });
    expect(res.tasks[0]?.costUsd).toBe(0.5);
    expect(res.tasks[0]?.tokens).toBeNull();
  });

  test("cost is per-task: only the matching taskId's rows join", () => {
    const res = build({
      taskIds: [T1, T2],
      tasks: [artifactEntry({ id: T1 }), artifactEntry({ id: T2 })],
      costs: [
        { taskId: T1, rows: [row({ totalCostUsd: 0.2 })] },
        { taskId: T2, rows: [] }, // empty rows → null, not 0
      ],
    });
    expect(res.tasks[0]?.costUsd).toBe(0.2);
    expect(res.tasks[1]?.costUsd).toBeNull();
    expect(res.tasks[1]?.tokens).toBeNull();
  });

  test("missing session-costs.json → costUsd/tokens null everywhere", () => {
    const res = build({ taskIds: [T1], tasks: [artifactEntry({})] });
    expect(res.tasks[0]?.costUsd).toBeNull();
    expect(res.tasks[0]?.tokens).toBeNull();
  });

  test("malformed session-costs.json degrades to null cost, never breaks the response", () => {
    const res = build({ taskIds: [T1], tasks: [artifactEntry({})], costsRaw: "{not json" });
    expect(res.source).toBe("tasks-artifact");
    expect(res.tasks[0]?.costUsd).toBeNull();
  });
});

describe("buildAttemptTaskRecords — back-compat degradation (v1-era rows)", () => {
  test("no artifacts + taskIds → task-ids source with all-null records", () => {
    const res = build({ taskIds: [T1, T2] });
    expect(res).toEqual({
      source: "task-ids",
      live: false,
      tasks: [
        {
          id: T1,
          title: null,
          status: null,
          outcome: null,
          error: null,
          skipped: false,
          dependsOn: [],
          agentId: null,
          origin: "run",
          costUsd: null,
          tokens: null,
          createdAt: null,
          finishedAt: null,
          durationMs: null,
        },
        {
          id: T2,
          title: null,
          status: null,
          outcome: null,
          error: null,
          skipped: false,
          dependsOn: [],
          agentId: null,
          origin: "run",
          costUsd: null,
          tokens: null,
          createdAt: null,
          finishedAt: null,
          durationMs: null,
        },
      ],
    });
  });

  test("no artifacts + no taskIds → null source, empty tasks", () => {
    expect(build({})).toEqual({ source: null, live: false, tasks: [] });
  });

  test("malformed tasks.json degrades to task-ids", () => {
    const res = build({ taskIds: [T1], tasksRaw: "[{broken" });
    expect(res.source).toBe("task-ids");
    expect(res.tasks).toHaveLength(1);
    expect(res.tasks[0]?.status).toBeNull();
  });

  test("non-array tasks.json degrades to task-ids / null", () => {
    expect(build({ taskIds: [T1], tasksRaw: '{"tasks":[]}' }).source).toBe("task-ids");
    expect(build({ tasksRaw: '{"tasks":[]}' }).source).toBeNull();
  });

  test("entries without a string id are dropped, never crash", () => {
    const res = build({
      taskIds: [T1],
      tasks: [artifactEntry({ id: T1 }), { status: "completed" }, null, "junk"],
    });
    expect(res.tasks.map((t) => t.id)).toEqual([T1]);
  });
});

// ---- live source (?live=1) — mock-fetch pattern from swarm/client.test.ts ----

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const SANDBOX: SandboxInfo = {
  v: 2,
  apiSandboxId: "api-sbx",
  apiTemplate: "agent-swarm-api-latest",
  apiUrl: "http://stack.test",
  swarmKey: "swarm-key",
  domain: null,
  apiStartedAt: null,
  apiVersion: null,
  workers: [],
};

describe("fetchLiveTaskRecords (?live=1 source)", () => {
  test("one GET per taskId; records normalized with costUsd/tokens ALWAYS null", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      const id = url.split("/").pop() as string;
      return new Response(
        JSON.stringify({
          id,
          title: id === T1 ? "Live task" : "",
          task: "Live task\n\nbody",
          status: id === T1 ? "in_progress" : "pending",
          output: id === T1 ? "partial output" : null,
          dependsOn: id === T2 ? [T1] : [],
          agentId: "agent-live",
          // live payloads carry the same task timestamps (v7.7 item 7)
          createdAt: id === T1 ? "2026-06-12T14:00:00.000Z" : undefined,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const records = await fetchLiveTaskRecords(SANDBOX, [T1, T2]);
    expect(seen).toEqual([
      `http://stack.test/api/tasks/${T1}`,
      `http://stack.test/api/tasks/${T2}`,
    ]);
    expect(records).toEqual([
      {
        id: T1,
        title: "Live task",
        status: "in_progress",
        outcome: "partial output",
        error: null,
        skipped: false,
        dependsOn: [],
        agentId: "agent-live",
        origin: "run", // live source carries no origin tag → defaults to run
        costUsd: null,
        tokens: null,
        createdAt: "2026-06-12T14:00:00.000Z",
        finishedAt: null, // still running
        durationMs: null,
      },
      {
        id: T2,
        title: null,
        status: "pending",
        outcome: null,
        error: null,
        skipped: false,
        dependsOn: [T1],
        agentId: "agent-live",
        origin: "run", // live source carries no origin tag → defaults to run
        costUsd: null,
        tokens: null,
        createdAt: null,
        finishedAt: null,
        durationMs: null,
      },
    ]);
  });

  test("a failing task fetch rejects so the route falls through to artifacts", async () => {
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    await expect(fetchLiveTaskRecords(SANDBOX, [T1])).rejects.toThrow();
  });
});
