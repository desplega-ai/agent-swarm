import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer } from "node:http";
import * as db from "../be/db";
import {
  closeDb,
  createTaskExtended,
  createWorkflow,
  createWorkflowRun,
  createWorkflowRunStep,
  getDbClient,
  getTaskById,
  getWaitStateByStepId,
  getWorkflowRun,
  getWorkflowRunStep,
  getWorkflowRunStepsByRunId,
  initDb,
  startTask,
} from "../be/db";
import * as workflowRuns from "../be/db/workflow-runs";
import {
  getRunLineageBlock,
  getWorkflowRunTreeIds,
  WORKFLOW_RUN_TREE_MAX_DEPTH,
  WorkflowRunTreeError,
  WorkflowStepNotExecutableError,
} from "../be/db/workflow-runs";
import { handleApprovalRequests } from "../http/approval-requests";
import { handleWorkflows } from "../http/workflows";
import * as slackApp from "../slack/app";
import type { AgentTask, Workflow, WorkflowDefinition, WorkflowRun } from "../types";
import * as approvalNotifications from "../workflows/approval-notifications";
import { startWorkflowExecution } from "../workflows/engine";
import { workflowEventBus } from "../workflows/event-bus";
import { AgentTaskExecutor } from "../workflows/executors/agent-task";
import type { ExecutorDependencies, ExecutorInput } from "../workflows/executors/base";
import { createExecutorRegistry } from "../workflows/executors/registry";
import { MAX_SUB_WORKFLOW_DEPTH, SubWorkflowExecutor } from "../workflows/executors/sub-workflow";
import { recoverIncompleteRuns } from "../workflows/recovery";
import {
  cancelWorkflowRun,
  finalizeOrWait,
  resumeFromChildRun,
  resumeWaitState,
  retryFailedRun,
  setupWorkflowResumeListener,
} from "../workflows/resume";
import { startRetryPoller, stopRetryPoller } from "../workflows/retry-poller";
import {
  checkpointPortStepAndResolveSuccessors,
  completeTaskStepAndResolveSuccessors,
  scheduleTaskStepRetry,
} from "../workflows/task-step-routing";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-workflow-cascade-cancel.sqlite";

const deps: ExecutorDependencies = {
  db,
  eventBus: workflowEventBus,
  interpolate: (t: string) => t,
};
const registry = createExecutorRegistry(deps);
let teardown: (() => void) | undefined;

beforeAll(() => {
  initDb(TEST_DB_PATH);
  teardown = setupWorkflowResumeListener(workflowEventBus, registry);
});

afterEach(() => {
  stopRetryPoller();
});

afterAll(async () => {
  teardown?.();
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
});

// ─── Fixtures ────────────────────────────────────────────────

async function makeWorkflow(def: WorkflowDefinition): Promise<Workflow> {
  return createWorkflow({ name: `wf-${crypto.randomUUID()}`, definition: def });
}

/** Parks on a long time wait, so the run stays `waiting`. */
const waitingDef: WorkflowDefinition = {
  nodes: [{ id: "pause", type: "wait", config: { mode: "time", durationMs: 3_600_000 } }],
};

/** Dispatches one agent task and waits for it. */
const taskDef: WorkflowDefinition = {
  nodes: [{ id: "work", type: "agent-task", config: { template: "do the work" } }],
};

/** Asks for one approval and waits for it. */
const approvalDef: WorkflowDefinition = {
  nodes: [
    {
      id: "review",
      type: "human-in-the-loop",
      config: {
        title: "Ship it?",
        questions: [{ id: "ok", type: "approval", label: "Ship?" }],
        approvers: { policy: "any" },
      },
    },
  ],
};

/** One `sub-workflow` entry node per child workflow, so siblings start in parallel. */
function parentOf(...childIds: string[]): WorkflowDefinition {
  return {
    nodes: childIds.map((workflowId, i) => ({
      id: `child${i}`,
      type: "sub-workflow",
      config: { workflowId, inputs: {} },
    })),
  };
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 250; i++) {
    const value = await read();
    if (done(value)) return value;
    await Bun.sleep(20);
  }
  throw new Error("condition not reached");
}

async function runsOf(workflowId: string): Promise<WorkflowRun[]> {
  const rows = await getDbClient().query<{ id: string }>(
    "SELECT id FROM workflow_runs WHERE workflowId = ? ORDER BY rowid",
    [workflowId],
  );
  const runs: WorkflowRun[] = [];
  for (const row of rows) runs.push((await getWorkflowRun(row.id, "display"))!);
  return runs;
}

/** The one run of `workflowId`, once it reaches `status`. */
async function runOf(workflowId: string, status: string): Promise<WorkflowRun> {
  const [run] = await waitFor(
    () => runsOf(workflowId),
    (runs) => runs.length === 1 && runs[0]!.status === status,
  );
  return run!;
}

async function status(runId: string): Promise<string | undefined> {
  return (await getWorkflowRun(runId, "display"))?.status;
}

async function tasksOfRun(runId: string): Promise<AgentTask[]> {
  const rows = await getDbClient().query<{ id: string }>(
    "SELECT id FROM agent_tasks WHERE workflowRunId = ? ORDER BY rowid",
    [runId],
  );
  const tasks: AgentTask[] = [];
  for (const row of rows) tasks.push((await getTaskById(row.id))!);
  return tasks;
}

/** Raw status write: no events, as a crash or an older release left the row. */
async function setStatus(
  table: "workflow_runs" | "workflow_run_steps",
  id: string,
  value: string,
): Promise<void> {
  await getDbClient().run(`UPDATE ${table} SET status = ? WHERE id = ?`, [value, id]);
}

/**
 * A run row with a stored parent link, for trees the engine cannot be driven
 * into deterministically (historical attempts, state an older release left).
 */
async function linkedRun(input: {
  workflowId: string;
  status: string;
  parentStepId?: string;
  parentStepAttempt?: number;
  error?: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  await createWorkflowRun({
    id,
    workflowId: input.workflowId,
    parentStepId: input.parentStepId,
    parentStepAttempt: input.parentStepAttempt,
  });
  await getDbClient().run("UPDATE workflow_runs SET status = ?, error = ? WHERE id = ?", [
    input.status,
    input.error ?? null,
    id,
  ]);
  return id;
}

async function linkedStep(
  runId: string,
  input: { nodeId: string; nodeType: string; status: string; retryCount?: number },
): Promise<string> {
  const id = crypto.randomUUID();
  await createWorkflowRunStep({ id, runId, nodeId: input.nodeId, nodeType: input.nodeType });
  await getDbClient().run("UPDATE workflow_run_steps SET status = ?, retryCount = ? WHERE id = ?", [
    input.status,
    input.retryCount ?? 0,
    id,
  ]);
  return id;
}

/** How many write (non read-only) transactions `fn` opened. */
async function writeTransactionsDuring(fn: () => Promise<unknown>): Promise<number> {
  const client = getDbClient();
  const realTransaction = client.transaction.bind(client);
  let writes = 0;
  const txSpy = spyOn(client, "transaction").mockImplementation(((txFn, opts) => {
    if (!opts?.readOnly) writes++;
    return realTransaction(txFn, opts);
  }) as typeof client.transaction);
  try {
    await fn();
  } finally {
    txSpy.mockRestore();
  }
  return writes;
}

type Barrier = ReturnType<typeof barrier>;

/**
 * Holds gated code: `entered` resolves when the code reaches the barrier,
 * `release` lets it go on, and `finished` resolves once it returned.
 */
function barrier() {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  return {
    entered: entered.promise,
    finished: finished.promise,
    release: () => released.resolve(),
    async around<T>(fn: () => Promise<T>): Promise<T> {
      entered.resolve();
      await released.promise;
      try {
        return await fn();
      } finally {
        finished.resolve();
      }
    },
  };
}

/**
 * A registry whose `sub-workflow` executor (for one child workflow) or
 * `agent-task` executor stops at a barrier before doing its work.
 */
function gatedRegistry(gates: {
  subWorkflowOf?: string;
  subWorkflow?: Barrier;
  agentTask?: Barrier;
}) {
  const gated = createExecutorRegistry(deps);
  class GatedSubWorkflow extends SubWorkflowExecutor {
    override async run(input: ExecutorInput) {
      const target = (input.config as { workflowId?: string }).workflowId;
      if (gates.subWorkflow && target === gates.subWorkflowOf) {
        return gates.subWorkflow.around(() => super.run(input));
      }
      return super.run(input);
    }
  }
  class GatedAgentTask extends AgentTaskExecutor {
    override async run(input: ExecutorInput) {
      if (gates.agentTask) return gates.agentTask.around(() => super.run(input));
      return super.run(input);
    }
  }
  gated.register(new GatedSubWorkflow(deps, gated));
  gated.register(new GatedAgentTask(deps));
  return gated;
}

// ─── Cascade ─────────────────────────────────────────────────

describe("cascade cancel", () => {
  test("cancels root, child and grandchild with their steps and tasks", async () => {
    const grandchild = await makeWorkflow(taskDef);
    const child = await makeWorkflow(parentOf(grandchild.id));
    const root = await makeWorkflow(parentOf(child.id));

    const rootId = await startWorkflowExecution(root, {}, registry);
    const childRun = await runOf(child.id, "waiting");
    const grandchildRun = await runOf(grandchild.id, "waiting");
    const [task] = await waitFor(
      () => tasksOfRun(grandchildRun.id),
      (tasks) => tasks.length === 1,
    );
    expect(task!.status).toBe("unassigned");

    await cancelWorkflowRun(rootId, "stop the tree");

    for (const runId of [rootId, childRun.id, grandchildRun.id]) {
      const run = await getWorkflowRun(runId, "display");
      expect(run?.status).toBe("cancelled");
      expect(run?.error).toBe("stop the tree");
      for (const step of await getWorkflowRunStepsByRunId(runId, "display")) {
        expect(step.status).toBe("cancelled");
      }
    }
    expect((await getTaskById(task!.id))?.status).toBe("cancelled");
    // A cancelled task is never handed to a worker.
    expect(await startTask(task!.id)).toBeNull();
  });

  test("fails tasks that depend on a cancelled tree task, and only those", async () => {
    const child = await makeWorkflow(taskDef);
    const root = await makeWorkflow(parentOf(child.id));
    const rootId = await startWorkflowExecution(root, {}, registry);
    const childRun = await runOf(child.id, "waiting");
    const [task] = await waitFor(
      () => tasksOfRun(childRun.id),
      (tasks) => tasks.length === 1,
    );
    const dependent = await createTaskExtended("after the step task", {
      source: "mcp",
      dependsOn: [task!.id],
    });
    const unrelated = await createTaskExtended("unrelated", { source: "mcp" });

    await cancelWorkflowRun(rootId);

    expect((await getTaskById(task!.id))?.status).toBe("cancelled");
    expect((await getTaskById(dependent.id))?.status).toBe("failed");
    expect((await getTaskById(unrelated.id))?.status).toBe(unrelated.status);
  });

  test("cancels every sibling child and leaves independent runs alone", async () => {
    const childA = await makeWorkflow(waitingDef);
    const childB = await makeWorkflow(waitingDef);
    const root = await makeWorkflow(parentOf(childA.id, childB.id));
    const independent = await makeWorkflow(waitingDef);

    const rootId = await startWorkflowExecution(root, {}, registry);
    const runA = await runOf(childA.id, "waiting");
    const runB = await runOf(childB.id, "waiting");
    const otherId = await startWorkflowExecution(independent, {}, registry);

    await cancelWorkflowRun(rootId);

    expect(await status(rootId)).toBe("cancelled");
    expect(await status(runA.id)).toBe("cancelled");
    expect(await status(runB.id)).toBe("cancelled");
    expect(await status(otherId)).toBe("waiting");

    // The independent run still runs to completion.
    const [step] = await getWorkflowRunStepsByRunId(otherId);
    const wait = await getWaitStateByStepId(step!.id);
    await resumeWaitState(wait!.id, "fired", undefined, registry);
    expect(await status(otherId)).toBe("completed");
  });

  test("reaches children of every attempt, through a terminal run, and keeps terminal history", async () => {
    const wf = await makeWorkflow({ nodes: [] });
    const rootId = await linkedRun({ workflowId: wf.id, status: "waiting" });
    const parentStep = await linkedStep(rootId, {
      nodeId: "child",
      nodeType: "sub-workflow",
      status: "waiting",
      retryCount: 1,
    });
    // Attempt 0's child failed, but still has a live child of its own.
    // Attempt 1's child is the current one.
    const oldChild = await linkedRun({
      workflowId: wf.id,
      status: "failed",
      error: "attempt 0 failed",
      parentStepId: parentStep,
      parentStepAttempt: 0,
    });
    const oldChildStep = await linkedStep(oldChild, {
      nodeId: "inner",
      nodeType: "sub-workflow",
      status: "waiting",
    });
    const doneStep = await linkedStep(oldChild, {
      nodeId: "before",
      nodeType: "script",
      status: "completed",
    });
    const orphan = await linkedRun({
      workflowId: wf.id,
      status: "waiting",
      parentStepId: oldChildStep,
    });
    const currentChild = await linkedRun({
      workflowId: wf.id,
      status: "running",
      parentStepId: parentStep,
      parentStepAttempt: 1,
    });

    await cancelWorkflowRun(rootId, "stop");

    expect(await status(rootId)).toBe("cancelled");
    expect(await status(currentChild)).toBe("cancelled");
    expect(await status(orphan)).toBe("cancelled");
    // The terminal run keeps its status and reason; only its open step goes.
    const old = await getWorkflowRun(oldChild, "display");
    expect(old?.status).toBe("failed");
    expect(old?.error).toBe("attempt 0 failed");
    expect((await getWorkflowRunStep(oldChildStep))?.status).toBe("cancelled");
    expect((await getWorkflowRunStep(doneStep))?.status).toBe("completed");
    expect((await getWorkflowRunStep(parentStep))?.retryCount).toBe(1);
  });

  test("a repeat cancel of a settled tree only reads: no write transaction, scan or task cancel", async () => {
    const grandchild = await makeWorkflow(taskDef);
    const child = await makeWorkflow(parentOf(grandchild.id));
    const root = await makeWorkflow(parentOf(child.id));
    const rootId = await startWorkflowExecution(root, {}, registry);
    const grandchildRun = await runOf(grandchild.id, "waiting");
    await waitFor(
      () => tasksOfRun(grandchildRun.id),
      (tasks) => tasks.length === 1,
    );
    await cancelWorkflowRun(rootId, "first");

    const scanSpy = spyOn(workflowRuns, "getTaskIdsWithDependents");
    const cancelSpy = spyOn(db, "cancelTask");
    let writes: number;
    try {
      writes = await writeTransactionsDuring(async () => {
        for (let i = 0; i < 3; i++) await cancelWorkflowRun(rootId, `repeat ${i}`);
      });
    } finally {
      scanSpy.mockRestore();
      cancelSpy.mockRestore();
    }

    expect(writes).toBe(0);
    expect(scanSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
    expect((await getWorkflowRun(grandchildRun.id, "display"))?.error).toBe("first");
  });

  test("an approval linked to a cancelled tree is born cancelled, so a repeat cancel stays read-only", async () => {
    const grandchild = await makeWorkflow(waitingDef);
    const child = await makeWorkflow(parentOf(grandchild.id));
    const root = await makeWorkflow(parentOf(child.id));
    const rootId = await startWorkflowExecution(root, {}, registry);
    const childRun = await runOf(child.id, "waiting");
    await runOf(grandchild.id, "waiting");
    await cancelWorkflowRun(rootId, "stop");
    // A run an older release left live under the cancelled root.
    const legacy = await linkedRun({
      workflowId: child.id,
      status: "waiting",
      parentStepId: (await getWorkflowRunStepsByRunId(childRun.id))[0]!.id,
      parentStepAttempt: 7,
    });
    const ask = (workflowRunId: string) =>
      db.createApprovalRequest({
        id: crypto.randomUUID(),
        title: "Late ask",
        questions: [{ id: "q1", type: "approval", label: "Approve?" }],
        approvers: { policy: "any" },
        workflowRunId,
      });

    // As POST /api/approval-requests does: a run link, no step, no HITL flag.
    const onCancelled = await ask(childRun.id);
    const onLegacy = await ask(legacy);

    expect(onCancelled.status).toBe("cancelled");
    expect(onCancelled.resolutionReason).toBe("stop");
    expect(onLegacy.status).toBe("cancelled");
    // The nearest cancelled ancestor is named.
    expect(onLegacy.resolutionReason).toBe(`Ancestor workflow run ${childRun.id} is cancelled`);

    // The legacy live run is open work: one cancel closes it, then repeats only read.
    await cancelWorkflowRun(rootId);
    expect(await status(legacy)).toBe("cancelled");
    await ask(childRun.id);
    expect(await writeTransactionsDuring(() => cancelWorkflowRun(rootId))).toBe(0);
  });

  test("POST /api/approval-requests on a cancelled tree creates no open work (HTTP)", async () => {
    const grandchild = await makeWorkflow(waitingDef);
    const child = await makeWorkflow(parentOf(grandchild.id));
    const root = await makeWorkflow(parentOf(child.id));
    const rootId = await startWorkflowExecution(root, {}, registry);
    const childRun = await runOf(child.id, "waiting");
    const grandchildRun = await runOf(grandchild.id, "waiting");
    await cancelWorkflowRun(rootId, "stop");

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const handled = await handleApprovalRequests(
        req,
        res,
        url.pathname.split("/").filter(Boolean),
        url.searchParams,
      );
      if (!handled) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      }
    });
    const port = await listenOnFreePort(server);
    try {
      // A run link and no step, as an agent or script asks through the API.
      for (const workflowRunId of [rootId, childRun.id, grandchildRun.id]) {
        const response = await fetch(`http://127.0.0.1:${port}/api/approval-requests`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Late ask",
            questions: [{ id: "q1", type: "approval", label: "Approve?", required: true }],
            approvers: { policy: "any" },
            workflowRunId,
          }),
        });
        expect(response.status).toBe(201);
        const { approvalRequest } = (await response.json()) as {
          approvalRequest: { status: string; resolutionReason: string | null };
        };
        expect(approvalRequest.status).toBe("cancelled");
        expect(approvalRequest.resolutionReason).toBe("stop");
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const pending = await getDbClient().get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM approval_requests WHERE workflowRunId IN (?, ?, ?) AND status = 'pending'",
      [rootId, childRun.id, grandchildRun.id],
    );
    expect(pending?.n).toBe(0);
    expect(await writeTransactionsDuring(() => cancelWorkflowRun(rootId))).toBe(0);
  });

  test("an approval linked to a live run without a step stays pending", async () => {
    const run = await makeWorkflow(waitingDef);
    const runId = await startWorkflowExecution(run, {}, registry);
    const created = await db.createApprovalRequest({
      id: crypto.randomUUID(),
      title: "Ask",
      questions: [{ id: "q1", type: "approval", label: "Approve?" }],
      approvers: { policy: "any" },
      workflowRunId: runId,
    });
    expect(created.status).toBe("pending");
  });

  test("concurrent repeat cancels of one run share a single tree walk", async () => {
    const child = await makeWorkflow(waitingDef);
    const root = await makeWorkflow(parentOf(child.id));
    const rootId = await startWorkflowExecution(root, {}, registry);
    await runOf(child.id, "waiting");
    await cancelWorkflowRun(rootId);

    const walkSpy = spyOn(workflowRuns, "getWorkflowRunTreeIds");
    try {
      await Promise.all(Array.from({ length: 5 }, () => cancelWorkflowRun(rootId)));
      // The settled probe walks the tree once for all five calls.
      expect(walkSpy).toHaveBeenCalledTimes(1);
      // A later call is a new cancel, not the finished one.
      await cancelWorkflowRun(rootId);
      expect(walkSpy).toHaveBeenCalledTimes(2);
    } finally {
      walkSpy.mockRestore();
    }
  });

  test("a repeat cancel of a cancelled root finishes descendants an older cancel left", async () => {
    const child = await makeWorkflow(waitingDef);
    const root = await makeWorkflow(parentOf(child.id));
    const rootId = await startWorkflowExecution(root, {}, registry);
    const childRun = await runOf(child.id, "waiting");
    // A cancel from before cascading: the root only.
    await getDbClient().run(
      "UPDATE workflow_runs SET status = 'cancelled', error = 'first cancel' WHERE id = ?",
      [rootId],
    );
    for (const step of await getWorkflowRunStepsByRunId(rootId)) {
      await setStatus("workflow_run_steps", step.id, "cancelled");
    }

    await cancelWorkflowRun(rootId, "second cancel");
    await cancelWorkflowRun(rootId, "third cancel");

    const rootRun = await getWorkflowRun(rootId, "display");
    expect(rootRun?.status).toBe("cancelled");
    expect(rootRun?.error).toBe("first cancel");
    const childAfter = await getWorkflowRun(childRun.id, "display");
    expect(childAfter?.status).toBe("cancelled");
    expect(childAfter?.error).toBe("second cancel");
  });

  test("concurrent cancels of a root and its child both succeed and keep one reason per run", async () => {
    const grandchild = await makeWorkflow(waitingDef);
    const child = await makeWorkflow(parentOf(grandchild.id));
    const root = await makeWorkflow(parentOf(child.id));
    const rootId = await startWorkflowExecution(root, {}, registry);
    const childRun = await runOf(child.id, "waiting");
    const grandchildRun = await runOf(grandchild.id, "waiting");

    await Promise.all([
      cancelWorkflowRun(rootId, "root reason"),
      cancelWorkflowRun(childRun.id, "child reason"),
    ]);

    expect((await getWorkflowRun(rootId, "display"))?.error).toBe("root reason");
    const childAfter = await getWorkflowRun(childRun.id, "display");
    expect(childAfter?.status).toBe("cancelled");
    expect(["root reason", "child reason"]).toContain(childAfter?.error);
    // Whichever cancel committed first covered the child's whole subtree.
    const grandchildAfter = await getWorkflowRun(grandchildRun.id, "display");
    expect(grandchildAfter?.status).toBe("cancelled");
    expect(grandchildAfter?.error).toBe(childAfter?.error);
  });

  test("a completed, failed or skipped root still refuses the cancel", async () => {
    const wf = await makeWorkflow({ nodes: [] });
    for (const terminal of ["completed", "failed", "skipped"]) {
      const rootId = await linkedRun({ workflowId: wf.id, status: terminal });
      const step = await linkedStep(rootId, {
        nodeId: "child",
        nodeType: "sub-workflow",
        status: "completed",
      });
      const childId = await linkedRun({ workflowId: wf.id, status: "waiting", parentStepId: step });

      await expect(cancelWorkflowRun(rootId)).rejects.toThrow(`'${terminal}' state`);
      expect(await status(childId)).toBe("waiting");
    }
  });
});

// ─── Atomicity ───────────────────────────────────────────────

describe("cascade cancel atomicity", () => {
  test("a failure partway rolls the whole tree back", async () => {
    const grandchild = await makeWorkflow(taskDef);
    const child = await makeWorkflow(parentOf(grandchild.id));
    const root = await makeWorkflow(parentOf(child.id));
    const rootId = await startWorkflowExecution(root, {}, registry);
    const childRun = await runOf(child.id, "waiting");
    const grandchildRun = await runOf(grandchild.id, "waiting");
    const [task] = await waitFor(
      () => tasksOfRun(grandchildRun.id),
      (tasks) => tasks.length === 1,
    );

    // The grandchild's task is cancelled after the root and child rows were written.
    const original = db.cancelTask;
    const cancelSpy = spyOn(db, "cancelTask").mockImplementation(async (id, reason) => {
      if (id === task!.id) throw new Error("injected cancel failure");
      return original(id, reason);
    });
    try {
      await expect(cancelWorkflowRun(rootId)).rejects.toThrow("injected cancel failure");
    } finally {
      cancelSpy.mockRestore();
    }

    for (const runId of [rootId, childRun.id, grandchildRun.id]) {
      expect(await status(runId)).toBe("waiting");
      for (const step of await getWorkflowRunStepsByRunId(runId)) {
        expect(step.status).toBe("waiting");
      }
    }
    expect((await getTaskById(task!.id))?.status).toBe("unassigned");

    // Nothing was half-applied, so the next cancel covers everything.
    await cancelWorkflowRun(rootId);
    expect(await status(grandchildRun.id)).toBe("cancelled");
    expect((await getTaskById(task!.id))?.status).toBe("cancelled");
  });

  test("a cycle in the stored links refuses the cancel and writes nothing", async () => {
    const wf = await makeWorkflow({ nodes: [] });
    const a = await linkedRun({ workflowId: wf.id, status: "waiting" });
    const aStep = await linkedStep(a, { nodeId: "s", nodeType: "sub-workflow", status: "waiting" });
    const b = await linkedRun({ workflowId: wf.id, status: "waiting", parentStepId: aStep });
    const bStep = await linkedStep(b, { nodeId: "s", nodeType: "sub-workflow", status: "waiting" });
    await getDbClient().run("UPDATE workflow_runs SET parentStepId = ? WHERE id = ?", [bStep, a]);

    await expect(cancelWorkflowRun(a)).rejects.toThrow("cycle");
    expect(await status(a)).toBe("waiting");
    expect(await status(b)).toBe("waiting");
    expect((await getWorkflowRunStep(aStep))?.status).toBe("waiting");
    expect(await getRunLineageBlock(b)).toContain("cycle");
  });

  test("a chain past the depth bound is refused whole; the bound covers every admitted depth", async () => {
    expect(WORKFLOW_RUN_TREE_MAX_DEPTH).toBeGreaterThanOrEqual(MAX_SUB_WORKFLOW_DEPTH);
    const wf = await makeWorkflow({ nodes: [] });
    const rootId = await linkedRun({ workflowId: wf.id, status: "waiting" });
    let parentId = rootId;
    for (let depth = 0; depth < 3; depth++) {
      const step = await linkedStep(parentId, {
        nodeId: "s",
        nodeType: "sub-workflow",
        status: "waiting",
      });
      parentId = await linkedRun({ workflowId: wf.id, status: "waiting", parentStepId: step });
    }

    expect(await getWorkflowRunTreeIds(rootId)).toHaveLength(4);
    await expect(getWorkflowRunTreeIds(rootId, { maxDepth: 2 })).rejects.toBeInstanceOf(
      WorkflowRunTreeError,
    );
    await expect(getWorkflowRunTreeIds(rootId, { maxDepth: 2 })).rejects.toThrow("deeper than 2");
  });

  test(
    "a wide tree the engine admitted (21 children x 95 grandchildren) is cancelled whole",
    async () => {
      const grandchild = await makeWorkflow(waitingDef);
      const child = await makeWorkflow(parentOf(...Array(95).fill(grandchild.id)));
      const root = await makeWorkflow(parentOf(...Array(21).fill(child.id)));
      const workflowIds = [root.id, child.id, grandchild.id];
      const count = async (where: string, params: string[] = []) =>
        (
          await getDbClient().get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM workflow_runs WHERE workflowId IN (?, ?, ?) AND ${where}`,
            [...workflowIds, ...params],
          )
        )?.n;

      const rootId = await startWorkflowExecution(root, {}, registry);
      // Every child walks on its own; wait until all grandchildren parked.
      await waitFor(
        () => count("workflowId = ? AND status = 'waiting'", [grandchild.id]),
        (n) => n === 21 * 95,
      );
      const tree = await getWorkflowRunTreeIds(rootId);
      expect(tree).toHaveLength(1 + 21 + 21 * 95);

      await cancelWorkflowRun(rootId, "stop the wide tree");

      expect(await count("status IN ('running', 'waiting')")).toBe(0);
      expect(await count("status = 'cancelled' AND error = 'stop the wide tree'")).toBe(
        tree.length,
      );
      const openSteps = await getDbClient().get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM workflow_run_steps s
           JOIN workflow_runs r ON r.id = s.runId
          WHERE r.workflowId IN (?, ?, ?) AND s.status IN ('pending', 'running', 'waiting')`,
        workflowIds,
      );
      expect(openSteps?.n).toBe(0);
    },
    { timeout: 60_000 },
  );

  test("a repeat cancel retries a Slack post an outage dropped, and never repeats a delivered one", async () => {
    const child = await makeWorkflow(approvalDef);
    const root = await makeWorkflow(parentOf(child.id));
    const rootId = await startWorkflowExecution(root, {}, registry);
    const childRun = await runOf(child.id, "waiting");
    const [approval] = await waitFor(
      () =>
        getDbClient().query<{ id: string }>(
          "SELECT id FROM approval_requests WHERE workflowRunId = ?",
          [childRun.id],
        ),
      (rows) => rows.length === 1,
    );
    // The approval card was posted to a Slack thread.
    await getDbClient().run("UPDATE approval_requests SET notificationChannels = ? WHERE id = ?", [
      JSON.stringify([{ channel: "slack", target: "C_REVIEW", messageTs: "1700000000.000100" }]),
      approval!.id,
    ]);

    let slackUp = false;
    const posts: string[] = [];
    const postMessage = async (input: { channel: string; thread_ts: string; text: string }) => {
      if (!slackUp) throw new Error("slack outage");
      posts.push(`${input.channel}:${input.thread_ts}:${input.text}`);
      return { ok: true };
    };
    const slackSpy = spyOn(slackApp, "getSlackApp").mockReturnValue({
      client: { chat: { postMessage } },
    } as unknown as ReturnType<typeof slackApp.getSlackApp>);
    try {
      await cancelWorkflowRun(rootId, "stop");
      expect(posts).toHaveLength(0);
      expect(await status(childRun.id)).toBe("cancelled");

      slackUp = true;
      await cancelWorkflowRun(rootId, "again");
      expect(posts).toEqual([
        "C_REVIEW:1700000000.000100:This approval is no longer actionable: stop",
      ]);

      await cancelWorkflowRun(rootId, "third");
      expect(posts).toHaveLength(1);
    } finally {
      slackSpy.mockRestore();
    }
  });

  test("a failed notification after commit does not undo the cancel", async () => {
    const child = await makeWorkflow(approvalDef);
    const root = await makeWorkflow(parentOf(child.id));
    const rootId = await startWorkflowExecution(root, {}, registry);
    const childRun = await runOf(child.id, "waiting");
    const [approval] = await waitFor(
      () =>
        getDbClient().query<{ id: string }>(
          "SELECT id FROM approval_requests WHERE workflowRunId = ?",
          [childRun.id],
        ),
      (rows) => rows.length === 1,
    );
    await getDbClient().run("UPDATE approval_requests SET notificationChannels = ? WHERE id = ?", [
      JSON.stringify([{ channel: "slack", target: "C_REVIEW", messageTs: "1700000000.000200" }]),
      approval!.id,
    ]);

    const postSpy = spyOn(approvalNotifications, "postApprovalCancellationUpdates");
    postSpy.mockRejectedValue(new Error("slack is down"));
    try {
      await cancelWorkflowRun(rootId, "stop");
      expect(postSpy).toHaveBeenCalled();
    } finally {
      postSpy.mockRestore();
    }

    expect(await status(rootId)).toBe("cancelled");
    expect(await status(childRun.id)).toBe("cancelled");
    expect((await db.getApprovalRequestById(approval!.id))?.status).toBe("cancelled");
  });
});

// ─── Late work ───────────────────────────────────────────────

describe("late work after a cascade cancel", () => {
  test("a child run inserted after the cancel commits is refused", async () => {
    const grandchild = await makeWorkflow(waitingDef);
    const child = await makeWorkflow(parentOf(grandchild.id));
    const root = await makeWorkflow(parentOf(child.id));
    const gate = barrier();
    const gated = gatedRegistry({ subWorkflowOf: grandchild.id, subWorkflow: gate });

    const rootId = await startWorkflowExecution(root, {}, gated);
    // The child run's sub-workflow step is claimed and its executor is about
    // to create the grandchild run.
    await gate.entered;
    const [childRun] = await runsOf(child.id);

    await cancelWorkflowRun(rootId, "stop");
    gate.release();
    await gate.finished;

    expect(await status(childRun!.id)).toBe("cancelled");
    const [childStep] = await getWorkflowRunStepsByRunId(childRun!.id);
    expect(childStep?.status).toBe("cancelled");
    expect(await runsOf(grandchild.id)).toHaveLength(0);
  });

  test("a child run inserted before the cancel commits is cancelled with the tree", async () => {
    const grandchild = await makeWorkflow(waitingDef);
    const child = await makeWorkflow(parentOf(grandchild.id));
    const root = await makeWorkflow(parentOf(child.id));
    const rootId = await startWorkflowExecution(root, {}, registry);
    const grandchildRun = await runOf(grandchild.id, "waiting");

    await cancelWorkflowRun(rootId);

    expect(await status(grandchildRun.id)).toBe("cancelled");
  });

  test("a task the executor creates after the cancel commits is refused", async () => {
    const gate = barrier();
    const child = await makeWorkflow(taskDef);
    const root = await makeWorkflow(parentOf(child.id));

    const rootId = await startWorkflowExecution(root, {}, gatedRegistry({ agentTask: gate }));
    await gate.entered;
    const [childRun] = await runsOf(child.id);
    const [step] = await getWorkflowRunStepsByRunId(childRun!.id);
    expect(step?.status).toBe("running");

    await cancelWorkflowRun(rootId);
    gate.release();
    await gate.finished;

    expect((await getWorkflowRunStep(step!.id))?.status).toBe("cancelled");
    expect(await tasksOfRun(childRun!.id)).toHaveLength(0);
    await expect(
      createTaskExtended("late", {
        source: "workflow",
        workflowRunId: childRun!.id,
        workflowRunStepId: step!.id,
      }),
    ).rejects.toBeInstanceOf(WorkflowStepNotExecutableError);
  });

  test("callbacks that read the step before the cancel commit route nothing after it", async () => {
    const child = await makeWorkflow({
      nodes: [
        { id: "work", type: "agent-task", config: { template: "work" }, next: "after" },
        { id: "after", type: "wait", config: { mode: "time", durationMs: 3_600_000 } },
      ],
    });
    const root = await makeWorkflow(parentOf(child.id));
    const rootId = await startWorkflowExecution(root, {}, registry);
    const childRun = await runOf(child.id, "waiting");
    const [task] = await waitFor(
      () => tasksOfRun(childRun.id),
      (tasks) => tasks.length === 1,
    );
    // Each handler read the step as `waiting` before the cancel committed.
    const [snapshot] = await getWorkflowRunStepsByRunId(childRun.id);
    expect(snapshot?.status).toBe("waiting");

    await cancelWorkflowRun(rootId);

    const def = child.definition;
    const completed = await completeTaskStepAndResolveSuccessors(
      def,
      childRun.id,
      snapshot!,
      { taskId: task!.id, taskOutput: "late" },
      {},
    );
    const ported = await checkpointPortStepAndResolveSuccessors(
      def,
      childRun.id,
      snapshot!.id,
      snapshot!.nodeId,
      {},
      "default",
      {},
    );
    const retried = await scheduleTaskStepRetry(def, childRun.id, snapshot!, task!.id, "late");
    await finalizeOrWait(childRun.id);
    await recoverIncompleteRuns(registry);

    expect(completed.claimed).toBe(false);
    expect(ported.claimed).toBe(false);
    expect(retried).not.toBe("scheduled");
    expect(await status(childRun.id)).toBe("cancelled");
    const steps = await getWorkflowRunStepsByRunId(childRun.id);
    expect(steps.map((s) => [s.nodeId, s.status])).toEqual([["work", "cancelled"]]);
  });

  test("a child that ends after the cancel settles nothing and queues no retry", async () => {
    const child = await makeWorkflow(waitingDef);
    const rootDef = parentOf(child.id);
    rootDef.nodes[0]!.retry = { maxRetries: 3, strategy: "static", baseDelayMs: 0, maxDelayMs: 0 };
    const root = await makeWorkflow(rootDef);
    const rootId = await startWorkflowExecution(root, {}, registry);
    const childRun = await runOf(child.id, "waiting");
    const [parentStep] = await getWorkflowRunStepsByRunId(rootId);

    await cancelWorkflowRun(rootId);
    // The child's end lands late, as a failure that would normally retry.
    await setStatus("workflow_runs", childRun.id, "failed");
    expect(await resumeFromChildRun(parentStep!.id, registry)).toBe(false);
    await recoverIncompleteRuns(registry);

    const step = await getWorkflowRunStep(parentStep!.id);
    expect(step?.status).toBe("cancelled");
    expect(step?.retryCount).toBe(0);
    expect(step?.nextRetryAt ?? null).toBeNull();
    expect(await status(rootId)).toBe("cancelled");
  });

  test("a queued retry of a terminal descendant is dropped and never revives it", async () => {
    const wf = await makeWorkflow({
      nodes: [{ id: "flaky", type: "property-match", config: { conditions: [] } }],
    });
    const rootId = await linkedRun({ workflowId: wf.id, status: "waiting" });
    const parentStep = await linkedStep(rootId, {
      nodeId: "child",
      nodeType: "sub-workflow",
      status: "waiting",
    });
    const failedChild = await linkedRun({
      workflowId: wf.id,
      status: "failed",
      error: "flaky failed",
      parentStepId: parentStep,
    });
    const flakyStep = await linkedStep(failedChild, {
      nodeId: "flaky",
      nodeType: "property-match",
      status: "failed",
    });
    const due = new Date(Date.now() - 1000).toISOString();
    const queueRetry = () =>
      getDbClient().run("UPDATE workflow_run_steps SET nextRetryAt = ? WHERE id = ?", [
        due,
        flakyStep,
      ]);
    await queueRetry();

    await cancelWorkflowRun(rootId);
    expect((await getWorkflowRunStep(flakyStep))?.nextRetryAt ?? null).toBeNull();

    // A retry queued again (older state, a racing writer) is dropped by the claim.
    await queueRetry();
    startRetryPoller(registry, 10);
    const step = await waitFor(
      () => getWorkflowRunStep(flakyStep),
      (row) => row?.nextRetryAt == null,
    );
    stopRetryPoller();

    expect(step?.status).toBe("failed");
    expect(step?.retryCount).toBe(0);
    const run = await getWorkflowRun(failedChild, "display");
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("flaky failed");
    // A manual retry of the failed descendant is refused too.
    await expect(retryFailedRun(failedChild, registry)).rejects.toThrow(
      `Ancestor workflow run ${rootId} is cancelled`,
    );
    expect(await status(failedChild)).toBe("failed");
  });

  test("restart recovery after the commit starts no work in the tree", async () => {
    const grandchild = await makeWorkflow(waitingDef);
    const child = await makeWorkflow(parentOf(grandchild.id));
    const root = await makeWorkflow(parentOf(child.id));
    const rootId = await startWorkflowExecution(root, {}, registry);
    const childRun = await runOf(child.id, "waiting");
    const grandchildRun = await runOf(grandchild.id, "waiting");
    const [waitStep] = await getWorkflowRunStepsByRunId(grandchildRun.id);
    const wait = await getWaitStateByStepId(waitStep!.id);
    await cancelWorkflowRun(rootId);
    const tree = [rootId, childRun.id, grandchildRun.id];
    const stepCount = async () =>
      (
        await getDbClient().get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM workflow_run_steps WHERE runId IN (?, ?, ?)",
          tree,
        )
      )?.n;
    const before = await stepCount();

    await recoverIncompleteRuns(registry);
    await resumeWaitState(wait!.id, "fired", undefined, registry);
    await recoverIncompleteRuns(registry);

    expect(await stepCount()).toBe(before);
    for (const runId of tree) expect(await status(runId)).toBe("cancelled");
  });
});

// ─── Lineage guard ───────────────────────────────────────────

describe("run lineage guard", () => {
  test("a live run under a cancelled ancestor starts no step, child or task, and a repeat cancel ends it", async () => {
    // State an older release left behind: the root was cancelled alone.
    const grandchild = await makeWorkflow(waitingDef);
    const wf = await makeWorkflow(parentOf(grandchild.id));
    const rootId = await linkedRun({ workflowId: wf.id, status: "cancelled" });
    const rootStep = await linkedStep(rootId, {
      nodeId: "child0",
      nodeType: "sub-workflow",
      status: "cancelled",
    });
    const childId = await linkedRun({
      workflowId: wf.id,
      status: "running",
      parentStepId: rootStep,
    });
    await db.updateWorkflowRun(childId, { context: {} });
    const childStep = await linkedStep(childId, {
      nodeId: "child0",
      nodeType: "sub-workflow",
      status: "running",
    });

    expect(await getRunLineageBlock(childId)).toBe(`Ancestor workflow run ${rootId} is cancelled`);
    await expect(
      startWorkflowExecution(grandchild, {}, registry, {
        parentStepId: childStep,
        parentStepAttempt: 0,
      }),
    ).rejects.toThrow("no longer running");
    await expect(
      createTaskExtended("late", {
        source: "workflow",
        workflowRunId: childId,
        workflowRunStepId: childStep,
      }),
    ).rejects.toBeInstanceOf(WorkflowStepNotExecutableError);

    // Recovery walks the live child: its step is orphaned, but no new step
    // starts and the run is not finalized from its steps either.
    await recoverIncompleteRuns(registry);
    expect(await getWorkflowRunStepsByRunId(childId)).toHaveLength(1);
    expect(await runsOf(grandchild.id)).toHaveLength(0);
    expect(await status(childId)).toBe("running");

    await cancelWorkflowRun(rootId);
    expect(await status(childId)).toBe("cancelled");
    expect((await getWorkflowRunStep(childStep))?.status).toBe("cancelled");
  });

  test("a child whose parent step is gone gets no permission to run", async () => {
    const wf = await makeWorkflow({ nodes: [] });
    const childId = await linkedRun({
      workflowId: wf.id,
      status: "running",
      parentStepId: crypto.randomUUID(),
    });
    expect(await getRunLineageBlock(childId)).toContain("is missing");
  });

  test("a child of a live or ended parent is not blocked, so normal retries still run", async () => {
    const wf = await makeWorkflow({ nodes: [] });
    const rootId = await linkedRun({ workflowId: wf.id, status: "completed" });
    const step = await linkedStep(rootId, {
      nodeId: "child",
      nodeType: "sub-workflow",
      status: "completed",
    });
    const childId = await linkedRun({ workflowId: wf.id, status: "running", parentStepId: step });
    expect(await getRunLineageBlock(childId)).toBeNull();
    expect(await getRunLineageBlock(rootId)).toBeNull();

    // A failing child of a live parent retries through the poller as before.
    const flaky = await makeWorkflow({
      nodes: [
        {
          id: "flaky",
          type: "property-match",
          config: { conditions: [] },
          retry: { maxRetries: 1, strategy: "static", baseDelayMs: 0, maxDelayMs: 0 },
        },
      ],
    });
    const parent = await makeWorkflow(parentOf(flaky.id));
    const parentId = await startWorkflowExecution(parent, {}, registry);
    const [flakyRun] = await waitFor(
      () => runsOf(flaky.id),
      (runs) => runs.length === 1,
    );
    startRetryPoller(registry, 10);
    const [flakyStep] = await waitFor(
      () => getWorkflowRunStepsByRunId(flakyRun!.id),
      (steps) =>
        steps.length === 1 &&
        steps[0]!.status === "failed" &&
        steps[0]!.retryCount === 1 &&
        steps[0]!.nextRetryAt == null,
    );
    stopRetryPoller();
    expect(flakyStep!.error).toBeDefined();
    expect(
      await waitFor(
        () => status(parentId),
        (s) => s === "failed",
      ),
    ).toBe("failed");
  });
});

describe("run tree read (GET /api/workflow-runs/{id}/tree)", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl = "";

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const handled = await handleWorkflows(
        req,
        res,
        url.pathname.split("/").filter(Boolean),
        url.searchParams,
        undefined,
      );
      if (!handled) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      }
    });
    baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  type TreeBody = {
    rootRunId: string;
    runs: Array<WorkflowRun & Record<string, unknown>>;
    hasOpenWork: boolean;
    error?: string;
  };

  async function getTree(runId: string): Promise<{ status: number; body: TreeBody | null }> {
    const response = await fetch(`${baseUrl}/api/workflow-runs/${runId}/tree`);
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as TreeBody) : null };
  }

  test("lists every run of every attempt, root first, and settles after a cascade cancel", async () => {
    const grandchild = await makeWorkflow(taskDef);
    const child = await makeWorkflow(parentOf(grandchild.id));
    const root = await makeWorkflow(parentOf(child.id));
    const rootId = await startWorkflowExecution(root, {}, registry);
    const childRun = await runOf(child.id, "waiting");
    const grandchildRun = await runOf(grandchild.id, "waiting");
    const [task] = await waitFor(
      () => tasksOfRun(grandchildRun.id),
      (tasks) => tasks.length === 1,
    );

    // A retry of the root step: the live child is attempt 1, and attempt 0's
    // child failed after starting a grandchild of its own.
    const [rootStep] = await getWorkflowRunStepsByRunId(rootId);
    await getDbClient().run("UPDATE workflow_run_steps SET retryCount = 1 WHERE id = ?", [
      rootStep!.id,
    ]);
    await getDbClient().run("UPDATE workflow_runs SET parentStepAttempt = 1 WHERE id = ?", [
      childRun.id,
    ]);
    const oldChild = await linkedRun({
      workflowId: child.id,
      status: "failed",
      parentStepId: rootStep!.id,
      parentStepAttempt: 0,
    });
    const oldChildStep = await linkedStep(oldChild, {
      nodeId: "child0",
      nodeType: "sub-workflow",
      status: "failed",
    });
    const oldGrandchild = await linkedRun({
      workflowId: grandchild.id,
      status: "failed",
      parentStepId: oldChildStep,
    });

    const before = await getTree(rootId);
    expect(before.status).toBe(200);
    expect(before.body!.rootRunId).toBe(rootId);
    expect(before.body!.hasOpenWork).toBe(true);
    const ids = before.body!.runs.map((run) => run.id);
    expect(ids[0]).toBe(rootId);
    expect(new Set(ids.slice(1, 3))).toEqual(new Set([childRun.id, oldChild]));
    expect(new Set(ids.slice(3))).toEqual(new Set([grandchildRun.id, oldGrandchild]));
    const byId = new Map(before.body!.runs.map((run) => [run.id, run]));
    expect(byId.get(childRun.id)).toMatchObject({
      workflowId: child.id,
      status: "waiting",
      parentStepId: rootStep!.id,
      parentStepAttempt: 1,
    });
    expect(byId.get(oldChild)).toMatchObject({ status: "failed", parentStepAttempt: 0 });
    expect(byId.get(oldGrandchild)?.parentStepId).toBe(oldChildStep);
    for (const run of before.body!.runs) expect("context" in run).toBe(false);

    await cancelWorkflowRun(rootId, "stop the tree");
    expect((await getTaskById(task!.id))?.status).toBe("cancelled");

    const after = await getTree(rootId);
    expect(after.status).toBe(200);
    expect(after.body!.hasOpenWork).toBe(false);
    expect(after.body!.runs.map((run) => run.id)).toEqual(ids);
    const statuses = new Map(after.body!.runs.map((run) => [run.id, run.status]));
    expect(statuses.get(rootId)).toBe("cancelled");
    expect(statuses.get(childRun.id)).toBe("cancelled");
    expect(statuses.get(grandchildRun.id)).toBe("cancelled");
    // Terminal history keeps its status.
    expect(statuses.get(oldChild)).toBe("failed");
    expect(statuses.get(oldGrandchild)).toBe("failed");

    // A subtree reads on its own, without its ancestors.
    const subtree = await getTree(childRun.id);
    expect(subtree.body!.runs.map((run) => run.id)).toEqual([childRun.id, grandchildRun.id]);
  });

  test("a tree wider than one summary query returns every run once, in walk order", async () => {
    const wf = await makeWorkflow({ nodes: [] });
    const rootId = await linkedRun({ workflowId: wf.id, status: "completed" });
    const step = await linkedStep(rootId, {
      nodeId: "fan",
      nodeType: "sub-workflow",
      status: "completed",
    });
    // One child per attempt, over two 500-id summary chunks, so a dropped or
    // repeated chunk shows.
    const childCount = 1_100;
    await getDbClient().transaction(async () => {
      for (let i = 0; i < childCount; i++) {
        await createWorkflowRun({
          id: crypto.randomUUID(),
          workflowId: wf.id,
          parentStepId: step,
          parentStepAttempt: i,
        });
      }
    });

    const walk = await getWorkflowRunTreeIds(rootId);
    expect(walk).toHaveLength(childCount + 1);
    const tree = await getTree(rootId);
    expect(tree.status).toBe(200);
    expect(tree.body!.runs.map((run) => run.id)).toEqual(walk);
    expect(tree.body!.hasOpenWork).toBe(true);
  });

  test("a run without children is its own tree", async () => {
    const wf = await makeWorkflow({ nodes: [] });
    const runId = await linkedRun({ workflowId: wf.id, status: "completed" });
    const tree = await getTree(runId);
    expect(tree.status).toBe(200);
    expect(tree.body!.runs.map((run) => run.id)).toEqual([runId]);
    expect(tree.body!.hasOpenWork).toBe(false);
  });

  test("an unknown run is 404 and a cycle in the stored links is 409", async () => {
    expect((await getTree(crypto.randomUUID())).status).toBe(404);

    const wf = await makeWorkflow({ nodes: [] });
    const a = await linkedRun({ workflowId: wf.id, status: "waiting" });
    const aStep = await linkedStep(a, { nodeId: "s", nodeType: "sub-workflow", status: "waiting" });
    const b = await linkedRun({ workflowId: wf.id, status: "waiting", parentStepId: aStep });
    const bStep = await linkedStep(b, { nodeId: "s", nodeType: "sub-workflow", status: "waiting" });
    await getDbClient().run("UPDATE workflow_runs SET parentStepId = ? WHERE id = ?", [bStep, a]);

    const cycle = await getTree(a);
    expect(cycle.status).toBe(409);
    expect(cycle.body!.error).toContain("cycle");
  });
});
