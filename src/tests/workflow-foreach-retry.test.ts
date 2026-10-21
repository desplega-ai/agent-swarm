import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import * as db from "../be/db";
import {
  closeDb,
  completeTask,
  createAgent,
  createWorkflow,
  failTask,
  getDbClient,
  getTaskByWorkflowRunStepId,
  getWorkflow,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
} from "../be/db";
import type { Workflow, WorkflowDefinition, WorkflowRun, WorkflowRunStep } from "../types";
import { startWorkflowExecution } from "../workflows/engine";
import { workflowEventBus } from "../workflows/event-bus";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import { createExecutorRegistry } from "../workflows/executors/registry";
import { drainForeachDrives } from "../workflows/foreach-driver";
import { retryFailedRun, setupWorkflowResumeListener } from "../workflows/resume";

const TEST_DB_PATH = "./test-workflow-foreach-retry.sqlite";

const deps: ExecutorDependencies = {
  db,
  eventBus: workflowEventBus,
  interpolate: (t: string) => t,
};
const registry = createExecutorRegistry(deps);

/** Item ids the build step fails on; a test clears one to let its retry pass. */
const failingSpecs = new Set<string>();

/** The child workflow's one step: "builds" a spec, failing for `failingSpecs`. */
class BuildExecutor extends BaseExecutor<z.ZodObject, z.ZodObject> {
  readonly type = "test-build";
  readonly mode = "instant" as const;
  readonly configSchema = z.object({ spec: z.unknown(), deps: z.unknown().optional() });
  readonly outputSchema = z.object({ built: z.string(), deps: z.unknown().optional() });

  protected async execute(config: {
    spec: unknown;
    deps?: unknown;
  }): Promise<ExecutorResult<{ built: string; deps?: unknown }>> {
    // A sub-workflow passes a non-string input value as JSON text.
    const spec = parseJsonText(config.spec) as { id?: string } | undefined;
    const id = spec?.id ?? "?";
    if (failingSpecs.has(id)) return { status: "failed", error: `build of ${id} failed` };
    const deps = config.deps === "" ? undefined : parseJsonText(config.deps);
    return { status: "success", output: { built: `built-${id}`, ...(deps ? { deps } : {}) } };
  }
}
registry.register(new BuildExecutor(deps));

/**
 * Stands in for `swarm-script` (the scripts runtime is not booted here) and
 * runs the two scripts of the documented dependency-wave example.
 */
class WaveScriptExecutor extends BaseExecutor<z.ZodObject, z.ZodObject> {
  readonly type = "swarm-script";
  readonly mode = "instant" as const;
  readonly configSchema = z.object({
    scriptName: z.string(),
    args: z.record(z.string(), z.unknown()).default({}),
  });
  readonly outputSchema = z.object({ result: z.unknown() });

  protected async execute(config: {
    scriptName: string;
    args: Record<string, unknown>;
  }): Promise<ExecutorResult<{ result: unknown }>> {
    if (config.scriptName === "plan-waves") {
      return {
        status: "success",
        output: {
          result: {
            wave1: [{ id: "a" }, { id: "b" }],
            wave2: [{ id: "c", dependsOn: ["a", "b"] }],
          },
        },
      };
    }
    // prep-wave2: attach each wave-2 job's built dependencies from wave 1.
    const wave1 = config.args.wave1 as {
      results: Array<{ itemKey: string; output: { outputs: { build: unknown } } }>;
    };
    const wave2 = config.args.wave2 as Array<{ id: string; dependsOn: string[] }>;
    const done = Object.fromEntries(
      wave1.results.map((result) => [result.itemKey, result.output.outputs.build]),
    );
    return {
      status: "success",
      output: {
        result: wave2.map((job) => ({ ...job, deps: job.dependsOn.map((key) => done[key]) })),
      },
    };
  }
}
registry.register(new WaveScriptExecutor(deps));

function parseJsonText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

let teardown: (() => void) | undefined;
let agentId: string;

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  agentId = (await createAgent({ name: "Retrier", status: "idle" })).id;
  teardown = setupWorkflowResumeListener(workflowEventBus, registry);
});

afterAll(async () => {
  teardown?.();
  await drainForeachDrives();
  closeDb();
  await removeDbFiles();
});

describe("foreach run retry with attempt rows", () => {
  test("a retry reruns only the failed and cancelled items as new attempts", async () => {
    const runId = await failSecondOfFour();

    await retryFailedRun(runId, registry);
    await drainForeachDrives();

    const steps = await children(runId);
    const attemptOne = steps.filter((step) => attemptOf(step) === 1).map((step) => step.nodeId);
    expect(attemptOne.sort()).toEqual(["fan#i1", "fan#i2", "fan#i3"]);
    expect(steps.filter((step) => step.nodeId === "fan#i0")).toHaveLength(1);

    for (;;) {
      const [next] = await inFlightTasks(runId);
      if (!next) break;
      await completeTask(next.taskId, `retry ${next.nodeId}`);
      await waitForStep(next.stepId, "completed");
      await drainForeachDrives();
    }
    const run = await waitForRun(runId, (r) => r.status === "completed");
    expect(await taskCountForNode(runId, "fan#i0")).toBe(1);
    const aggregate = (run.context as Record<string, unknown>).fan as {
      okCount: number;
      failedCount: number;
      results: Array<{ itemKey: string; output: { taskOutput: unknown } }>;
    };
    expect(aggregate.okCount).toBe(4);
    expect(aggregate.failedCount).toBe(0);
    expect(aggregate.results.map((result) => result.output.taskOutput)).toEqual([
      "first ok",
      "retry fan#i1",
      "retry fan#i2",
      "retry fan#i3",
    ]);
  });

  test("two concurrent retries add one attempt row per item", async () => {
    const runId = await failSecondOfFour();
    const results = await Promise.allSettled([
      retryFailedRun(runId, registry),
      retryFailedRun(runId, registry),
    ]);
    await drainForeachDrives();
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const steps = await children(runId);
    for (const nodeId of ["fan#i1", "fan#i2", "fan#i3"]) {
      expect(steps.filter((step) => step.nodeId === nodeId)).toHaveLength(2);
    }
  });

  test("a retry that would breach the step cap is refused and the run stays failed", async () => {
    const runId = await failSecondOfFour();
    // 1 parent + 4 items exist; 3 attempts would make 8, and `after` needs headroom.
    const previous = process.env.WORKFLOW_MAX_STEPS_PER_RUN;
    process.env.WORKFLOW_MAX_STEPS_PER_RUN = "8";
    try {
      await expect(retryFailedRun(runId, registry)).rejects.toThrow("WORKFLOW_MAX_STEPS_PER_RUN");
    } finally {
      if (previous === undefined) delete process.env.WORKFLOW_MAX_STEPS_PER_RUN;
      else process.env.WORKFLOW_MAX_STEPS_PER_RUN = previous;
    }
    expect((await getWorkflowRun(runId))?.status).toBe("failed");
    expect(await children(runId)).toHaveLength(4);
  });

  test("a retry landing exactly on the cap of a terminal fan-out is refused and inserts nothing", async () => {
    const workflow = await makeWorkflow({
      nodes: [
        {
          id: "fan",
          type: "foreach",
          config: {
            over: [{ id: "a" }],
            itemKey: "id",
            body: { type: "agent-task", config: { agentId, template: "Item {{item.id}}" } },
          },
        },
      ],
    });
    const runId = await startWorkflowExecution(workflow, {}, registry);
    await drainForeachDrives();
    const [item] = await inFlightTasks(runId);
    await failTask(item!.taskId, "first failure");
    await waitForRun(runId, (r) => r.status === "failed");

    // 1 parent + 1 item exist; one attempt makes 3, which the retry walk's
    // circuit breaker refuses after the row is already in.
    const previous = process.env.WORKFLOW_MAX_STEPS_PER_RUN;
    process.env.WORKFLOW_MAX_STEPS_PER_RUN = "3";
    try {
      await expect(retryFailedRun(runId, registry)).rejects.toThrow("WORKFLOW_MAX_STEPS_PER_RUN");
    } finally {
      if (previous === undefined) delete process.env.WORKFLOW_MAX_STEPS_PER_RUN;
      else process.env.WORKFLOW_MAX_STEPS_PER_RUN = previous;
    }
    expect((await getWorkflowRun(runId))?.status).toBe("failed");
    expect((await children(runId)).map((step) => step.status)).toEqual(["failed"]);

    // The failed attempt is still the latest row, so a retry under a higher cap works.
    await retryFailedRun(runId, registry);
    await drainForeachDrives();
    const [replacement] = await inFlightTasks(runId);
    await completeTask(replacement!.taskId, "ok");
    await waitForRun(runId, (r) => r.status === "completed");
  });

  test("a sibling that fails while the retry checks readiness gets its own attempt", async () => {
    const workflow = await makeWorkflow({
      nodes: [
        {
          id: "fan",
          type: "foreach",
          config: {
            over: [{ id: "a" }, { id: "b" }],
            itemKey: "id",
            failurePolicy: "fail-fast",
            body: { type: "agent-task", config: { agentId, template: "Item {{item.id}}" } },
          },
        },
      ],
    });
    const runId = await startWorkflowExecution(workflow, {}, registry);
    await drainForeachDrives();
    const [first, second] = await inFlightTasks(runId);
    await failTask(first!.taskId, "a failed");
    await waitForRun(runId, (r) => r.status === "failed");

    // Hold the retry inside its awaited readiness check while b fails late.
    const foreach = registry.get("foreach");
    const checkReadiness = foreach.checkReadiness;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    foreach.checkReadiness = async () => {
      entered.resolve();
      await release.promise;
      return [];
    };
    const retry = retryFailedRun(runId, registry);
    try {
      await entered.promise;
      await failTask(second!.taskId, "b failed during the retry's readiness check");
      await waitForStep(second!.stepId, "failed");
    } finally {
      foreach.checkReadiness = checkReadiness;
      release.resolve();
      await retry;
    }
    await drainForeachDrives();

    const steps = await children(runId);
    expect(steps.filter((step) => step.nodeId === "fan#a")).toHaveLength(2);
    expect(steps.filter((step) => step.nodeId === "fan#b")).toHaveLength(2);
    for (const next of await inFlightTasks(runId)) {
      await completeTask(next.taskId, `retry ${next.nodeId}`);
    }
    const run = await waitForRun(runId, (r) => r.status === "completed");
    const aggregate = (run.context as Record<string, unknown>).fan as {
      okCount: number;
      failedCount: number;
    };
    expect(aggregate.okCount).toBe(2);
    expect(aggregate.failedCount).toBe(0);
  });

  test("a sub-workflow item retry starts a new child run and keeps the old one", async () => {
    const child = await makeWorkflow(buildWorkflow());
    const parent = await makeWorkflow({
      nodes: [
        {
          id: "fan",
          type: "foreach",
          config: {
            over: "{{trigger.items}}",
            itemKey: "id",
            failurePolicy: "fail-fast",
            body: {
              type: "sub-workflow",
              config: { workflowId: child.id, inputs: { spec: "{{item}}" } },
            },
          },
        },
      ],
    });
    failingSpecs.add("b");
    const runId = await startWorkflowExecution(
      parent,
      { items: [{ id: "a" }, { id: "b" }] },
      registry,
    );
    await drainForeachDrives();
    await waitForRun(runId, (r) => r.status === "failed");
    const failedAttempt = (await children(runId)).find((step) => step.nodeId === "fan#b")!;
    expect(failedAttempt.status).toBe("failed");

    failingSpecs.delete("b");
    await retryFailedRun(runId, registry);
    await drainForeachDrives();
    await waitForRun(runId, (r) => r.status === "completed");

    const attempts = (await children(runId)).filter((step) => step.nodeId === "fan#b");
    expect(attempts.map((step) => step.status)).toEqual(["failed", "completed"]);
    const childRuns = await getDbClient().query<{ parentStepId: string; status: string }>(
      "SELECT parentStepId, status FROM workflow_runs WHERE workflowId = ? ORDER BY startedAt",
      [child.id],
    );
    const forB = childRuns.filter((row) => attempts.some((step) => step.id === row.parentStepId));
    expect(forB).toHaveLength(2);
    expect(forB.find((row) => row.parentStepId === failedAttempt.id)?.status).toBe("failed");
    expect(forB.find((row) => row.parentStepId === attempts[1]!.id)?.status).toBe("completed");
  });
});

describe("dependency waves", () => {
  test("two caller-composed waves run end to end without changing the definition", async () => {
    const child = await makeWorkflow(buildWorkflow());
    const workflow = await makeWorkflow(twoWaveDefinition(child.id));
    const before = await getWorkflow(workflow.id);

    const runId = await startWorkflowExecution(workflow, {}, registry);
    await drainForeachDrives();
    const run = await waitForRun(runId, (r) => r.status === "completed");

    const wave2 = (run.context as Record<string, unknown>).wave2 as {
      okCount: number;
      results: Array<{ itemKey: string; output: { outputs: { build: { deps: unknown } } } }>;
    };
    expect(wave2.okCount).toBe(1);
    expect(wave2.results[0]?.output.outputs.build.deps).toEqual([
      { built: "built-a" },
      { built: "built-b" },
    ]);

    const after = await getWorkflow(workflow.id);
    expect(JSON.stringify(after?.definition)).toBe(JSON.stringify(before?.definition));
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });
});

/** The documented two-wave example (runbooks/workflows.md), with `workflowId` filled in. */
function twoWaveDefinition(buildWorkflowId: string): WorkflowDefinition {
  return {
    nodes: [
      { id: "plan", type: "swarm-script", config: { scriptName: "plan-waves" }, next: "wave1" },
      {
        id: "wave1",
        type: "foreach",
        inputs: { p: "plan" },
        config: {
          over: "{{p.result.wave1}}",
          itemKey: "id",
          concurrency: 3,
          failurePolicy: "fail-fast",
          body: {
            type: "sub-workflow",
            config: { workflowId: buildWorkflowId, inputs: { spec: "{{item}}" } },
          },
        },
        next: "prep2",
      },
      {
        id: "prep2",
        type: "swarm-script",
        inputs: { p: "plan", w1: "wave1" },
        config: {
          scriptName: "prep-wave2",
          args: { wave1: "{{w1}}", wave2: "{{p.result.wave2}}" },
        },
        next: "wave2",
      },
      {
        id: "wave2",
        type: "foreach",
        inputs: { prep: "prep2" },
        config: {
          over: "{{prep.result}}",
          itemKey: "id",
          concurrency: 3,
          body: {
            type: "sub-workflow",
            config: {
              workflowId: buildWorkflowId,
              inputs: { spec: "{{item}}", deps: "{{item.deps}}" },
            },
          },
        },
      },
    ],
  };
}

function buildWorkflow(): WorkflowDefinition {
  return {
    nodes: [
      {
        id: "build",
        type: "test-build",
        config: { spec: "{{trigger.spec}}", deps: "{{trigger.deps}}" },
      },
    ],
  };
}

/**
 * A 4-item agent-task fan-out, cap 1, fail-fast: item i0 completes, i1 fails,
 * i2 and i3 are cancelled before they start. Returns the failed run id.
 */
async function failSecondOfFour(): Promise<string> {
  const workflow = await makeWorkflow({
    nodes: [
      {
        id: "fan",
        type: "foreach",
        config: {
          over: "{{trigger.items}}",
          itemKey: "id",
          concurrency: 1,
          failurePolicy: "fail-fast",
          body: { type: "agent-task", config: { agentId, template: "Item {{item.id}}" } },
        },
        next: "after",
      },
      { id: "after", type: "notify", config: { channel: "swarm", template: "done" } },
    ],
  });
  const items = ["i0", "i1", "i2", "i3"].map((id) => ({ id }));
  const runId = await startWorkflowExecution(workflow, { items }, registry);
  await drainForeachDrives();
  const [first] = await inFlightTasks(runId);
  await completeTask(first!.taskId, "first ok");
  await waitForStep(first!.stepId, "completed");
  await drainForeachDrives();
  const [second] = await inFlightTasks(runId);
  await failTask(second!.taskId, "second broke");
  await waitForRun(runId, (r) => r.status === "failed");
  const statuses = (await children(runId)).map((step) => step.status);
  expect(statuses).toEqual(["completed", "failed", "cancelled", "cancelled"]);
  return runId;
}

function makeWorkflow(definition: WorkflowDefinition): Promise<Workflow> {
  return createWorkflow({ name: `foreach-retry-${crypto.randomUUID()}`, definition });
}

async function children(runId: string): Promise<WorkflowRunStep[]> {
  return (await getWorkflowRunStepsByRunId(runId)).filter((step) => step.nodeId.startsWith("fan#"));
}

function attemptOf(step: WorkflowRunStep): number {
  const attempt = (step.input as { attempt?: unknown } | null)?.attempt;
  return typeof attempt === "number" ? attempt : 0;
}

async function inFlightTasks(
  runId: string,
): Promise<Array<{ stepId: string; nodeId: string; taskId: string }>> {
  const result = [];
  for (const step of await children(runId)) {
    if (step.status !== "waiting" && step.status !== "running") continue;
    const task = await getTaskByWorkflowRunStepId(step.id);
    if (task) result.push({ stepId: step.id, nodeId: step.nodeId, taskId: task.id });
  }
  return result;
}

async function taskCountForNode(runId: string, nodeId: string): Promise<number> {
  const row = await getDbClient().get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM agent_tasks t
       JOIN workflow_run_steps s ON s.id = t.workflowRunStepId
       WHERE s.runId = ? AND s.nodeId = ?`,
    [runId, nodeId],
  );
  return row?.count ?? 0;
}

async function waitForStep(stepId: string, status: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if ((await db.getWorkflowRunStep(stepId))?.status === status) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for step ${stepId} to be ${status}`);
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
  throw new Error(`Timed out waiting for run ${runId}; last status ${run?.status} ${run?.error}`);
}

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(TEST_DB_PATH + suffix).catch(() => {});
  }
}
