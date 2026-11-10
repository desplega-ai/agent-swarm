import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import * as db from "../be/db";
import {
  closeDb,
  completeTask,
  createAgent,
  createWorkflow,
  getDb,
  getDbClient,
  getTaskByWorkflowRunStepId,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
} from "../be/db";
import type { ExecutorMeta, WorkflowDefinition, WorkflowNode } from "../types";
import { startWorkflowExecution, walkGraph } from "../workflows/engine";
import { InProcessEventBus } from "../workflows/event-bus";
import { AgentTaskExecutor } from "../workflows/executors/agent-task";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import {
  type ForeachConfigSchema,
  ForeachExecutor,
  type ForeachOutput,
} from "../workflows/executors/foreach";
import { ExecutorRegistry } from "../workflows/executors/registry";
import { runForeachDrive } from "../workflows/foreach-driver";
import * as foreachJoin from "../workflows/foreach-join";
import { recoverIncompleteRuns } from "../workflows/recovery";
import { finalizeOrWait, setupWorkflowResumeListener } from "../workflows/resume";
import { startRetryPoller, stopRetryPoller } from "../workflows/retry-poller";
import {
  hasOwedSuccessors,
  holdSuccessorRouting,
  oweSuccessorWalk,
} from "../workflows/successor-routing";
import { completeTaskStepAndResolveSuccessors } from "../workflows/task-step-routing";
import { interpolate } from "../workflows/template";

// Two walkers live on one run: the walk that started it and a task-completion
// resume, or two resumes at once. Each holds its own in-memory context and
// decides from step rows whether the run is over.

const TEST_DB_PATH = `./test-workflow-finalization-races-${crypto.randomUUID()}.sqlite`;

/** Every executor call, as `runId:nodeId`. */
const calls: string[] = [];

/** Node ids whose next execution fails. */
const failOnce = new Set<string>();

/** Holds the next `slow` execution open until released. */
let slowGate: { entered: (runId: string) => void; release: Promise<void> } | undefined;

class RecordExecutor extends BaseExecutor<
  typeof RecordExecutor.configSchema,
  typeof RecordExecutor.outputSchema
> {
  static readonly configSchema = z.object({});
  static readonly outputSchema = z.object({ node: z.string() });

  readonly type = "record";
  readonly mode = "instant" as const;
  readonly configSchema = RecordExecutor.configSchema;
  readonly outputSchema = RecordExecutor.outputSchema;

  protected async execute(
    _config: z.infer<typeof RecordExecutor.configSchema>,
    _context: Readonly<Record<string, unknown>>,
    meta: { runId: string; nodeId: string },
  ): Promise<ExecutorResult<z.infer<typeof RecordExecutor.outputSchema>>> {
    calls.push(`${meta.runId}:${meta.nodeId}`);
    if (failOnce.delete(meta.nodeId)) return { status: "failed", error: `${meta.nodeId} failed` };
    if (meta.nodeId === "slow" && slowGate) {
      const gate = slowGate;
      slowGate = undefined;
      gate.entered(meta.runId);
      await gate.release;
    }
    return { status: "success", output: { node: meta.nodeId } };
  }
}

/** While true, a fan-out item parks like an async body instead of finishing. */
let parkFanItems = false;

/** A foreach body: instant, unless `parkFanItems` parks the item. */
class FanItemExecutor extends RecordExecutor {
  override readonly type = "fan-item";

  protected override async execute(
    config: Record<string, never>,
    context: Readonly<Record<string, unknown>>,
    meta: { runId: string; nodeId: string },
  ): Promise<ExecutorResult<{ node: string }>> {
    if (!parkFanItems) return super.execute(config, context, meta);
    return {
      status: "success",
      async: true,
      waitFor: "test.never",
    } as unknown as ExecutorResult<{ node: string }>;
  }
}

/** The foreach executor, failing once for a node in `failOnce`. */
class FlakyForeachExecutor extends ForeachExecutor {
  protected override async execute(
    config: z.infer<typeof ForeachConfigSchema>,
    context: Readonly<Record<string, unknown>>,
    meta: ExecutorMeta,
  ): Promise<ExecutorResult<ForeachOutput>> {
    if (failOnce.delete(meta.nodeId)) return { status: "failed", error: `${meta.nodeId} failed` };
    return super.execute(config, context, meta);
  }
}

/** Parks on an approval request, as human-in-the-loop does. */
class ApprovalExecutor extends BaseExecutor<z.ZodObject, z.ZodObject> {
  readonly type = "test-approval";
  readonly mode = "async" as const;
  readonly configSchema = z.object({});
  readonly outputSchema = z.object({});

  protected async execute(
    _config: Record<string, never>,
    _context: Readonly<Record<string, unknown>>,
    meta: { runId: string; stepId: string },
  ): Promise<ExecutorResult<Record<string, never>>> {
    const requestId = crypto.randomUUID();
    await this.deps.db.createApprovalRequest({
      id: requestId,
      title: "Ship?",
      questions: [{ id: "q1", type: "approval", label: "Ship?", required: true }],
      approvers: { policy: "any" as const },
      workflowRunId: meta.runId,
      workflowRunStepId: meta.stepId,
    });
    return {
      status: "success",
      async: true,
      waitFor: "approval.resolved",
      correlationId: requestId,
    } as unknown as ExecutorResult<Record<string, never>>;
  }
}

let agentId: string;

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  agentId = (await createAgent({ name: "Ada", status: "idle" })).id;
});

// A gate its test never reached must not hold the next test's `slow`.
afterEach(() => {
  slowGate = undefined;
  parkFanItems = false;
  failOnce.clear();
});

afterAll(async () => {
  closeDb();
  await removeDbFiles();
});

const record = (id: string, next?: string | string[]): WorkflowNode => ({
  id,
  type: "record",
  config: {},
  ...(next ? { next } : {}),
});

/** `sweep`, a fan-out over the trigger items, then `after`. */
const fanOut = (): WorkflowNode[] => [
  record("sweep", "fan"),
  {
    id: "fan",
    type: "foreach",
    config: { over: "{{trigger.items}}", itemKey: "id", body: { type: "fan-item", config: {} } },
    next: "after",
  },
  record("after"),
];

const task = (id: string, next?: string): WorkflowNode => ({
  id,
  type: "agent-task",
  config: { agentId, template: `Do ${id}` },
  ...(next ? { next } : {}),
});

function harness() {
  const bus = new InProcessEventBus();
  const deps: ExecutorDependencies = {
    db,
    eventBus: bus,
    interpolate: (template, ctx) => interpolate(template, ctx).result,
  };
  const registry = new ExecutorRegistry();
  registry.register(new AgentTaskExecutor(deps));
  registry.register(new RecordExecutor(deps));
  registry.register(new FlakyForeachExecutor(deps));
  registry.register(new FanItemExecutor(deps));
  registry.register(new ApprovalExecutor(deps));
  setupWorkflowResumeListener(bus, registry);
  return { bus, registry };
}

async function start(nodes: WorkflowNode[], h = harness(), trigger: Record<string, unknown> = {}) {
  const definition: WorkflowDefinition = { nodes };
  const workflow = await createWorkflow({
    name: `finalization-races-${crypto.randomUUID()}`,
    definition,
  });
  const runId = await startWorkflowExecution(workflow, trigger, h.registry);
  return { ...h, runId };
}

const executions = (runId: string, nodeId: string) =>
  calls.filter((call) => call === `${runId}:${nodeId}`).length;

async function stepStatuses(runId: string, nodeId: string) {
  return (await getWorkflowRunStepsByRunId(runId))
    .filter((step) => step.nodeId === nodeId)
    .map((step) => step.status);
}

/**
 * Complete the tasks these nodes dispatched, then deliver every completion
 * event in one synchronous burst, in the order given, so the resume handlers
 * run interleaved.
 */
async function completeTasksTogether(runId: string, bus: InProcessEventBus, nodeIds: string[]) {
  const steps = await getWorkflowRunStepsByRunId(runId);
  const events: Array<Record<string, unknown>> = [];
  for (const nodeId of nodeIds) {
    const step = steps.find((candidate) => candidate.nodeId === nodeId);
    const dispatched = step ? await getTaskByWorkflowRunStepId(step.id) : null;
    if (!step || !dispatched) throw new Error(`No dispatched task for ${nodeId}`);
    await completeTask(dispatched.id, "done");
    events.push({
      taskId: dispatched.id,
      output: "done",
      workflowRunId: runId,
      workflowRunStepId: step.id,
    });
  }
  for (const event of events) bus.emit("task.completed", event);
}

describe("two walkers finalize one workflow run", () => {
  test("a task completing while its batch sibling still runs keeps its output and the sibling's successor", async () => {
    const entered = Promise.withResolvers<string>();
    const release = Promise.withResolvers<void>();
    slowGate = { entered: entered.resolve, release: release.promise };
    const h = harness();
    const walk = start(
      [record("sweep", ["slow", "park"]), record("slow", "after"), task("park"), record("after")],
      h,
    );

    // `slow` is in flight in the first walk when the parked task completes.
    const runId = await entered.promise;
    await waitFor(async () => (await stepStatuses(runId, "park"))[0] === "waiting");
    await completeTasksTogether(runId, h.bus, ["park"]);
    await waitFor(async () => (await stepStatuses(runId, "park"))[0] === "completed");

    release.resolve();
    await walk;

    const run = await getWorkflowRun(runId);
    expect(run?.context).toHaveProperty("park");
    expect(run?.context).toHaveProperty("slow");
    // The parked sibling does not stop this walk from routing `slow`'s branch.
    expect(executions(runId, "after")).toBe(1);
    expect(run?.context).toHaveProperty("after");
    // The resume left the run `running` for this walk to finalize.
    expect(run?.status).toBe("completed");
  });

  // A retry walk or a foreach drive on the same run, holding nothing of its
  // own, finishes between a claim's commit and the claim's walk.
  test("an unrelated walk finishing between a claim and its walk does not finish the run", async () => {
    const h = harness();
    const nodes = [record("sweep", "branch"), task("branch", "after"), record("after")];
    const { runId } = await start(nodes, h);
    const definition: WorkflowDefinition = { nodes };
    const step = (await getWorkflowRunStepsByRunId(runId)).find((s) => s.nodeId === "branch");
    const dispatched = step ? await getTaskByWorkflowRunStepId(step.id) : null;
    if (!step || !dispatched) throw new Error("No dispatched branch task");
    const ctx = ((await getWorkflowRun(runId))?.context ?? {}) as Record<string, unknown>;

    const routing = await completeTaskStepAndResolveSuccessors(
      definition,
      runId,
      step,
      { taskId: dispatched.id, taskOutput: "done" },
      ctx,
      undefined,
      undefined,
      h.registry,
    );
    expect(routing.successors.map((n) => n.id)).toEqual(["after"]);

    await walkGraph(definition, runId, { ...ctx }, [], h.registry);
    expect((await getWorkflowRun(runId))?.status).toBe("running");

    await walkGraph(definition, runId, ctx, routing.successors, h.registry, undefined, undefined, {
      successorDebt: routing.successorDebt,
    });
    expect(executions(runId, "after")).toBe(1);
    expect((await getWorkflowRun(runId))?.status).toBe("completed");
    expect(hasOwedSuccessors(runId)).toBe(false);
  });

  test("two parked siblings resuming together both keep their output in the run context", async () => {
    const { bus, runId } = await start([
      record("sweep", ["left", "right"]),
      task("left"),
      task("right"),
    ]);
    expect((await getWorkflowRun(runId))?.status).toBe("waiting");

    await completeTasksTogether(runId, bus, ["left", "right"]);
    await waitFor(async () => (await getWorkflowRun(runId))?.status === "completed");

    const context = (await getWorkflowRun(runId))?.context;
    expect(context).toHaveProperty("left");
    expect(context).toHaveProperty("right");
  });

  // `branch` owes `after`; `leaf` has nothing to route and goes straight to
  // the finalizer. Either can reach the database first.
  test.each([
    [["branch", "leaf"]],
    [["leaf", "branch"]],
  ])("a leaf sibling resuming next to a branch with a successor does not finish the run early (%p)", async (order) => {
    const { bus, runId } = await start([
      record("sweep", ["branch", "leaf"]),
      task("branch", "after"),
      task("leaf"),
      record("after"),
    ]);
    expect((await getWorkflowRun(runId))?.status).toBe("waiting");

    await completeTasksTogether(runId, bus, order);
    await waitFor(async () => (await getWorkflowRun(runId))?.status === "completed");
    // A walker the early finalize cut off would settle within this window.
    await Bun.sleep(100);

    expect(executions(runId, "after")).toBe(1);
    expect(await stepStatuses(runId, "after")).toEqual(["completed"]);
    expect((await getWorkflowRun(runId))?.context).toHaveProperty("after");
  });
});

describe("successors owed from the commit that closes them", () => {
  // The retry poller requeues a retried item and drives it; the drive's
  // settlement closes the join. Fail-fast (the default) re-reads the run once
  // the batch is done, the first await after that commit.
  test("a finalizer between a drive's join and its walk does not finish the run", async () => {
    parkFanItems = true;
    const h = harness();
    const { runId } = await start(fanOut(), h, { items: [{ id: "a" }] });
    expect((await getWorkflowRun(runId))?.status).toBe("waiting");
    parkFanItems = false;
    await getDbClient().run(
      "UPDATE workflow_run_steps SET status = 'pending' WHERE runId = ? AND nodeId LIKE 'fan#%'",
      [runId],
    );

    let joined = false;
    const settle = foreachJoin.settleForeachChild;
    const settleSpy = spyOn(foreachJoin, "settleForeachChild").mockImplementation(
      async (...args) => {
        const result = await settle(...args);
        joined ||= result.joined;
        return result;
      },
    );
    const read = db.getWorkflowRun;
    const readSpy = spyOn(db, "getWorkflowRun").mockImplementation(async (id) => {
      if (joined) {
        joined = false;
        await finalizeOrWait(runId);
      }
      return read(id);
    });
    try {
      const drive = await runForeachDrive(runId, "fan", h.registry);
      expect(drive.joined).toBe(true);
    } finally {
      settleSpy.mockRestore();
      readSpy.mockRestore();
    }

    expect(executions(runId, "after")).toBe(1);
    const run = await getWorkflowRun(runId);
    expect(run?.context).toHaveProperty("after");
    expect(run?.status).toBe("completed");
    expect(hasOwedSuccessors(runId)).toBe(false);
  });

  // The approval recovery sweep claims the step inside its own transaction.
  test("a claim whose outer transaction fails at COMMIT drops its hold", async () => {
    const h = harness();
    const { runId } = await start(
      [
        { id: "review", type: "test-approval", config: {}, next: { approved: "after" } },
        record("after"),
      ],
      h,
    );
    expect((await getWorkflowRun(runId))?.status).toBe("waiting");
    await getDbClient().run(
      "UPDATE approval_requests SET status = 'approved', resolvedAt = ? WHERE workflowRunId = ?",
      [new Date().toISOString(), runId],
    );

    // The commit that would publish the claim fails, as a disk error would.
    const raw = getDb();
    const run = raw.run.bind(raw);
    let failedCommits = 0;
    const commitSpy = spyOn(raw, "run").mockImplementation(((sql: string, ...params: never[]) => {
      if (sql === "COMMIT" && failedCommits === 0 && hasOwedSuccessors(runId)) {
        failedCommits++;
        throw new Error("disk I/O error");
      }
      return run(sql, ...params);
    }) as typeof raw.run);
    try {
      await recoverIncompleteRuns(h.registry);
    } finally {
      commitSpy.mockRestore();
    }
    expect(failedCommits).toBe(1);
    expect(await stepStatuses(runId, "review")).toEqual(["waiting"]);
    expect(hasOwedSuccessors(runId)).toBe(false);

    // The next sweep routes the step, and the run can finish.
    await recoverIncompleteRuns(h.registry);
    expect(executions(runId, "after")).toBe(1);
    expect((await getWorkflowRun(runId))?.status).toBe("completed");
  });
});

describe("a retried step's successors", () => {
  // The poller commits the retried step, then walks its successors. A
  // finalizer queued on the database while that commit is open runs next.
  test("a finalizer queued at the retried step's commit leaves its successor to the poller", async () => {
    failOnce.add("flaky");
    const h = harness();
    const { runId } = await start(
      [
        record("sweep", "flaky"),
        {
          ...record("flaky", "after"),
          retry: { maxRetries: 1, strategy: "static", baseDelayMs: 0, maxDelayMs: 0 },
        },
        record("after"),
      ],
      h,
    );
    const flaky = (await getWorkflowRunStepsByRunId(runId)).find((s) => s.nodeId === "flaky");
    expect(flaky?.nextRetryAt).toBeTruthy();

    const outside = AsyncLocalStorage.snapshot();
    let finalizer: Promise<void> | undefined;
    const write = db.updateWorkflowRunStep;
    const spy = spyOn(db, "updateWorkflowRunStep").mockImplementation(async (id, patch) => {
      const result = await write(id, patch);
      if (!finalizer && id === flaky?.id && patch.status === "completed") {
        finalizer = outside(() => finalizeOrWait(runId));
      }
      return result;
    });
    startRetryPoller(h.registry, 10);
    try {
      await waitFor(async () => (await getWorkflowRun(runId))?.status === "completed");
    } finally {
      stopRetryPoller();
      spy.mockRestore();
    }
    await finalizer;

    expect(finalizer).toBeDefined();
    expect(executions(runId, "after")).toBe(1);
    expect((await getWorkflowRun(runId))?.context).toHaveProperty("after");
  });

  // The poller re-executes the fan-out; its instant items close the join
  // inside the drive, and the poller walks the join's successors.
  test("a retried fan-out that joins inline routes its successor and finishes the run", async () => {
    failOnce.add("fan");
    const h = harness();
    const nodes = fanOut();
    nodes[1] = {
      ...nodes[1]!,
      retry: { maxRetries: 1, strategy: "static", baseDelayMs: 0, maxDelayMs: 0 },
    };
    const { runId } = await start(nodes, h, { items: [{ id: "a" }] });
    expect(await stepStatuses(runId, "fan")).toEqual(["failed"]);

    startRetryPoller(h.registry, 10);
    try {
      await waitFor(async () => (await getWorkflowRun(runId))?.status === "completed");
    } finally {
      stopRetryPoller();
    }
    expect(executions(runId, "after")).toBe(1);
    expect(hasOwedSuccessors(runId)).toBe(false);
  });
});

describe("successor routing holds", () => {
  test("a walk without the claim's debt holds and releases only its own share", () => {
    const runId = crypto.randomUUID();
    const debt = oweSuccessorWalk(runId);
    holdSuccessorRouting(runId)();
    expect(hasOwedSuccessors(runId)).toBe(true);

    const routed = holdSuccessorRouting(runId, debt);
    // A second walk handed the same debt takes a hold of its own.
    const other = holdSuccessorRouting(runId, debt);
    routed();
    routed();
    expect(hasOwedSuccessors(runId)).toBe(true);
    other();
    expect(hasOwedSuccessors(runId)).toBe(false);
  });
});

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for workflow state");
}

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(TEST_DB_PATH + suffix).catch(() => {});
  }
}
