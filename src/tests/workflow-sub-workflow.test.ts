import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import * as preflightAlerts from "../automation-preflight-alert";
import * as db from "../be/db";
import {
  closeDb,
  createWorkflow,
  getDbClient,
  getWaitStateByStepId,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
} from "../be/db";
import { getWorkflowRunParent } from "../be/db/workflow-runs";
import type { Workflow, WorkflowDefinition, WorkflowRun } from "../types";
import { startWorkflowExecution } from "../workflows/engine";
import { workflowEventBus } from "../workflows/event-bus";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorInput,
  type ExecutorResult,
} from "../workflows/executors/base";
import { createExecutorRegistry } from "../workflows/executors/registry";
import { MAX_SUB_WORKFLOW_DEPTH, SubWorkflowExecutor } from "../workflows/executors/sub-workflow";
import { recoverIncompleteRuns } from "../workflows/recovery";
import {
  cancelWorkflowRun,
  resumeFromChildRun,
  resumeWaitState,
  setupWorkflowResumeListener,
} from "../workflows/resume";
import { startRetryPoller, stopRetryPoller } from "../workflows/retry-poller";

const TEST_DB_PATH = "./test-workflow-sub-workflow.sqlite";

const deps: ExecutorDependencies = {
  db,
  eventBus: workflowEventBus,
  interpolate: (t: string) => t,
};
const registry = createExecutorRegistry(deps);
let teardown: (() => void) | undefined;

/** Holds every `test-gate` node open until the test resolves it. */
let gate = Promise.withResolvers<void>();

/** An instant node that runs until the test opens the gate. */
class GateExecutor extends BaseExecutor<z.ZodObject, z.ZodObject> {
  readonly type = "test-gate";
  readonly mode = "instant" as const;
  readonly configSchema = z.object({});
  readonly outputSchema = z.object({});

  protected async execute(): Promise<ExecutorResult<Record<string, never>>> {
    await gate.promise;
    return { status: "success", output: {} };
  }
}
registry.register(new GateExecutor(deps));

/** Runs `fn` with the live resume listener off, then turns it back on. */
async function withoutListener(fn: () => Promise<void>): Promise<void> {
  teardown?.();
  try {
    await fn();
  } finally {
    teardown = setupWorkflowResumeListener(workflowEventBus, registry);
  }
}

async function makeWorkflow(def: WorkflowDefinition): Promise<Workflow> {
  return createWorkflow({ name: `wf-${crypto.randomUUID()}`, definition: def });
}

/** A one-node child that checks `trigger.n === 1`. */
const instantChild: WorkflowDefinition = {
  nodes: [
    {
      id: "check",
      type: "property-match",
      config: { conditions: [{ field: "trigger.n", op: "eq", value: 1 }] },
    },
  ],
};

/** A child whose only instant node runs until the gate opens. */
const gatedChild: WorkflowDefinition = {
  nodes: [{ id: "gate", type: "test-gate", config: {} }],
};

/** A child that parks on a long time wait, so it stays `waiting`. */
const waitingChild: WorkflowDefinition = {
  nodes: [{ id: "pause", type: "wait", config: { mode: "time", durationMs: 3_600_000 } }],
};

function parentOf(childId: string): WorkflowDefinition {
  return {
    nodes: [
      {
        id: "child",
        type: "sub-workflow",
        config: { workflowId: childId, inputs: { n: 1 } },
      },
    ],
  };
}

async function childRunsOf(workflowId: string): Promise<{ id: string; parentStepId: string }[]> {
  return getDbClient().query<{ id: string; parentStepId: string }>(
    "SELECT id, parentStepId FROM workflow_runs WHERE workflowId = ?",
    [workflowId],
  );
}

async function waitForRun(
  runId: string,
  done: (run: WorkflowRun) => boolean,
): Promise<WorkflowRun> {
  for (let i = 0; i < 250; i++) {
    const run = await getWorkflowRun(runId);
    if (run && done(run)) return run;
    await Bun.sleep(20);
  }
  throw new Error(`run ${runId} did not settle`);
}

const isDone = (run: WorkflowRun) => run.status !== "running" && run.status !== "waiting";

async function childRunOf(workflowId: string, status: string): Promise<WorkflowRun> {
  for (let i = 0; i < 250; i++) {
    const [row] = await childRunsOf(workflowId);
    if (row) return waitForRun(row.id, (r) => r.status === status);
    await Bun.sleep(20);
  }
  throw new Error(`no child run of ${workflowId}`);
}

beforeAll(() => {
  initDb(TEST_DB_PATH);
  teardown = setupWorkflowResumeListener(workflowEventBus, registry);
});

afterAll(async () => {
  teardown?.();
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
});

describe("sub-workflow node", () => {
  test("runs an instant child and exposes its node outputs", async () => {
    const child = await makeWorkflow(instantChild);
    const parent = await makeWorkflow(parentOf(child.id));

    const runId = await startWorkflowExecution(parent, {}, registry);

    const run = await waitForRun(runId, isDone);
    expect(run?.status).toBe("completed");
    const [childRun] = await childRunsOf(child.id);
    const output = run?.context?.child as { runId: string; outputs: Record<string, unknown> };
    expect(output.runId).toBe(childRun!.id);
    expect(output.outputs.check).toMatchObject({ passed: true });
    expect(output.outputs.trigger).toBeUndefined();
  });

  test("a child run names its parent step and run", async () => {
    const child = await makeWorkflow(instantChild);
    const parent = await makeWorkflow(parentOf(child.id));

    const runId = await startWorkflowExecution(parent, {}, registry);
    await waitForRun(runId, isDone);

    const [childRow] = await childRunsOf(child.id);
    const childRun = await getWorkflowRun(childRow!.id, "display");
    const [parentStep] = await getWorkflowRunStepsByRunId(runId);
    expect(childRun?.parentStepId).toBe(parentStep!.id);
    expect(await getWorkflowRunParent(childRun!.parentStepId!)).toEqual({
      runId,
      workflowId: parent.id,
      stepId: parentStep!.id,
      nodeId: "child",
    });
    expect((await getWorkflowRun(runId))?.parentStepId).toBeUndefined();
    expect(await getWorkflowRunParent(crypto.randomUUID())).toBeNull();
  });

  test("a failed child fails the node and the parent run", async () => {
    const child = await makeWorkflow({
      nodes: [{ id: "bad", type: "property-match", config: { conditions: [] } }],
    });
    const parent = await makeWorkflow(parentOf(child.id));

    const runId = await startWorkflowExecution(parent, {}, registry);

    const run = await waitForRun(runId, isDone);
    expect(run?.status).toBe("failed");
    const [step] = await getWorkflowRunStepsByRunId(runId);
    expect(step?.status).toBe("failed");
    expect(step?.error).toContain("failed");
  });

  test("parent waits for an async child and resumes when it completes", async () => {
    const child = await makeWorkflow(waitingChild);
    const parent = await makeWorkflow(parentOf(child.id));

    const runId = await startWorkflowExecution(parent, {}, registry);
    expect((await getWorkflowRun(runId))?.status).toBe("waiting");
    const childRun = await childRunOf(child.id, "waiting");

    const [childStep] = await getWorkflowRunStepsByRunId(childRun.id);
    const wait = await getWaitStateByStepId(childStep!.id);
    await resumeWaitState(wait!.id, "fired", undefined, registry);

    const run = await waitForRun(runId, (r) => r.status !== "waiting");
    expect(run.status).toBe("completed");
    expect((run.context?.child as { runId: string }).runId).toBe(childRun.id);
  });

  test("a cancelled child fails the waiting parent step", async () => {
    const child = await makeWorkflow(waitingChild);
    const parent = await makeWorkflow(parentOf(child.id));

    const runId = await startWorkflowExecution(parent, {}, registry);
    const childRun = await childRunOf(child.id, "waiting");
    await cancelWorkflowRun(childRun.id, "stop");

    const run = await waitForRun(runId, (r) => r.status !== "waiting");
    expect(run.status).toBe("failed");
    expect(run.error).toContain(`Child workflow run ${childRun.id} cancelled`);
  });

  test("re-executing the step reconnects to the existing child; recovery resumes it", () =>
    // No live listener for this test: the child finishing is only seen by recovery.
    withoutListener(async () => {
      const child = await makeWorkflow(waitingChild);
      const parent = await makeWorkflow(parentOf(child.id));

      const runId = await startWorkflowExecution(parent, {}, registry);
      const [parentStep] = await getWorkflowRunStepsByRunId(runId);
      const childRun = await childRunOf(child.id, "waiting");

      // A restart re-runs the executor for the same step.
      const again = await registry.get("sub-workflow").run({
        config: { workflowId: child.id, inputs: { n: 1 } },
        context: {},
        meta: {
          runId,
          stepId: parentStep!.id,
          nodeId: "child",
          workflowId: parent.id,
          dryRun: false,
        },
      });
      expect(again).toMatchObject({ async: true, correlationId: childRun.id });
      expect(await childRunsOf(child.id)).toHaveLength(1);

      // The child finishes while nothing listens.
      const [childStep] = await getWorkflowRunStepsByRunId(childRun.id);
      const wait = await getWaitStateByStepId(childStep!.id);
      await resumeWaitState(wait!.id, "fired", undefined, registry);
      expect((await getWorkflowRun(childRun.id))?.status).toBe("completed");
      expect((await getWorkflowRun(runId))?.status).toBe("waiting");

      await recoverIncompleteRuns(registry);
      expect((await getWorkflowRun(runId))?.status).toBe("completed");
      expect(await childRunsOf(child.id)).toHaveLength(1);
    }));

  test("a slow instant child runs outside the parent executor's timeout", async () => {
    // The gate holds the child's instant node open for as long as the test
    // wants, past any watchdog. The parent's executor call returns regardless.
    gate = Promise.withResolvers<void>();
    const child = await makeWorkflow(gatedChild);
    const parent = await makeWorkflow(parentOf(child.id));

    const runId = await startWorkflowExecution(parent, {}, registry);
    expect((await getWorkflowRun(runId))?.status).toBe("waiting");
    const [childRun] = await childRunsOf(child.id);
    expect((await getWorkflowRun(childRun!.id))?.status).toBe("running");

    gate.resolve();
    const run = await waitForRun(runId, isDone);
    expect(run.status).toBe("completed");
    expect((run.context?.child as { runId: string }).runId).toBe(childRun!.id);
  });

  test("a child that finishes before the parent step parks still resumes it", () =>
    // No listener: the child's terminal event is lost, as in the race where it
    // fires before the step is waiting. Only the post-park recheck can resume.
    withoutListener(async () => {
      gate = Promise.withResolvers<void>();
      // Delays the executor's result, so parking happens after the child ends.
      class LateParkExecutor extends SubWorkflowExecutor {
        override async run(input: ExecutorInput) {
          const result = await super.run(input);
          const { correlationId } = result as { correlationId?: string };
          gate.resolve();
          if (correlationId) await waitForRun(correlationId, isDone);
          return result;
        }
      }
      const lateRegistry = createExecutorRegistry(deps);
      lateRegistry.register(new GateExecutor(deps));
      lateRegistry.register(new LateParkExecutor(deps, lateRegistry));
      const child = await makeWorkflow(gatedChild);
      const parent = await makeWorkflow(parentOf(child.id));

      const runId = await startWorkflowExecution(parent, {}, lateRegistry);

      expect((await getWorkflowRun(runId))?.status).toBe("completed");
    }));

  test("deleting an active child's workflow fails the waiting parent step", async () => {
    const child = await makeWorkflow(waitingChild);
    const parent = await makeWorkflow(parentOf(child.id));
    const runId = await startWorkflowExecution(parent, {}, registry);
    await childRunOf(child.id, "waiting");

    await db.deleteWorkflow(child.id);

    const run = await waitForRun(runId, isDone);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("was deleted");
  });

  test("recovery fails a waiting parent step whose child row is gone", () =>
    withoutListener(async () => {
      const child = await makeWorkflow(waitingChild);
      const parent = await makeWorkflow(parentOf(child.id));
      const runId = await startWorkflowExecution(parent, {}, registry);
      await childRunOf(child.id, "waiting");

      await db.deleteWorkflow(child.id);
      expect((await getWorkflowRun(runId))?.status).toBe("waiting");

      await recoverIncompleteRuns(registry);
      const run = await getWorkflowRun(runId);
      expect(run?.status).toBe("failed");
      expect(run?.error).toContain("was deleted");
    }));

  test("rejects a workflow that invokes itself", async () => {
    const self = await makeWorkflow({ nodes: [] });
    await db.updateWorkflow(self.id, { definition: parentOf(self.id) });
    const wf = await db.getWorkflow(self.id);

    const runId = await startWorkflowExecution(wf!, {}, registry);

    const run = await getWorkflowRun(runId);
    expect(run?.status).toBe("failed");
    const [step] = await getWorkflowRunStepsByRunId(runId);
    expect(step?.error).toContain("Sub-workflow recursion");
    expect(await childRunsOf(self.id)).toHaveLength(1); // only the parent run itself
  });

  test("rejects an indirect cycle through an ancestor run", async () => {
    const a = await makeWorkflow({ nodes: [] });
    const b = await makeWorkflow(parentOf(a.id));
    await db.updateWorkflow(a.id, { definition: parentOf(b.id) });
    const wfA = await db.getWorkflow(a.id);

    const runId = await startWorkflowExecution(wfA!, {}, registry);

    const run = await waitForRun(runId, isDone);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("Sub-workflow recursion");
    expect(await childRunsOf(b.id)).toHaveLength(1);
    expect(await childRunsOf(a.id)).toHaveLength(1);
  });

  test("fails closed past the max nesting depth", async () => {
    // A chain of distinct workflows, one level deeper than allowed.
    let next = await makeWorkflow(instantChild);
    for (let i = 0; i <= MAX_SUB_WORKFLOW_DEPTH; i++) next = await makeWorkflow(parentOf(next.id));
    const root = next;

    const runId = await startWorkflowExecution(root, {}, registry);

    expect((await waitForRun(runId, isDone)).status).toBe("failed");
    const rows = await getDbClient().query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM workflow_run_steps WHERE error LIKE 'Sub-workflow nesting exceeds%'",
    );
    expect(rows[0]?.n).toBe(1);
  });
});

/** A parent run with one `sub-workflow` step row, as executeStep inserts it. */
async function parentStepRow(parent: Workflow): Promise<{ runId: string; stepId: string }> {
  const runId = crypto.randomUUID();
  const stepId = crypto.randomUUID();
  await db.createWorkflowRun({ id: runId, workflowId: parent.id });
  await db.updateWorkflowRun(runId, { context: {} });
  await db.createWorkflowRunStep({
    id: stepId,
    runId,
    nodeId: "child",
    nodeType: "sub-workflow",
    idempotencyKey: `${runId}:child:0`,
  });
  return { runId, stepId };
}

/** Runs the sub-workflow executor for the step, as executeStep or the retry poller would. */
function executeChildStep(parent: Workflow, childId: string, runId: string, stepId: string) {
  return registry.get("sub-workflow").run({
    config: { workflowId: childId, inputs: { n: 1 } },
    context: {},
    meta: { runId, stepId, nodeId: "child", workflowId: parent.id, dryRun: false },
  });
}

async function setStatus(
  table: "workflow_runs" | "workflow_run_steps",
  id: string,
  status: string,
): Promise<void> {
  await getDbClient().run(`UPDATE ${table} SET status = ? WHERE id = ?`, [status, id]);
}

async function fireChildWait(childRunId: string): Promise<void> {
  const [childStep] = await getWorkflowRunStepsByRunId(childRunId);
  const wait = await getWaitStateByStepId(childStep!.id);
  await resumeWaitState(wait!.id, "fired", undefined, registry);
}

async function attemptsOf(workflowId: string): Promise<{ id: string; attempt: number }[]> {
  return getDbClient().query<{ id: string; attempt: number }>(
    "SELECT id, parentStepAttempt AS attempt FROM workflow_runs WHERE workflowId = ? ORDER BY parentStepAttempt",
    [workflowId],
  );
}

describe("sub-workflow crash recovery", () => {
  test("recovery re-claims a parent step left running and reconnects to its child", async () => {
    const child = await makeWorkflow(waitingChild);
    const parent = await makeWorkflow(parentOf(child.id));
    const runId = await startWorkflowExecution(parent, {}, registry);
    const childRun = await childRunOf(child.id, "waiting");
    const [step] = await getWorkflowRunStepsByRunId(runId);

    // The crash hit after the child committed and before the step parked.
    await setStatus("workflow_run_steps", step!.id, "running");
    await setStatus("workflow_runs", runId, "running");
    await recoverIncompleteRuns(registry);

    const steps = await getWorkflowRunStepsByRunId(runId);
    expect(steps.map((s) => [s.id, s.status, s.retryCount])).toEqual([[step!.id, "waiting", 0]]);
    expect(await childRunsOf(child.id)).toHaveLength(1);

    await fireChildWait(childRun.id);
    const run = await waitForRun(runId, isDone);
    expect(run.status).toBe("completed");
    expect((run.context?.child as { runId: string }).runId).toBe(childRun.id);
  });

  test("recovery re-claims a running parent step in a run another branch parked", async () => {
    const child = await makeWorkflow(waitingChild);
    const parent = await makeWorkflow(parentOf(child.id));
    const runId = await startWorkflowExecution(parent, {}, registry);
    await childRunOf(child.id, "waiting");
    const [step] = await getWorkflowRunStepsByRunId(runId);

    await setStatus("workflow_run_steps", step!.id, "running");
    expect((await getWorkflowRun(runId))?.status).toBe("waiting");
    await recoverIncompleteRuns(registry);

    const steps = await getWorkflowRunStepsByRunId(runId);
    expect(steps.map((s) => [s.id, s.status])).toEqual([[step!.id, "waiting"]]);
    expect(await childRunsOf(child.id)).toHaveLength(1);
  });

  test("a child committed before its walk started runs from its stored context", async () => {
    const child = await makeWorkflow(instantChild);
    const parent = await makeWorkflow(parentOf(child.id));
    const { runId, stepId } = await parentStepRow(parent);
    // What startWorkflowExecution commits for a child, with no walk after it.
    const childRunId = crypto.randomUUID();
    await getDbClient().transaction(async () => {
      await db.createWorkflowRun({
        id: childRunId,
        workflowId: child.id,
        parentStepId: stepId,
        parentStepAttempt: 0,
      });
      await db.updateWorkflowRun(childRunId, { context: { trigger: { n: 1 } } });
    });

    await recoverIncompleteRuns(registry);

    const run = await waitForRun(runId, isDone);
    expect(run.status).toBe("completed");
    const output = run.context?.child as { runId: string; outputs: Record<string, unknown> };
    expect(output.runId).toBe(childRunId);
    expect(output.outputs.check).toMatchObject({ passed: true });
    expect(await childRunsOf(child.id)).toHaveLength(1);
  });

  test("recovery fails a child run that never stored its initial context", async () => {
    const child = await makeWorkflow(instantChild);
    const parent = await makeWorkflow(parentOf(child.id));
    const { runId, stepId } = await parentStepRow(parent);
    const childRunId = crypto.randomUUID();
    await db.createWorkflowRun({ id: childRunId, workflowId: child.id, parentStepId: stepId });

    await recoverIncompleteRuns(registry);

    const childRun = await waitForRun(childRunId, isDone);
    expect(childRun.status).toBe("failed");
    expect(childRun.error).toContain("lost its initial context");
    expect(await getWorkflowRunStepsByRunId(childRunId)).toHaveLength(0);
    const run = await waitForRun(runId, isDone);
    expect(run.status).toBe("failed");
    expect(await childRunsOf(child.id)).toHaveLength(1);
  });

  test("concurrent executions of one attempt share one child", async () => {
    const child = await makeWorkflow(waitingChild);
    const parent = await makeWorkflow(parentOf(child.id));
    const { runId, stepId } = await parentStepRow(parent);

    const results = await Promise.all([
      executeChildStep(parent, child.id, runId, stepId),
      executeChildStep(parent, child.id, runId, stepId),
    ]);

    const [row] = await childRunsOf(child.id);
    expect(await childRunsOf(child.id)).toHaveLength(1);
    for (const result of results) expect(result).toMatchObject({ correlationId: row!.id });
  });

  test("a step that is no longer running starts no child", async () => {
    const child = await makeWorkflow(waitingChild);
    const parent = await makeWorkflow(parentOf(child.id));
    const { runId, stepId } = await parentStepRow(parent);
    await setStatus("workflow_run_steps", stepId, "cancelled");

    const result = await executeChildStep(parent, child.id, runId, stepId);

    expect(result.status).toBe("failed");
    expect((result as { error?: string }).error).toContain("no longer running");
    expect(await childRunsOf(child.id)).toHaveLength(0);
  });

  test("an existing child of another workflow is a conflict, not replaced", async () => {
    const child = await makeWorkflow(waitingChild);
    const other = await makeWorkflow(waitingChild);
    const parent = await makeWorkflow(parentOf(child.id));
    const { runId, stepId } = await parentStepRow(parent);
    await executeChildStep(parent, child.id, runId, stepId);

    const result = await executeChildStep(parent, other.id, runId, stepId);

    expect(result.status).toBe("failed");
    expect((result as { error?: string }).error).toContain(`not ${other.id}`);
    expect(await childRunsOf(child.id)).toHaveLength(1);
    expect(await childRunsOf(other.id)).toHaveLength(0);
  });

  test("a retry attempt starts its own child and the old one cannot settle it", () =>
    withoutListener(async () => {
      const child = await makeWorkflow(waitingChild);
      const parent = await makeWorkflow(parentOf(child.id));
      const { runId, stepId } = await parentStepRow(parent);
      await executeChildStep(parent, child.id, runId, stepId);
      const first = await childRunOf(child.id, "waiting");

      // The retry poller re-runs the same step id with retryCount bumped.
      await db.updateWorkflowRunStep(stepId, { retryCount: 1 });
      const retried = await executeChildStep(parent, child.id, runId, stepId);
      const again = await executeChildStep(parent, child.id, runId, stepId);
      const attempts = await attemptsOf(child.id);
      expect(attempts.map((a) => a.attempt)).toEqual([0, 1]);
      const second = attempts[1]!.id;
      expect(retried).toMatchObject({ correlationId: second });
      expect(again).toMatchObject({ correlationId: second });
      await waitForRun(second, (r) => r.status === "waiting");

      await setStatus("workflow_run_steps", stepId, "waiting");
      await setStatus("workflow_runs", runId, "waiting");
      await fireChildWait(first.id);
      expect((await getWorkflowRun(first.id))?.status).toBe("completed");
      expect(await resumeFromChildRun(stepId, registry)).toBe(false);
      await recoverIncompleteRuns(registry);
      expect((await db.getWorkflowRunStep(stepId))?.status).toBe("waiting");

      await fireChildWait(second);
      expect(await resumeFromChildRun(stepId, registry)).toBe(true);
      const step = await db.getWorkflowRunStep(stepId);
      expect(step?.status).toBe("completed");
      expect((step?.output as { runId: string }).runId).toBe(second);
    }));

  test("the live event and the recovery sweep settle the parent once", () =>
    withoutListener(async () => {
      const child = await makeWorkflow(waitingChild);
      const parent = await makeWorkflow(parentOf(child.id));
      const runId = await startWorkflowExecution(parent, {}, registry);
      const childRun = await childRunOf(child.id, "waiting");
      const [step] = await getWorkflowRunStepsByRunId(runId);
      await fireChildWait(childRun.id);

      const claims = await Promise.all([
        resumeFromChildRun(step!.id, registry),
        resumeFromChildRun(step!.id, registry),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      await recoverIncompleteRuns(registry);

      expect((await getWorkflowRun(runId))?.status).toBe("completed");
      expect(await getWorkflowRunStepsByRunId(runId)).toHaveLength(1);
    }));

  test("a cancelled parent run is not overwritten by its child finishing", async () => {
    const child = await makeWorkflow(waitingChild);
    const parent = await makeWorkflow(parentOf(child.id));
    const runId = await startWorkflowExecution(parent, {}, registry);
    const childRun = await childRunOf(child.id, "waiting");
    await cancelWorkflowRun(runId, "stop");
    const [step] = await getWorkflowRunStepsByRunId(runId);

    await fireChildWait(childRun.id);
    expect(await resumeFromChildRun(step!.id, registry)).toBe(false);
    await recoverIncompleteRuns(registry);

    expect((await getWorkflowRun(runId))?.status).toBe("cancelled");
    expect((await db.getWorkflowRunStep(step!.id))?.status).not.toBe("completed");
  });
});

/** Retries at once, so the poller picks the step up on its next tick. */
const immediateRetry = {
  maxRetries: 1,
  strategy: "static",
  baseDelayMs: 0,
  maxDelayMs: 0,
} as const;

/** A child that parks on a wait and then fails, so it fails after the parent step parked. */
const failsAfterParkChild: WorkflowDefinition = {
  nodes: [
    { id: "pause", type: "wait", config: { mode: "time", durationMs: 3_600_000 }, next: "bad" },
    { id: "bad", type: "property-match", config: { conditions: [] } },
  ],
};

function retryingParentOf(childId: string): WorkflowDefinition {
  const def = parentOf(childId);
  def.nodes[0]!.retry = { ...immediateRetry };
  return def;
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 250; i++) {
    const value = await read();
    if (done(value)) return value;
    await Bun.sleep(20);
  }
  throw new Error("condition not reached");
}

describe("sub-workflow attempts", () => {
  test("a stale execution writes nothing over a cancelled step", async () => {
    // Cancels the parent run while the child is being prepared, as a user
    // cancel landing mid-execution would.
    class CancelFirstExecutor extends SubWorkflowExecutor {
      override async run(input: ExecutorInput) {
        await cancelWorkflowRun(input.meta.runId, "stop");
        return super.run(input);
      }
    }
    const cancelRegistry = createExecutorRegistry(deps);
    cancelRegistry.register(new CancelFirstExecutor(deps, cancelRegistry));
    const child = await makeWorkflow(waitingChild);
    const parent = await makeWorkflow(retryingParentOf(child.id));

    const runId = await startWorkflowExecution(parent, {}, cancelRegistry);

    expect((await getWorkflowRun(runId))?.status).toBe("cancelled");
    const [step] = await getWorkflowRunStepsByRunId(runId);
    expect(step?.status).toBe("cancelled");
    expect(step?.retryCount).toBe(0);
    expect(step?.nextRetryAt ?? null).toBeNull();
    expect(await childRunsOf(child.id)).toHaveLength(0);
  });

  test("a child cancelled before the step parked is not retried either", async () => {
    // The cancel lands between the child's creation and the executor's read,
    // so the executor settles the cancelled child synchronously.
    class CancelChildExecutor extends SubWorkflowExecutor {
      override async run(input: ExecutorInput) {
        const started = await super.run(input);
        const { correlationId } = started as { correlationId?: string };
        if (correlationId) await cancelWorkflowRun(correlationId, "stop");
        return super.run(input);
      }
    }
    const cancelRegistry = createExecutorRegistry(deps);
    cancelRegistry.register(new CancelChildExecutor(deps, cancelRegistry));
    const child = await makeWorkflow(waitingChild);
    const parent = await makeWorkflow(retryingParentOf(child.id));

    const runId = await startWorkflowExecution(parent, {}, cancelRegistry);

    const run = await waitForRun(runId, isDone);
    expect(run.status).toBe("failed");
    const [step] = await getWorkflowRunStepsByRunId(runId);
    expect(step?.error).toContain("cancelled");
    expect(step?.retryCount).toBe(0);
    expect(step?.nextRetryAt ?? null).toBeNull();
    expect(await childRunsOf(child.id)).toHaveLength(1);
  });

  test("a stale failure does not write its output", async () => {
    class CancelThenFailExecutor extends BaseExecutor<z.ZodObject, z.ZodObject> {
      readonly type = "test-cancel-then-fail";
      readonly mode = "instant" as const;
      readonly configSchema = z.object({});
      readonly outputSchema = z.object({});

      protected async execute(
        _config: Record<string, never>,
        _context: Readonly<Record<string, unknown>>,
        meta: ExecutorInput["meta"],
      ): Promise<ExecutorResult<Record<string, never>>> {
        await cancelWorkflowRun(meta.runId, "stop");
        return { status: "failed", error: "boom", output: { late: true } as never };
      }
    }
    const staleRegistry = createExecutorRegistry(deps);
    staleRegistry.register(new CancelThenFailExecutor(deps));
    const wf = await makeWorkflow({
      nodes: [{ id: "x", type: "test-cancel-then-fail", config: {} }],
    });

    const runId = await startWorkflowExecution(wf, {}, staleRegistry);

    const [step] = await getWorkflowRunStepsByRunId(runId);
    expect(step?.status).toBe("cancelled");
    expect(step?.output).toBeUndefined();
    expect((await getWorkflowRun(runId))?.status).toBe("cancelled");
  });

  test("a child failing after the step parked is retried as a new attempt", async () => {
    const child = await makeWorkflow(failsAfterParkChild);
    const parent = await makeWorkflow(retryingParentOf(child.id));
    startRetryPoller(registry, 20);
    try {
      const runId = await startWorkflowExecution(parent, {}, registry);
      const first = await childRunOf(child.id, "waiting");
      const [step] = await getWorkflowRunStepsByRunId(runId);

      await fireChildWait(first.id);

      const attempts = await waitFor(
        () => attemptsOf(child.id),
        (rows) => rows.length === 2,
      );
      expect(attempts.map((a) => a.attempt)).toEqual([0, 1]);
      expect((await getWorkflowRun(first.id))?.status).toBe("failed");
      const second = await waitForRun(attempts[1]!.id, (r) => r.status === "waiting");
      const parked = await waitFor(
        () => db.getWorkflowRunStep(step!.id),
        (row) => row?.status === "waiting",
      );
      expect(parked?.retryCount).toBe(1);
      expect(await getWorkflowRunStepsByRunId(runId)).toHaveLength(1);

      // The last attempt failing exhausts the policy and fails the run.
      await fireChildWait(second.id);
      const run = await waitForRun(runId, isDone);
      expect(run.status).toBe("failed");
      expect(run.error).toContain(second.id);
      expect(await childRunsOf(child.id)).toHaveLength(2);
    } finally {
      stopRetryPoller();
    }
  });

  test("a cancelled child is not retried", async () => {
    const child = await makeWorkflow(waitingChild);
    const parent = await makeWorkflow(retryingParentOf(child.id));
    const runId = await startWorkflowExecution(parent, {}, registry);
    const childRun = await childRunOf(child.id, "waiting");

    await cancelWorkflowRun(childRun.id, "stop");

    const run = await waitForRun(runId, isDone);
    expect(run.status).toBe("failed");
    const [step] = await getWorkflowRunStepsByRunId(runId);
    expect(step?.retryCount).toBe(0);
    expect(await childRunsOf(child.id)).toHaveLength(1);
  });

  test("runs expose the parent step attempt", async () => {
    const child = await makeWorkflow(waitingChild);
    const parent = await makeWorkflow(parentOf(child.id));
    const { runId, stepId } = await parentStepRow(parent);
    await executeChildStep(parent, child.id, runId, stepId);
    await db.updateWorkflowRunStep(stepId, { retryCount: 1 });
    await executeChildStep(parent, child.id, runId, stepId);

    const [first, second] = await attemptsOf(child.id);
    expect(await getWorkflowRun(first!.id, "display")).toMatchObject({
      parentStepId: stepId,
      parentStepAttempt: 0,
    });
    expect((await getWorkflowRun(second!.id, "display"))?.parentStepAttempt).toBe(1);
    expect((await getWorkflowRun(runId))?.parentStepAttempt).toBeUndefined();

    const page = await db.listWorkflowRunsPage(child.id, { limit: 10, offset: 0 });
    expect(
      page.runs
        .map((r) => [r.parentStepId, r.parentStepAttempt])
        .sort((a, b) => Number(a[1]) - Number(b[1])),
    ).toEqual([
      [stepId, 0],
      [stepId, 1],
    ]);
  });

  test("a child that needs setup keeps its parent link and attempt", async () => {
    const notify = spyOn(preflightAlerts, "notifyAutomationPreflightFailure").mockResolvedValue(
      undefined,
    );
    try {
      const child = await createWorkflow({
        name: `wf-${crypto.randomUUID()}`,
        definition: instantChild,
        requiredParams: ["REPO_URL"],
      });
      const parent = await makeWorkflow(parentOf(child.id));

      const runId = await startWorkflowExecution(parent, {}, registry);

      expect((await waitForRun(runId, isDone)).status).toBe("failed");
      const [step] = await getWorkflowRunStepsByRunId(runId);
      const [linked] = await childRunsOf(child.id);
      const linkedRun = await getWorkflowRun(linked!.id);
      expect(linkedRun).toMatchObject({ parentStepId: step!.id, parentStepAttempt: 0 });
      expect(linkedRun?.status).toBe("failed");
      expect(linkedRun?.error).toStartWith("needs_setup:");
      expect(step?.error).toContain(linked!.id);

      // A top-level trigger records its own unlinked failure, and the day's
      // alert already went out.
      const topLevel = await startWorkflowExecution(child, {}, registry);
      expect(topLevel).not.toBe(linked!.id);
      expect((await getWorkflowRun(topLevel))?.parentStepId).toBeUndefined();
      expect(notify).toHaveBeenCalledTimes(1);
    } finally {
      notify.mockRestore();
    }
  });

  test("concurrent child setup failures alert exactly once", async () => {
    const notify = spyOn(preflightAlerts, "notifyAutomationPreflightFailure").mockResolvedValue(
      undefined,
    );
    try {
      const child = await createWorkflow({
        name: `wf-${crypto.randomUUID()}`,
        definition: instantChild,
        requiredParams: ["REPO_URL"],
      });
      // Two entry nodes run in parallel, so both failures race for the alert.
      const parent = await makeWorkflow({
        nodes: ["a", "b"].map((id) => ({
          id,
          type: "sub-workflow",
          config: { workflowId: child.id, inputs: { n: 1 } },
        })),
      });

      const runId = await startWorkflowExecution(parent, {}, registry);

      expect((await waitForRun(runId, isDone)).status).toBe("failed");
      expect(await childRunsOf(child.id)).toHaveLength(2);
      expect(notify).toHaveBeenCalledTimes(1);
    } finally {
      notify.mockRestore();
    }
  });

  test("a legacy child started on a later attempt survives the upgrade", () =>
    withoutListener(async () => {
      // On main before migration 240: attempt 0 failed before starting a child
      // (say, the child workflow was disabled), attempt 1 started it and parked.
      const child = await makeWorkflow(waitingChild);
      const parent = await makeWorkflow(parentOf(child.id));
      const { runId, stepId } = await parentStepRow(parent);
      await db.updateWorkflowRunStep(stepId, { retryCount: 1 });
      await executeChildStep(parent, child.id, runId, stepId);
      await setStatus("workflow_run_steps", stepId, "waiting");
      await setStatus("workflow_runs", runId, "waiting");
      const childRun = await childRunOf(child.id, "waiting");
      // The column default the upgrade gives every legacy child.
      await getDbClient().run("UPDATE workflow_runs SET parentStepAttempt = 0 WHERE id = ?", [
        childRun.id,
      ]);

      // The backfill statement of migration 240, scoped to this child: the
      // shared test database also holds post-migration multi-attempt children,
      // which a real legacy database cannot have.
      const migration = await Bun.file(
        "src/be/migrations/240_workflow_run_parent_step_attempt.sql",
      ).text();
      const start = migration.indexOf("UPDATE workflow_runs");
      const backfill = migration.slice(start, migration.indexOf(";", start));
      await getDbClient().run(`${backfill} AND workflow_runs.id = ?`, [childRun.id]);
      await recoverIncompleteRuns(registry);

      expect((await getWorkflowRun(runId))?.status).toBe("waiting");
      expect((await db.getWorkflowRunStep(stepId))?.status).toBe("waiting");
      await fireChildWait(childRun.id);
      expect(await resumeFromChildRun(stepId, registry)).toBe(true);
      expect((await getWorkflowRun(runId))?.status).toBe("completed");
      expect(await childRunsOf(child.id)).toHaveLength(1);
    }));
});
