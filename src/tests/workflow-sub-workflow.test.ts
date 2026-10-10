import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { z } from "zod";
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
  resumeWaitState,
  setupWorkflowResumeListener,
} from "../workflows/resume";

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
