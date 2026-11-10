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
import { ForeachExecutor } from "../workflows/executors/foreach";
import { ExecutorRegistry } from "../workflows/executors/registry";
import { recoverIncompleteRuns } from "../workflows/recovery";
import { setupWorkflowResumeListener } from "../workflows/resume";
import { interpolate } from "../workflows/template";

// One batch runs `quick` and `park` side by side. `park` dispatches an agent
// task and waits; `quick` completes at once and routes to `after`. The walk
// used to stop at the first waiting step and drop `after`, and the run still
// ended `completed` once the task finished.

const TEST_DB_PATH = `./test-workflow-parallel-park-${crypto.randomUUID()}.sqlite`;

/** Every executor call, as `runId:nodeId`. */
const calls: string[] = [];

/** Holds the next `after` execution open until released. */
let afterGate: { entered: (runId: string) => void; release: Promise<void> } | undefined;

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
    if (meta.nodeId === "after" && afterGate) {
      const gate = afterGate;
      afterGate = undefined;
      gate.entered(meta.runId);
      await gate.release;
    }
    return { status: "success", output: { node: meta.nodeId } };
  }
}

type Parker = "agent-task" | "foreach";

let agentId: string;

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  agentId = (await createAgent({ name: "Ada", status: "idle" })).id;
});

// A gate its test never reached must not hold the next test's `after`.
afterEach(() => {
  afterGate = undefined;
});

afterAll(async () => {
  closeDb();
  await removeDbFiles();
});

/**
 * `sweep` fans out to `quick` and `park`; `quick` routes to `after`. With
 * `join`, `park` routes to `after` too, so `after` has both as predecessors.
 */
function definition(parker: Parker, join: boolean): WorkflowDefinition {
  const park: WorkflowNode =
    parker === "agent-task"
      ? { id: "park", type: "agent-task", config: { agentId, template: "Fix it" } }
      : {
          id: "park",
          type: "foreach",
          config: {
            over: "{{trigger.items}}",
            itemKey: "id",
            body: {
              type: "agent-task",
              config: { agentId: "{{item.id}}", template: "Fix {{item.id}}" },
            },
          },
        };
  return {
    nodes: [
      { id: "sweep", type: "record", config: {}, next: ["quick", "park"] },
      { id: "quick", type: "record", config: {}, next: "after" },
      { ...park, ...(join ? { next: "after" } : {}) },
      { id: "after", type: "record", config: {} },
    ],
  };
}

function harness() {
  const bus = new InProcessEventBus();
  const deps: ExecutorDependencies = {
    db,
    eventBus: bus,
    interpolate: (template, ctx) => interpolate(template, ctx).result,
  };
  const registry = new ExecutorRegistry();
  registry.register(new ForeachExecutor(deps));
  registry.register(new AgentTaskExecutor(deps));
  registry.register(new RecordExecutor(deps));
  setupWorkflowResumeListener(bus, registry);
  return { bus, registry };
}

async function start(def: WorkflowDefinition, items: Array<{ id: string }>, h = harness()) {
  const workflow = await createWorkflow({
    name: `parallel-park-${crypto.randomUUID()}`,
    definition: def,
  });
  const runId = await startWorkflowExecution(workflow, { items }, h.registry);
  return { ...h, runId };
}

const executions = (runId: string, nodeId: string) =>
  calls.filter((call) => call === `${runId}:${nodeId}`).length;

async function stepsOf(runId: string, nodeId: string) {
  return (await getWorkflowRunStepsByRunId(runId)).filter((step) => step.nodeId === nodeId);
}

const runStatus = async (runId: string) => (await getWorkflowRun(runId))?.status;

/** Complete every task the run dispatched, through the live resume listener. */
async function completeDispatchedTasks(runId: string, bus: InProcessEventBus): Promise<number> {
  let completed = 0;
  for (const step of await getWorkflowRunStepsByRunId(runId)) {
    const task = await getTaskByWorkflowRunStepId(step.id);
    if (!task) continue;
    await completeTask(task.id, "done");
    bus.emit("task.completed", {
      taskId: task.id,
      output: "done",
      workflowRunId: runId,
      workflowRunStepId: step.id,
    });
    completed++;
  }
  return completed;
}

describe("a node parks next to a completed sibling in one batch", () => {
  for (const parker of ["agent-task", "foreach"] as const) {
    test(`${parker}: the completed sibling's successor runs exactly once`, async () => {
      const { bus, registry, runId } = await start(definition(parker, false), [{ id: agentId }]);

      // The first walk runs `after` while `park` still waits on its task.
      expect(executions(runId, "after")).toBe(1);
      expect((await stepsOf(runId, "park")).map((step) => step.status)).toEqual(["waiting"]);
      expect(await runStatus(runId)).toBe("waiting");

      // A recovery sweep over the parked run starts nothing again.
      await recoverIncompleteRuns(registry);
      expect(executions(runId, "after")).toBe(1);
      expect(await runStatus(runId)).toBe("waiting");

      expect(await completeDispatchedTasks(runId, bus)).toBe(1);
      await waitFor(async () => (await runStatus(runId)) === "completed");
      await recoverIncompleteRuns(registry);

      expect(executions(runId, "after")).toBe(1);
      expect((await stepsOf(runId, "after")).map((step) => step.status)).toEqual(["completed"]);
      expect((await stepsOf(runId, "park")).map((step) => step.status)).toEqual(["completed"]);
      expect((await getWorkflowRun(runId))?.error).toBeFalsy();
    });

    test(`${parker}: a join downstream of both branches waits for the parked one`, async () => {
      const { bus, registry, runId } = await start(definition(parker, true), [{ id: agentId }]);

      expect(executions(runId, "quick")).toBe(1);
      expect(executions(runId, "after")).toBe(0);
      expect(await runStatus(runId)).toBe("waiting");

      await recoverIncompleteRuns(registry);
      expect(executions(runId, "after")).toBe(0);
      expect(await runStatus(runId)).toBe("waiting");

      expect(await completeDispatchedTasks(runId, bus)).toBe(1);
      await waitFor(async () => (await runStatus(runId)) === "completed");
      await recoverIncompleteRuns(registry);

      expect(executions(runId, "after")).toBe(1);
      expect((await stepsOf(runId, "after")).map((step) => step.status)).toEqual(["completed"]);
    });
  }

  test("the task completing while the successor still executes finalizes the run once", async () => {
    const entered = Promise.withResolvers<string>();
    const release = Promise.withResolvers<void>();
    afterGate = { entered: entered.resolve, release: release.promise };
    const h = harness();
    const walk = start(definition("agent-task", false), [{ id: agentId }], h);

    // `after` is in flight in the first walk when the parked task completes.
    const runId = await entered.promise;
    expect(await completeDispatchedTasks(runId, h.bus)).toBe(1);
    await waitFor(async () => (await stepsOf(runId, "park"))[0]?.status === "completed");
    expect(await runStatus(runId)).not.toBe("completed");

    release.resolve();
    await walk;
    await waitFor(async () => (await runStatus(runId)) === "completed");
    expect(executions(runId, "after")).toBe(1);
    expect((await stepsOf(runId, "after")).map((step) => step.status)).toEqual(["completed"]);
  });

  test("control: with no item the foreach does not park and the run completes in one walk", async () => {
    const { runId } = await start(definition("foreach", false), []);

    expect(await runStatus(runId)).toBe("completed");
    expect(executions(runId, "after")).toBe(1);
    expect((await stepsOf(runId, "after")).map((step) => step.status)).toEqual(["completed"]);
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
