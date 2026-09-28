import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import * as db from "../be/db";
import {
  closeDb,
  createWorkflow,
  createWorkflowRun,
  deleteWorkflow,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
} from "../be/db";
import type { WorkflowDefinition, WorkflowRunStep } from "../types";
import { walkGraph } from "../workflows/engine";
import { workflowEventBus } from "../workflows/event-bus";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import { ExecutorRegistry } from "../workflows/executors/registry";
import { recoverIncompleteRuns } from "../workflows/recovery";
import { cancelWorkflowRun, retryFailedRun } from "../workflows/resume";
import { startRetryPoller, stopRetryPoller } from "../workflows/retry-poller";
import {
  completeTaskStepAndResolveSuccessors,
  failStepAndRunIfWaiting,
} from "../workflows/task-step-routing";
import { interpolate } from "../workflows/template";

// Counterexamples from the TLA+ model in specs/tla/workflows/. Each test calls
// the production functions in the order of the TLC trace named in its title
// (specs/tla/workflows/FINDINGS.md), against a temp SQLite DB. A barrier
// executor holds a node "in flight" so a trace step that interleaves with a
// running executor can be replayed deterministically.

const TEST_DB_PATH = `./test-workflow-tla-races-${crypto.randomUUID()}.sqlite`;

type Behavior = "ok" | "fail" | "async" | { hold: Promise<void>; entered: () => void };

/** Scripted executor: each call for a node consumes the next behavior. */
const plans = new Map<string, Behavior[]>();
const calls: string[] = [];

class ScriptedExecutor extends BaseExecutor<
  typeof ScriptedExecutor.schema,
  typeof ScriptedExecutor.outSchema
> {
  static readonly schema = z.object({});
  static readonly outSchema = z.object({ node: z.string() });

  readonly type = "scripted";
  readonly mode = "instant" as const;
  readonly configSchema = ScriptedExecutor.schema;
  readonly outputSchema = ScriptedExecutor.outSchema;

  protected async execute(
    _config: z.infer<typeof ScriptedExecutor.schema>,
    _context: Readonly<Record<string, unknown>>,
    meta: { nodeId: string },
  ): Promise<ExecutorResult<z.infer<typeof ScriptedExecutor.outSchema>>> {
    calls.push(meta.nodeId);
    const behavior = plans.get(meta.nodeId)?.shift() ?? "ok";
    if (behavior === "fail") return { status: "failed", error: `${meta.nodeId} failed` };
    if (behavior === "async") {
      return {
        status: "success",
        async: true,
        waitFor: "task.completed",
        correlationId: crypto.randomUUID(),
      } as ExecutorResult<z.infer<typeof ScriptedExecutor.outSchema>>;
    }
    if (typeof behavior === "object") {
      behavior.entered();
      await behavior.hold;
    }
    return { status: "success", output: { node: meta.nodeId } };
  }
}

const deps: ExecutorDependencies = {
  db: db as typeof import("../be/db"),
  eventBus: workflowEventBus,
  interpolate: (template, ctx) => interpolate(template, ctx).result,
};
const registry = new ExecutorRegistry();
registry.register(new ScriptedExecutor(deps));

const retry = { strategy: "static" as const, maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 };

/** T fans out to A and B; with `converge`, both join on M. */
function fanOut(converge: boolean): WorkflowDefinition {
  return {
    nodes: [
      { id: "T", type: "scripted", config: {}, next: ["A", "B"] },
      { id: "A", type: "scripted", config: {}, retry, ...(converge ? { next: "M" } : {}) },
      { id: "B", type: "scripted", config: {}, retry, ...(converge ? { next: "M" } : {}) },
      ...(converge ? [{ id: "M", type: "scripted", config: {} }] : []),
    ],
  };
}

const workflowIds: string[] = [];

async function newRun(def: WorkflowDefinition) {
  const workflow = await createWorkflow({
    name: `tla-race-${crypto.randomUUID()}`,
    definition: def,
  });
  workflowIds.push(workflow.id);
  const runId = crypto.randomUUID();
  await createWorkflowRun({ id: runId, workflowId: workflow.id, triggerType: "manual" });
  const ctx: Record<string, unknown> = {};
  const walk = (nodeIds: string[]) =>
    walkGraph(
      def,
      runId,
      ctx,
      def.nodes.filter((n) => nodeIds.includes(n.id)),
      registry,
      workflow.id,
    );
  return { runId, ctx, walk };
}

function barrier() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const behavior: Behavior = { hold: release.promise, entered: entered.resolve };
  return { behavior, entered: entered.promise, release: release.resolve };
}

async function stepsOf(runId: string, nodeId: string): Promise<WorkflowRunStep[]> {
  return (await getWorkflowRunStepsByRunId(runId)).filter((s) => s.nodeId === nodeId);
}

async function untilStatus(runId: string, nodeId: string, status: string) {
  for (let i = 0; i < 200; i++) {
    const [step] = await stepsOf(runId, nodeId);
    if (step?.status === status) return step;
    await sleep(2);
  }
  throw new Error(`${nodeId} never reached ${status}`);
}

const callsOf = (nodeId: string) => calls.filter((n) => n === nodeId).length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runPollerOnce() {
  startRetryPoller(registry, 1);
  try {
    await sleep(60);
  } finally {
    stopRetryPoller();
  }
}

beforeAll(() => initDb(TEST_DB_PATH));

afterAll(async () => {
  stopRetryPoller();
  for (const id of workflowIds) await deleteWorkflow(id).catch(() => {});
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) await unlink(TEST_DB_PATH + suffix).catch(() => {});
});

describe("TLA+ workflow counterexamples", () => {
  test("CX1: the retry poller does not re-execute a failed step of a cancelled run", async () => {
    plans.clear();
    calls.length = 0;
    const def = fanOut(false);
    plans.set("A", ["fail", "ok"]);
    const { runId, walk } = await newRun(def);

    // XDedup/XRun/XFail: A fails with a retry left; B completes. Run stays running.
    await walk(["T"]);
    expect((await stepsOf(runId, "A"))[0]?.nextRetryAt).toBeTruthy();

    // Cancel: the failed A row counts as terminal, so its nextRetryAt survives.
    await cancelWorkflowRun(runId);
    await sleep(5);

    // P1..P9: the poller selects A with no run filter and re-executes it.
    await runPollerOnce();

    expect(callsOf("A")).toBe(1);
    expect((await getWorkflowRun(runId))?.status).toBe("cancelled");
  });

  test.failing("CX2: a user retry does not re-execute a branch the live walk is still running", async () => {
    plans.clear();
    calls.length = 0;
    const def = fanOut(true);
    const holdA = barrier();
    plans.set("A", [holdA.behavior, "ok"]);
    plans.set("B", ["async", "async"]);
    const { runId, walk } = await newRun(def);

    // Initial walk: B dispatches async (waiting), A is in flight.
    const initial = walk(["T"]);
    await holdA.entered;
    const stepB = await untilStatus(runId, "B", "waiting");

    // EF: B's task fails -> run failed.
    await failStepAndRunIfWaiting(stepB!.id, runId, "task failed");
    expect((await getWorkflowRun(runId))?.status).toBe("failed");

    // U1/U2: the user retries; findReadyNodes returns A because it is not completed.
    await retryFailedRun(runId, registry);
    holdA.release();
    await initial;

    expect(callsOf("A")).toBe(1);
  });

  test.failing("CX3: an async branch completing does not fire the join while a sibling branch is still executing", async () => {
    plans.clear();
    calls.length = 0;
    const def = fanOut(true);
    const holdA = barrier();
    plans.set("A", [holdA.behavior]);
    plans.set("B", ["async"]);
    const { runId, ctx, walk } = await newRun(def);

    const initial = walk(["T"]);
    await holdA.entered;
    const stepB = await untilStatus(runId, "B", "waiting");

    // E2: B's task completes; the handler claims B and walks its successor M.
    const routing = await completeTaskStepAndResolveSuccessors(
      def,
      runId,
      stepB!,
      { node: "B" },
      ctx,
    );
    expect(routing.claimed).toBe(true);
    await walk(routing.successors.map((n) => n.id));

    const mBeforeA = callsOf("M");
    const statusBeforeA = (await getWorkflowRun(runId))?.status;
    holdA.release();
    await initial;

    expect(mBeforeA).toBe(0);
    expect(statusBeforeA).not.toBe("completed");
  });

  test.failing("CX4: two branch completions racing to the join execute it once", async () => {
    plans.clear();
    calls.length = 0;
    const def = fanOut(true);
    plans.set("A", ["async"]);
    plans.set("B", ["async"]);
    const { runId, ctx, walk } = await newRun(def);

    await walk(["T"]);
    const [stepA] = await stepsOf(runId, "A");
    const [stepB] = await stepsOf(runId, "B");

    // E2, E2: both handlers claim their step before either walks M.
    const ra = await completeTaskStepAndResolveSuccessors(def, runId, stepA!, { node: "A" }, ctx);
    const rb = await completeTaskStepAndResolveSuccessors(def, runId, stepB!, { node: "B" }, ctx);
    await Promise.all([walk(ra.successors.map((n) => n.id)), walk(rb.successors.map((n) => n.id))]);

    expect(callsOf("M")).toBe(1);
    expect(await stepsOf(runId, "M")).toHaveLength(1);
  });

  test.failing("CX5: heartbeat recovery leaves a step that is pending retry to the retry poller", async () => {
    plans.clear();
    calls.length = 0;
    const def = fanOut(false);
    plans.set("A", ["fail", "ok", "ok"]);
    const { runId, walk } = await newRun(def);

    // A fails with a retry pending; B completes; the walk ends with the run running.
    await walk(["T"]);
    expect((await getWorkflowRun(runId))?.status).toBe("running");

    // H1..H3: recovery sees a running, idle run and re-walks A (findReadyNodes).
    await recoverIncompleteRuns(registry);
    await sleep(5);
    // P1..P6: the poller retries the original failed A row.
    await runPollerOnce();

    // One original attempt plus one retry.
    expect(callsOf("A")).toBe(2);
  });

  test.failing("CX6: heartbeat recovery does not walk a run whose trigger is still resolving inputs", async () => {
    plans.clear();
    calls.length = 0;
    const def = fanOut(false);
    const holdT = barrier();
    plans.set("T", [holdT.behavior, "ok"]);

    // IStart: startWorkflowExecution has committed the run as `running` and is
    // awaiting resolveRenderedWorkflowInputs, so no walk is registered yet.
    const { runId, walk } = await newRun(def);

    // H1..H3: the sweep sees a running, idle run with no steps and walks T.
    const recovery = recoverIncompleteRuns(registry);
    await holdT.entered;

    // IWalk: input resolution finishes and the trigger's own walk starts T.
    await walk(["T"]);
    holdT.release();
    await recovery;

    expect(callsOf("T")).toBe(1);
    expect(await stepsOf(runId, "T")).toHaveLength(1);
  });

  test.failing("CX7: the walk finalizer does not complete a run while the retry poller is executing a step", async () => {
    plans.clear();
    calls.length = 0;
    const def = fanOut(false);
    const holdB = barrier();
    const holdA = barrier();
    plans.set("A", ["fail", holdA.behavior]);
    plans.set("B", [holdB.behavior]);
    const { runId, walk } = await newRun(def);

    // XFail: A fails with a retry pending while B is still executing.
    const initial = walk(["T"]);
    await holdB.entered;
    await untilStatus(runId, "A", "failed");
    await sleep(5);

    // P1..P5: the poller claims A and is executing it.
    startRetryPoller(registry, 1);
    try {
      await holdA.entered;
      // XCkOk/WFinal: B finishes and the walk finalizes with A running.
      holdB.release();
      await initial;
      const statusWhileARuns = (await getWorkflowRun(runId))?.status;
      holdA.release();
      await sleep(20);
      expect(statusWhileARuns).not.toBe("completed");
    } finally {
      holdA.release();
      stopRetryPoller();
    }
  });
});
