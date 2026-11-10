import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import * as db from "../be/db";
import {
  closeDb,
  completeTask,
  createAgent,
  createWorkflow,
  getTaskByWorkflowRunStepId,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
} from "../be/db";
import type { WorkflowDefinition, WorkflowNode } from "../types";
import { startWorkflowExecution } from "../workflows/engine";
import { InProcessEventBus } from "../workflows/event-bus";
import { AgentTaskExecutor } from "../workflows/executors/agent-task";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import { ExecutorRegistry } from "../workflows/executors/registry";
import { setupWorkflowResumeListener } from "../workflows/resume";
import { interpolate } from "../workflows/template";

// Two walkers live on one run: the walk that started it and a task-completion
// resume, or two resumes at once. Each holds its own in-memory context and
// decides from step rows whether the run is over.

const TEST_DB_PATH = `./test-workflow-finalization-races-${crypto.randomUUID()}.sqlite`;

/** Every executor call, as `runId:nodeId`. */
const calls: string[] = [];

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
    if (meta.nodeId === "slow" && slowGate) {
      const gate = slowGate;
      slowGate = undefined;
      gate.entered(meta.runId);
      await gate.release;
    }
    return { status: "success", output: { node: meta.nodeId } };
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
  setupWorkflowResumeListener(bus, registry);
  return { bus, registry };
}

async function start(nodes: WorkflowNode[], h = harness()) {
  const definition: WorkflowDefinition = { nodes };
  const workflow = await createWorkflow({
    name: `finalization-races-${crypto.randomUUID()}`,
    definition,
  });
  const runId = await startWorkflowExecution(workflow, {}, h.registry);
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
  test("a task completing while its batch sibling still runs keeps its output in the run context", async () => {
    const entered = Promise.withResolvers<string>();
    const release = Promise.withResolvers<void>();
    slowGate = { entered: entered.resolve, release: release.promise };
    const h = harness();
    const walk = start([record("sweep", ["slow", "park"]), record("slow"), task("park")], h);

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
    // The resume left the run `running` for this walk to finalize.
    expect(run?.status).toBe("completed");
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
