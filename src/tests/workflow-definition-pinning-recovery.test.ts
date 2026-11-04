import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import * as db from "../be/db";
import {
  closeDb,
  completeTask,
  createAgent,
  createWorkflow,
  createWorkflowRun,
  createWorkflowRunStep,
  failTask,
  getDbClient,
  getTaskByWorkflowRunStepId,
  getWaitStateByStepId,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
  pinWorkflowDefinition,
  resolveApprovalRequest,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import type {
  ExecutorMeta,
  Workflow,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunStep,
} from "../types";
import { startWorkflowExecution } from "../workflows/engine";
import { workflowEventBus } from "../workflows/event-bus";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import { createExecutorRegistry } from "../workflows/executors/registry";
import { drainForeachDrives, runForeachDrive } from "../workflows/foreach-driver";
import { recoverIncompleteRuns } from "../workflows/recovery";
import { resumeWaitState, setupWorkflowResumeListener } from "../workflows/resume";
import { snapshotAndUpdateWorkflow } from "../workflows/version";

// Each test starts a run on definition A, edits the workflow to B through the
// real edit path, then triggers one resume or recovery path. A routes the
// resumed node to `a2` (or a renamed node) with A's config; B routes it to
// `b2` with B's config. Every step after the edit must follow A.

const TEST_DB_PATH = "./test-workflow-definition-pinning-recovery.sqlite";

const deps: ExecutorDependencies = {
  db,
  eventBus: workflowEventBus,
  interpolate: (t: string) => t,
};
const registry = createExecutorRegistry(deps);

/** Every `test-record` execution: which run, which node, which config value. */
const records: Array<{ runId: string; nodeId: string; value: string }> = [];

class RecordExecutor extends BaseExecutor<z.ZodObject, z.ZodObject> {
  readonly type = "test-record";
  readonly mode = "instant" as const;
  readonly configSchema = z.object({ value: z.string() });
  readonly outputSchema = z.object({ value: z.string() });

  protected async execute(
    config: { value: string },
    _context: Readonly<Record<string, unknown>>,
    meta: ExecutorMeta,
  ): Promise<ExecutorResult<{ value: string }>> {
    records.push({ runId: meta.runId, nodeId: meta.nodeId, value: config.value });
    return { status: "success", output: { value: config.value } };
  }
}
registry.register(new RecordExecutor(deps));

/** An approval node that only opens a request; nothing delivers its resolution live. */
class MockApprovalExecutor extends BaseExecutor<z.ZodObject, z.ZodObject> {
  readonly type = "test-approval";
  readonly mode = "async" as const;
  readonly configSchema = z.object({ title: z.string() });
  readonly outputSchema = z.object({
    requestId: z.string(),
    status: z.string(),
    responses: z.record(z.string(), z.unknown()).nullable(),
  });
  lastRequestId: string | null = null;

  protected async execute(
    config: { title: string },
    _context: Readonly<Record<string, unknown>>,
    meta: ExecutorMeta,
  ): Promise<ExecutorResult<Record<string, unknown>>> {
    const requestId = crypto.randomUUID();
    this.lastRequestId = requestId;
    await this.deps.db.createApprovalRequest({
      id: requestId,
      title: config.title,
      questions: [{ id: "q1", type: "approval", label: "Approve?", required: true }],
      approvers: { policy: "any" as const },
      workflowRunId: meta.runId,
      workflowRunStepId: meta.stepId,
    });
    return {
      status: "success",
      async: true,
      waitFor: "approval.resolved",
      correlationId: requestId,
    } as unknown as ExecutorResult<Record<string, unknown>>;
  }
}
const approvalExecutor = new MockApprovalExecutor(deps);
registry.register(approvalExecutor);

let teardown: (() => void) | undefined;
let agentId: string;

/** Runs `fn` with the live resume listener off, as after a crash, then turns it back on. */
async function withoutListener(fn: () => Promise<void>): Promise<void> {
  teardown?.();
  teardown = undefined;
  try {
    await fn();
  } finally {
    teardown = setupWorkflowResumeListener(workflowEventBus, registry);
  }
}

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  agentId = (await createAgent({ name: "Pinning recovery", status: "idle" })).id;
  teardown = setupWorkflowResumeListener(workflowEventBus, registry);
});

afterAll(async () => {
  teardown?.();
  await drainForeachDrives();
  closeDb();
  await removeDbFiles();
});

// ─── Helpers ─────────────────────────────────────────────────

function makeWorkflow(definition: WorkflowDefinition): Promise<Workflow> {
  return createWorkflow({ name: `pin-recovery-${crypto.randomUUID()}`, definition });
}

/** Edit through the function behind HTTP PUT and the `update-workflow` tool. */
async function editTo(workflowId: string, definition: WorkflowDefinition): Promise<void> {
  const { workflow } = await snapshotAndUpdateWorkflow(workflowId, { definition });
  expect(workflow?.definition).toEqual(definition);
}

function record(id: string, value: string): WorkflowDefinition["nodes"][number] {
  return { id, type: "test-record", config: { value } };
}

async function nodeIds(runId: string): Promise<string[]> {
  return (await getWorkflowRunStepsByRunId(runId)).map((step) => step.nodeId);
}

function recordsOf(runId: string): Array<[string, string]> {
  return records.filter((r) => r.runId === runId).map((r) => [r.nodeId, r.value]);
}

async function stepOf(runId: string, nodeId: string): Promise<WorkflowRunStep> {
  const step = (await getWorkflowRunStepsByRunId(runId)).find((s) => s.nodeId === nodeId);
  if (!step) throw new Error(`no step ${nodeId} in run ${runId}`);
  return step;
}

async function waitForRun(
  runId: string,
  done: (run: WorkflowRun) => boolean,
  timeoutMs = 3_000,
): Promise<WorkflowRun> {
  const deadline = Date.now() + timeoutMs;
  let run: WorkflowRun | null = null;
  while (Date.now() < deadline) {
    run = await getWorkflowRun(runId);
    if (run && done(run)) return run;
    await Bun.sleep(10);
  }
  throw new Error(`run ${runId} did not settle; last status ${run?.status} ${run?.error}`);
}

const isDone = (run: WorkflowRun) => run.status !== "running" && run.status !== "waiting";

async function waitForStep(stepId: string, status: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if ((await db.getWorkflowRunStep(stepId))?.status === status) return;
    await Bun.sleep(10);
  }
  throw new Error(`step ${stepId} never reached ${status}`);
}

async function childRunOf(workflowId: string, status: string): Promise<WorkflowRun> {
  for (let i = 0; i < 150; i++) {
    const row = await getDbClient().get<{ id: string }>(
      "SELECT id FROM workflow_runs WHERE workflowId = ?",
      [workflowId],
    );
    if (row) return waitForRun(row.id, (r) => r.status === status);
    await Bun.sleep(20);
  }
  throw new Error(`no child run of ${workflowId}`);
}

async function fireWait(runId: string, nodeId: string): Promise<void> {
  const wait = await getWaitStateByStepId((await stepOf(runId, nodeId)).id);
  await resumeWaitState(wait!.id, "fired", undefined, registry);
}

async function taskOf(runId: string, nodeId: string) {
  const task = await getTaskByWorkflowRunStepId((await stepOf(runId, nodeId)).id);
  if (!task) throw new Error(`no task for ${nodeId}`);
  return task;
}

const longWait = { mode: "time", durationMs: 3_600_000 };

function subWorkflowParent(childId: string, successor: string, value: string): WorkflowDefinition {
  return {
    nodes: [
      {
        id: "child",
        type: "sub-workflow",
        config: { workflowId: childId, inputs: { n: 1 } },
        next: successor,
      },
      record(successor, value),
    ],
  };
}

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(TEST_DB_PATH + suffix).catch(() => {});
  }
}

// ─── Tests ───────────────────────────────────────────────────

describe("child completion", () => {
  test("child finishes on A′ and the parent resumes on A after both are edited", async () => {
    const childA: WorkflowDefinition = {
      nodes: [{ id: "pause", type: "wait", config: longWait, next: "c2a" }, record("c2a", "A′")],
    };
    const childB: WorkflowDefinition = {
      nodes: [{ id: "pause", type: "wait", config: longWait, next: "c2b" }, record("c2b", "B′")],
    };
    const child = await makeWorkflow(childA);
    const parent = await makeWorkflow(subWorkflowParent(child.id, "a2", "A"));

    const runId = await startWorkflowExecution(parent, {}, registry);
    const childRun = await childRunOf(child.id, "waiting");

    await editTo(parent.id, subWorkflowParent(child.id, "b2", "B"));
    await editTo(child.id, childB);
    await fireWait(childRun.id, "pause");

    expect((await waitForRun(runId, isDone)).status).toBe("completed");
    expect((await getWorkflowRun(childRun.id))?.status).toBe("completed");
    expect(await nodeIds(childRun.id)).toEqual(["pause", "c2a"]);
    expect(recordsOf(childRun.id)).toEqual([["c2a", "A′"]]);
    expect(await nodeIds(runId)).toEqual(["child", "a2"]);
    expect(recordsOf(runId)).toEqual([["a2", "A"]]);
  });
});

describe("foreach", () => {
  // B renames the foreach node itself: with a live read the late outcome and
  // the queued item have no parent in the definition and are dropped.
  function fanOut(
    id: string,
    template: string,
    successor: string,
    value: string,
    extra: Record<string, unknown> = {},
  ): WorkflowDefinition {
    return {
      nodes: [
        {
          id,
          type: "foreach",
          config: {
            over: [{ id: "a" }, { id: "b" }],
            itemKey: "id",
            body: { type: "agent-task", config: { agentId, template } },
            ...extra,
          },
          next: successor,
        },
        record(successor, value),
      ],
    };
  }

  test("a late item outcome on a failed fail-fast run settles on A's foreach", async () => {
    const workflow = await makeWorkflow(
      fanOut("fan", "A item", "a2", "A", { failurePolicy: "fail-fast" }),
    );
    const runId = await startWorkflowExecution(workflow, {}, registry);
    await drainForeachDrives();
    const first = await taskOf(runId, "fan#a");
    const second = await taskOf(runId, "fan#b");
    await failTask(first.id, "a failed");
    await waitForRun(runId, (r) => r.status === "failed");
    expect((await stepOf(runId, "fan#b")).status).toBe("waiting");

    await editTo(workflow.id, fanOut("fanB", "B item", "b2", "B", { failurePolicy: "fail-fast" }));
    await completeTask(second.id, "b finished late");
    await waitForStep((await stepOf(runId, "fan#b")).id, "completed");

    expect((await getWorkflowRun(runId))?.status).toBe("failed");
    expect((await nodeIds(runId)).sort()).toEqual(["fan", "fan#a", "fan#b"]);
    expect(recordsOf(runId)).toEqual([]);
  });

  test("the driver dispatches queued items and joins on A after an edit", async () => {
    const workflow = await makeWorkflow(fanOut("fan", "A item", "a2", "A", { concurrency: 1 }));
    const runId = await startWorkflowExecution(workflow, {}, registry);
    await drainForeachDrives();
    expect((await stepOf(runId, "fan#b")).status).toBe("pending");

    // B keeps the node id and changes the body config and the successor.
    await editTo(workflow.id, fanOut("fan", "B item", "b2", "B", { concurrency: 1 }));
    await completeTask((await taskOf(runId, "fan#a")).id, "a ok");
    await waitForStep((await stepOf(runId, "fan#a")).id, "completed");
    await drainForeachDrives();
    // The settle's drive dispatched the queued item from A's body.
    const queued = await taskOf(runId, "fan#b");
    expect(queued.task).toBe("A item");

    await completeTask(queued.id, "b ok");
    await waitForStep((await stepOf(runId, "fan#b")).id, "completed");
    await drainForeachDrives();
    // A direct drive after the join claims nothing more.
    expect((await runForeachDrive(runId, "fan", registry)).claimed).toBe(0);

    expect((await waitForRun(runId, isDone)).status).toBe("completed");
    expect((await nodeIds(runId)).sort()).toEqual(["a2", "fan", "fan#a", "fan#b"]);
    expect(recordsOf(runId)).toEqual([["a2", "A"]]);
  });

  test("an exact-cap fan-out is allowed when A's foreach has no successor", async () => {
    const terminal = (template: string): WorkflowDefinition => ({
      nodes: [
        { id: "n1", type: "wait", config: longWait, next: "fan" },
        {
          id: "fan",
          type: "foreach",
          config: {
            over: [{ id: "a" }, { id: "b" }],
            itemKey: "id",
            body: { type: "test-record", config: { value: template } },
          },
        },
      ],
    });
    const workflowB = terminal("B item");
    workflowB.nodes[1]!.next = "b2";
    workflowB.nodes.push(record("b2", "B"));

    const workflow = await makeWorkflow(terminal("A item"));
    const runId = await startWorkflowExecution(workflow, {}, registry);
    await editTo(workflow.id, workflowB);

    // n1 + fan + 2 items = 4: allowed for a terminal foreach, refused with a successor.
    const previous = process.env.WORKFLOW_MAX_STEPS_PER_RUN;
    process.env.WORKFLOW_MAX_STEPS_PER_RUN = "4";
    try {
      await fireWait(runId, "n1");
      await drainForeachDrives();
      const run = await waitForRun(runId, isDone);
      expect(run.error).toBeUndefined();
      expect(run.status).toBe("completed");
    } finally {
      if (previous === undefined) delete process.env.WORKFLOW_MAX_STEPS_PER_RUN;
      else process.env.WORKFLOW_MAX_STEPS_PER_RUN = previous;
    }
    expect((await nodeIds(runId)).sort()).toEqual(["fan", "fan#a", "fan#b", "n1"]);
    expect(recordsOf(runId).map(([, value]) => value)).toEqual(["A item", "A item"]);
  });
});

describe("restart recovery", () => {
  const twoStep = (successor: string, value: string): WorkflowDefinition => ({
    nodes: [{ ...record("n1", "first"), next: successor }, record(successor, value)],
  });

  test("a running run interrupted after n1 walks on A", async () => {
    const workflow = await makeWorkflow(twoStep("a2", "A"));
    // What startWorkflowExecution commits, then a crash after n1's checkpoint.
    const runId = crypto.randomUUID();
    await createWorkflowRun({
      id: runId,
      workflowId: workflow.id,
      triggerType: "manual",
      definitionHash: await pinWorkflowDefinition(workflow),
    });
    await updateWorkflowRun(runId, { context: { n1: { value: "first" } } });
    const stepId = crypto.randomUUID();
    await createWorkflowRunStep({ id: stepId, runId, nodeId: "n1", nodeType: "test-record" });
    await updateWorkflowRunStep(stepId, {
      status: "completed",
      output: { value: "first" },
      finishedAt: new Date().toISOString(),
    });

    await editTo(workflow.id, twoStep("b2", "B"));
    await recoverIncompleteRuns(registry);

    expect((await waitForRun(runId, isDone)).status).toBe("completed");
    expect(await nodeIds(runId)).toEqual(["n1", "a2"]);
    expect(recordsOf(runId)).toEqual([["a2", "A"]]);
  });

  test("a sub-workflow step left running in a parked run reconnects and walks on A", async () => {
    const child = await makeWorkflow({
      nodes: [{ id: "pause", type: "wait", config: longWait }],
    });
    // A second branch parks the run in `waiting`, the shape the running-run case misses.
    const parked = (successor: string, value: string): WorkflowDefinition => {
      const def = subWorkflowParent(child.id, successor, value);
      def.nodes.push({ id: "hold", type: "wait", config: longWait });
      return def;
    };
    const parent = await makeWorkflow(parked("a2", "A"));
    const runId = await startWorkflowExecution(parent, {}, registry);
    const childRun = await childRunOf(child.id, "waiting");
    const parentStep = await stepOf(runId, "child");

    await withoutListener(async () => {
      // The child finishes while nothing listens; the crash left the parent step running.
      await fireWait(childRun.id, "pause");
      await waitForRun(childRun.id, isDone);
      await getDbClient().run("UPDATE workflow_run_steps SET status = 'running' WHERE id = ?", [
        parentStep.id,
      ]);
      expect((await getWorkflowRun(runId))?.status).toBe("waiting");

      await editTo(parent.id, parked("b2", "B"));
      await recoverIncompleteRuns(registry);
    });

    const steps = await getWorkflowRunStepsByRunId(runId);
    expect(steps.map((s) => [s.nodeId, s.status]).sort()).toEqual([
      ["a2", "completed"],
      ["child", "completed"],
      ["hold", "waiting"],
    ]);
    expect(recordsOf(runId)).toEqual([["a2", "A"]]);
  });

  test("a waiting agent-task step whose task finished during downtime resumes on A", async () => {
    const def = (successor: string, value: string): WorkflowDefinition => ({
      nodes: [
        { id: "n1", type: "agent-task", config: { agentId, template: "work" }, next: successor },
        record(successor, value),
      ],
    });
    const workflow = await makeWorkflow(def("a2", "A"));
    const runId = await startWorkflowExecution(workflow, {}, registry);
    expect((await getWorkflowRun(runId))?.status).toBe("waiting");

    await withoutListener(async () => {
      await completeTask((await taskOf(runId, "n1")).id, "done while down");
      await editTo(workflow.id, def("b2", "B"));
      await recoverIncompleteRuns(registry);
    });

    expect((await waitForRun(runId, isDone)).status).toBe("completed");
    expect(await nodeIds(runId)).toEqual(["n1", "a2"]);
    expect(recordsOf(runId)).toEqual([["a2", "A"]]);
  });

  test("an approval resolved during downtime routes on A", async () => {
    const def = (successor: string, value: string): WorkflowDefinition => ({
      nodes: [
        {
          id: "review",
          type: "test-approval",
          config: { title: "Review" },
          next: { approved: successor, rejected: successor, timeout: successor },
        },
        record(successor, value),
      ],
    });
    const workflow = await makeWorkflow(def("a2", "A"));
    const runId = await startWorkflowExecution(workflow, {}, registry);
    const requestId = approvalExecutor.lastRequestId!;
    expect((await getWorkflowRun(runId))?.status).toBe("waiting");

    await withoutListener(async () => {
      await resolveApprovalRequest(requestId, { status: "approved", responses: { q1: true } });
      await editTo(workflow.id, def("b2", "B"));
      await recoverIncompleteRuns(registry);
    });

    expect((await waitForRun(runId, isDone)).status).toBe("completed");
    expect(await nodeIds(runId)).toEqual(["review", "a2"]);
    expect(recordsOf(runId)).toEqual([["a2", "A"]]);
  });

  test("a foreach fan-out with a queued item is re-driven on A", async () => {
    const def = (id: string, template: string, successor: string, value: string) => ({
      nodes: [
        {
          id,
          type: "foreach",
          config: {
            over: [{ id: "a" }, { id: "b" }],
            itemKey: "id",
            concurrency: 1,
            body: { type: "agent-task", config: { agentId, template } },
          },
          next: successor,
        },
        record(successor, value),
      ],
    });
    const workflow = await makeWorkflow(def("fan", "A item", "a2", "A"));
    const runId = await startWorkflowExecution(workflow, {}, registry);
    await drainForeachDrives();
    const first = await taskOf(runId, "fan#a");
    expect((await stepOf(runId, "fan#b")).status).toBe("pending");

    // The first item's settlement committed, then the API stopped before the next drive.
    await withoutListener(async () => {
      await completeTask(first.id, "a ok");
      await updateWorkflowRunStep((await stepOf(runId, "fan#a")).id, {
        status: "completed",
        output: { taskId: first.id, taskOutput: "a ok" },
        finishedAt: new Date().toISOString(),
      });
      await editTo(workflow.id, def("fanB", "B item", "b2", "B"));
      await recoverIncompleteRuns(registry);
      await drainForeachDrives();
    });

    const queued = await taskOf(runId, "fan#b");
    expect(queued.task).toBe("A item");
    await completeTask(queued.id, "b ok");
    expect((await waitForRun(runId, isDone)).status).toBe("completed");
    expect((await nodeIds(runId)).sort()).toEqual(["a2", "fan", "fan#a", "fan#b"]);
    expect(recordsOf(runId)).toEqual([["a2", "A"]]);
  });
});
