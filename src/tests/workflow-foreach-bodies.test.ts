import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import * as db from "../be/db";
import {
  closeDb,
  completeTask,
  createAgent,
  createWorkflow,
  getApprovalRequestByStepId,
  getDbClient,
  getTaskByWorkflowRunStepId,
  getWaitStateByStepId,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
  resolveApprovalRequest,
} from "../be/db";
import type { Workflow, WorkflowDefinition, WorkflowRun, WorkflowRunStep } from "../types";
import { validateDefinition } from "../workflows/definition";
import { startWorkflowExecution } from "../workflows/engine";
import { workflowEventBus } from "../workflows/event-bus";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import { createExecutorRegistry } from "../workflows/executors/registry";
import {
  FOREACH_BODY_ACCEPTED,
  FOREACH_BODY_REJECTED,
  isForeachBodyType,
} from "../workflows/foreach-body";
import { drainForeachDrives } from "../workflows/foreach-driver";
import { recoverIncompleteRuns } from "../workflows/recovery";
import {
  cancelWorkflowRun,
  resumeWaitState,
  setupWorkflowResumeListener,
} from "../workflows/resume";
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";

const TEST_DB_PATH = "./test-workflow-foreach-bodies.sqlite";
const spawnTest = test.skipIf(SKIP_SANDBOX_SPAWN_TESTS);

const deps: ExecutorDependencies = {
  db,
  eventBus: workflowEventBus,
  interpolate: (t: string) => t,
};
const registry = createExecutorRegistry(deps);
const builtInTypes = registry.types();

/** An instant node that echoes its config. */
class EchoExecutor extends BaseExecutor<z.ZodObject, z.ZodObject> {
  readonly type = "test-echo";
  readonly mode = "instant" as const;
  readonly configSchema = z.object({ value: z.string() });
  readonly outputSchema = z.object({ value: z.string() });

  protected async execute(config: { value: string }): Promise<ExecutorResult<{ value: string }>> {
    return { status: "success", output: { value: config.value } };
  }
}
registry.register(new EchoExecutor(deps));

/** An instant node whose first call blocks until `release()`; records each call. */
class GatedExecutor extends BaseExecutor<z.ZodObject, z.ZodObject> {
  readonly type = "test-gated";
  readonly mode = "instant" as const;
  readonly configSchema = z.object({ value: z.string() });
  readonly outputSchema = z.object({ value: z.string() });
  calls: Array<{ runId: string; stepId: string }> = [];
  release: () => void = () => {};
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  protected async execute(
    config: { value: string },
    _context: Readonly<Record<string, unknown>>,
    meta: { runId: string; stepId: string },
  ): Promise<ExecutorResult<{ value: string }>> {
    this.calls.push({ runId: meta.runId, stepId: meta.stepId });
    if (this.calls.length === 1) await this.gate;
    return { status: "success", output: { value: config.value } };
  }
}
const gated = new GatedExecutor(deps);
registry.register(gated);

/** Stands in for `swarm-script` (which needs the scripts runtime) and records each call. */
class RecordingSwarmScriptExecutor extends BaseExecutor<z.ZodObject, z.ZodObject> {
  readonly type = "swarm-script";
  readonly mode = "instant" as const;
  readonly configSchema = z.object({ name: z.string(), args: z.record(z.string(), z.unknown()) });
  readonly outputSchema = z.object({ result: z.unknown() });
  calls: Array<{ stepId: string; args: Record<string, unknown> }> = [];

  protected async execute(
    config: { name: string; args: Record<string, unknown> },
    _context: Readonly<Record<string, unknown>>,
    meta: { stepId: string },
  ): Promise<ExecutorResult<{ result: unknown }>> {
    this.calls.push({ stepId: meta.stepId, args: config.args });
    return { status: "success", output: { result: config.args } };
  }
}
const swarmScript = new RecordingSwarmScriptExecutor(deps);

let teardown: (() => void) | undefined;
let agentId: string;

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  agentId = (await createAgent({ name: "Fanout", status: "idle" })).id;
  teardown = setupWorkflowResumeListener(workflowEventBus, registry);
});

afterAll(async () => {
  teardown?.();
  await drainForeachDrives();
  closeDb();
  await removeDbFiles();
});

describe("foreach body policy", () => {
  test("every registered executor is accepted or rejected with a reason", () => {
    for (const type of builtInTypes) {
      const accepted = Object.hasOwn(FOREACH_BODY_ACCEPTED, type);
      const rejected = Object.hasOwn(FOREACH_BODY_REJECTED, type);
      // A new executor needs an explicit foreach-body decision.
      expect({ type, decided: accepted !== rejected }).toEqual({ type, decided: true });
      expect(isForeachBodyType(type, registry)).toBe(accepted);
    }
    expect(FOREACH_BODY_REJECTED.foreach).toContain("nested fan-out");
  });

  test("validation rejects a nested foreach body and an unknown body type", () => {
    const nested = validateDefinition(
      foreachOver({ type: "foreach", config: { over: [], itemKey: "id", body: {} } }),
      registry,
    );
    expect(nested.valid).toBe(false);
    expect(
      nested.errors.some(
        (error) => error.includes('Node "fan"') && error.includes("nested fan-out"),
      ),
    ).toBe(true);

    const unknown = validateDefinition(
      foreachOver({ type: "no-such-executor", config: {} }),
      registry,
    );
    expect(unknown.valid).toBe(false);
    expect(unknown.errors.some((error) => error.includes("is not a registered executor"))).toBe(
      true,
    );

    // Without the registry only the rejection list applies.
    expect(validateDefinition(foreachOver({ type: "no-such-executor", config: {} })).valid).toBe(
      true,
    );
    expect(
      validateDefinition(
        foreachOver({ type: "test-echo", config: { value: "{{item.name}}" } }),
        registry,
      ).valid,
    ).toBe(true);
  });

  test("static body config is validated against the body executor's schema", () => {
    const invalid = validateDefinition(
      foreachOver({ type: "script", config: { runtime: "cobol", script: "x" } }),
      registry,
    );
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.some((error) => error.includes("config.body.config.runtime"))).toBe(true);
  });
});

describe("foreach with any executor body", () => {
  test("a sub-workflow body runs one child workflow per item", async () => {
    const child = await makeWorkflow({
      nodes: [{ id: "echo", type: "test-echo", config: { value: "hi {{trigger.name}}" } }],
    });
    const parent = await makeWorkflow(
      foreachOver({
        type: "sub-workflow",
        config: { workflowId: child.id, inputs: { name: "{{item.name}}" } },
      }),
    );
    const runId = await startWorkflowExecution(parent, { items: ITEMS }, registry);
    const run = await waitForRun(runId, (r) => r.status === "completed");

    const children = await childSteps(runId);
    expect(children.map((step) => step.nodeType)).toEqual([
      "sub-workflow",
      "sub-workflow",
      "sub-workflow",
    ]);
    const childRuns = await getDbClient().query<{ parentStepId: string }>(
      "SELECT parentStepId FROM workflow_runs WHERE workflowId = ?",
      [child.id],
    );
    expect(childRuns.map((row) => row.parentStepId).sort()).toEqual(
      children.map((step) => step.id).sort(),
    );

    const aggregate = (run.context as Record<string, unknown>).fan as {
      results: Array<{ itemKey: string; status: string }>;
      okCount: number;
      failedCount: number;
    };
    expect(aggregate.okCount).toBe(3);
    expect(aggregate.failedCount).toBe(0);
    expect(aggregate.results.map((result) => result.itemKey)).toEqual(["a", "b", "c"]);
    expect((await stepByNodeId(runId, "after"))?.status).toBe("completed");
  });

  spawnTest("a script body runs once per item and a failing item fails alone", async () => {
    const workflow = await makeWorkflow({
      ...foreachOver({
        type: "script",
        config: {
          runtime: "bash",
          // bash -c puts the first arg in $0.
          script: 'if [ "$0" = "Bad" ]; then echo "boom" >&2; exit 3; fi; echo "item $0"',
          args: ["{{item.name}}"],
          timeout: 5_000,
        },
      }),
      onNodeFailure: "continue",
    });
    const runId = await startWorkflowExecution(
      workflow,
      { items: [...ITEMS.slice(0, 2), { id: "x", name: "Bad" }] },
      registry,
    );
    const run = await waitForRun(runId, (r) => r.status === "completed");

    const children = await childSteps(runId);
    expect(children.map((step) => [step.nodeType, step.status])).toEqual([
      ["script", "completed"],
      ["script", "completed"],
      ["script", "failed"],
    ]);
    expect(children[2]?.error).toBeTruthy();
    const aggregate = (run.context as Record<string, unknown>).fan as {
      okCount: number;
      failedCount: number;
    };
    expect(aggregate).toMatchObject({ okCount: 2, failedCount: 1 });
    // The parent step is authoritative: item failures are not a partial failure.
    expect(run.error).toBeUndefined();
    expect((await stepByNodeId(runId, "after"))?.status).toBe("completed");
  });

  spawnTest("instant items each get their own budget, outside the parent's", async () => {
    const definition = foreachOver({
      type: "script",
      config: { runtime: "bash", script: "sleep 0.6; echo ok", timeout: 5_000 },
    });
    // Three 0.6s items run back to back: 1.8s, past the parent's 1s budget.
    definition.nodes[0]!.config.timeoutMs = 1_000;
    const workflow = await makeWorkflow(definition);
    const runId = await startWorkflowExecution(workflow, { items: ITEMS }, registry);
    const run = await waitForRun(runId, (r) => r.status === "completed", 10_000);

    expect((await childSteps(runId)).map((step) => step.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(((run.context as Record<string, unknown>).fan as { okCount: number }).okCount).toBe(3);
  });

  spawnTest(
    "a parent alias named item or index cannot smuggle item data into script source",
    async () => {
      // `item` and `index` are per-item values. An alias with those names on the
      // parent must not make them look like an allowed (`workflow`) source.
      const definition = foreachOver({
        type: "script",
        config: { runtime: "bash", script: "echo {{item.name}} {{index}}", timeout: 5_000 },
      });
      definition.nodes[0]!.inputs = { item: "workflow.id", index: "workflow.id" };
      const workflow = await makeWorkflow({ ...definition, onNodeFailure: "continue" });
      const runId = await startWorkflowExecution(workflow, { items: ITEMS }, registry);
      await waitForRun(runId, (r) => r.status === "completed" || r.status === "failed");

      const children = await childSteps(runId);
      expect(children.map((step) => step.status)).toEqual(["failed", "failed", "failed"]);
      for (const child of children)
        expect(child.error).toContain("Script body interpolation failed");
      expect(JSON.stringify(children.map((child) => child.output ?? null))).not.toMatch(
        /Ada|Babbage|Curie/,
      );
    },
  );

  test("a swarm-script body runs once per item with per-item args", async () => {
    const original = registry.get("swarm-script");
    registry.register(swarmScript);
    try {
      const workflow = await makeWorkflow(
        foreachOver({
          type: "swarm-script",
          config: { name: "per-item", args: { name: "{{item.name}}", index: "{{index}}" } },
        }),
      );
      const runId = await startWorkflowExecution(workflow, { items: ITEMS }, registry);
      await waitForRun(runId, (r) => r.status === "completed");

      const children = await childSteps(runId);
      expect(swarmScript.calls.map((call) => call.stepId)).toEqual(children.map((s) => s.id));
      expect(swarmScript.calls.map((call) => call.args.name)).toEqual(["Ada", "Babbage", "Curie"]);
      expect(children.every((step) => step.nodeType === "swarm-script")).toBe(true);
    } finally {
      registry.register(original);
    }
  });

  test("a human-in-the-loop body settles each item and joins after the last", async () => {
    const workflow = await makeWorkflow(
      foreachOver({
        type: "human-in-the-loop",
        config: {
          title: "Approve {{item.name}}",
          questions: [{ id: "ok", type: "approval", label: "Ship {{item.name}}?" }],
          approvers: { policy: "any" },
        },
      }),
    );
    const runId = await startWorkflowExecution(workflow, { items: ITEMS.slice(0, 2) }, registry);
    expect((await getWorkflowRun(runId))?.status).toBe("waiting");

    const [first, second] = await childSteps(runId);
    expect(first?.nodeType).toBe("human-in-the-loop");
    await resolveApproval(runId, first!, "approved");
    await waitForStep(first!.id, "completed");
    expect((await stepByNodeId(runId, "fan"))?.status).toBe("waiting");
    expect(await stepByNodeId(runId, "after")).toBeUndefined();

    await resolveApproval(runId, second!, "rejected");
    const run = await waitForRun(runId, (r) => r.status === "completed");
    // A rejected item is a completed item that carries its port.
    expect((await stepById(runId, second!.id))?.nextPort).toBe("rejected");
    const aggregate = (run.context as Record<string, unknown>).fan as {
      okCount: number;
      results: Array<{ output: { status: string } }>;
    };
    expect(aggregate.okCount).toBe(2);
    expect(aggregate.results.map((result) => result.output.status)).toEqual([
      "approved",
      "rejected",
    ]);
    expect((await stepByNodeId(runId, "after"))?.status).toBe("completed");
  });

  test("a wait body settles each item when its wait fires", async () => {
    const workflow = await makeWorkflow(
      foreachOver({ type: "wait", config: { mode: "time", durationMs: 3_600_000 } }),
    );
    const runId = await startWorkflowExecution(workflow, { items: ITEMS.slice(0, 2) }, registry);
    expect((await getWorkflowRun(runId))?.status).toBe("waiting");

    const children = await childSteps(runId);
    expect(children.map((step) => [step.nodeType, step.status])).toEqual([
      ["wait", "waiting"],
      ["wait", "waiting"],
    ]);
    for (const child of children) {
      const wait = (await getWaitStateByStepId(child.id))!;
      await resumeWaitState(wait.id, "fired", undefined, registry);
    }
    const run = await waitForRun(runId, (r) => r.status === "completed");
    expect(((run.context as Record<string, unknown>).fan as { okCount: number }).okCount).toBe(2);
    expect((await stepByNodeId(runId, "after"))?.status).toBe("completed");
  });

  test.each([
    ["the body config", "{{trigger.items}}"],
    ["over", "{{ITEMS}}"],
  ])("install params render into %s", async (_path, over) => {
    const workflow = await createWorkflow({
      name: `foreach-bodies-${crypto.randomUUID()}`,
      params: { P: "hi", ITEMS },
      definition: {
        nodes: [
          {
            id: "fan",
            type: "foreach",
            config: {
              over,
              itemKey: "id",
              body: {
                type: "agent-task",
                config: { agentId, template: "Hello {{P}} {{item.name}}" },
              },
            },
          },
        ],
      },
    });
    const runId = await startWorkflowExecution(workflow, { items: ITEMS }, registry);
    expect((await getWorkflowRun(runId))?.status).toBe("waiting");

    const children = await childSteps(runId);
    expect(children.map((step) => step.status)).toEqual(["waiting", "waiting", "waiting"]);
    const prompts = await Promise.all(
      children.map(async (step) =>
        (await getTaskByWorkflowRunStepId(step.id))?.task.split("\n").at(-1),
      ),
    );
    expect(prompts).toEqual(["Hello hi Ada", "Hello hi Babbage", "Hello hi Curie"]);
  });

  test("a cancel during an instant body stops the rest of the batch", async () => {
    const workflow = await makeWorkflow(
      foreachOver({ type: "test-gated", config: { value: "x" } }),
    );
    const walk = startWorkflowExecution(workflow, { items: ITEMS }, registry);
    const deadline = Date.now() + 2_000;
    while (gated.calls.length === 0 && Date.now() < deadline) await Bun.sleep(5);
    const runId = gated.calls[0]!.runId;

    await cancelWorkflowRun(runId);
    gated.release();
    await walk;
    await drainForeachDrives();

    expect(gated.calls.map((call) => call.stepId)).toEqual([(await childSteps(runId))[0]!.id]);
    expect((await childSteps(runId)).map((step) => step.status)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
    expect((await getWorkflowRun(runId))?.status).toBe("cancelled");
  });
});

describe("foreach restart reconciliation", () => {
  test("a restart after claim re-drives each item once (agent-task and sub-workflow)", async () => {
    const taskRun = await startWorkflowExecution(
      await makeWorkflow(foreachOver(agentTaskBody())),
      { items: ITEMS },
      registry,
    );
    const [claimedNeverStarted, startedNeverParked, queued] = await childSteps(taskRun);
    // Crash after claim, before start: the row is `running` with no task.
    await getDbClient().run("DELETE FROM agent_tasks WHERE workflowRunStepId = ?", [
      claimedNeverStarted!.id,
    ]);
    await setStepStatus(claimedNeverStarted!.id, "running");
    // Crash after start, before park: `running` with its task.
    await setStepStatus(startedNeverParked!.id, "running");
    // Crash after a settlement, before the next drive: still queued.
    await getDbClient().run("DELETE FROM agent_tasks WHERE workflowRunStepId = ?", [queued!.id]);
    await setStepStatus(queued!.id, "pending");

    const child = await makeWorkflow({
      nodes: [{ id: "pause", type: "wait", config: { mode: "time", durationMs: 3_600_000 } }],
    });
    const subRun = await startWorkflowExecution(
      await makeWorkflow(
        foreachOver({ type: "sub-workflow", config: { workflowId: child.id, inputs: {} } }),
      ),
      { items: ITEMS.slice(0, 2) },
      registry,
    );
    const subChildren = await childSteps(subRun);
    for (const step of subChildren) await setStepStatus(step.id, "running");

    await recoverIncompleteRuns(registry);
    await recoverIncompleteRuns(registry);

    for (const step of await childSteps(taskRun)) {
      expect(step.status).toBe("waiting");
      expect(await countRows("agent_tasks", "workflowRunStepId", step.id)).toBe(1);
    }
    for (const step of await childSteps(subRun)) {
      expect(step.status).toBe("waiting");
      expect(await countRows("workflow_runs", "parentStepId", step.id)).toBe(1);
    }
    expect((await getWorkflowRun(taskRun))?.status).toBe("waiting");
    expect((await getWorkflowRun(subRun))?.status).toBe("waiting");
  });

  test("a restart during collection checkpoints the parent and starts successors once", async () => {
    teardown?.();
    try {
      const runId = await startWorkflowExecution(
        await makeWorkflow(foreachOver(agentTaskBody())),
        { items: ITEMS },
        registry,
      );
      const children = await childSteps(runId);
      for (const step of children) {
        await completeTask((await getTaskByWorkflowRunStepId(step.id))!.id, `done ${step.id}`);
      }
      teardown = setupWorkflowResumeListener(workflowEventBus, registry);

      await recoverIncompleteRuns(registry);
      // The listener replays a completion the sweep already routed.
      const task = (await getTaskByWorkflowRunStepId(children[0]!.id))!;
      workflowEventBus.emit("task.completed", {
        taskId: task.id,
        output: "replayed",
        workflowRunId: runId,
        workflowRunStepId: children[0]!.id,
      });
      await recoverIncompleteRuns(registry);
      await waitForRun(runId, (r) => r.status === "completed");
      await Bun.sleep(20);

      const steps = await getWorkflowRunStepsByRunId(runId);
      const parents = steps.filter((step) => step.nodeId === "fan");
      expect(parents.map((step) => step.status)).toEqual(["completed"]);
      expect(steps.filter((step) => step.nodeId === "after")).toHaveLength(1);
      expect(await stepById(runId, children[0]!.id)).toMatchObject({
        output: { taskOutput: `done ${children[0]!.id}` },
      });
    } finally {
      teardown?.();
      teardown = setupWorkflowResumeListener(workflowEventBus, registry);
    }
  });
});

const ITEMS = [
  { id: "a", name: "Ada" },
  { id: "b", name: "Babbage" },
  { id: "c", name: "Curie" },
];

function agentTaskBody(): { type: string; config: Record<string, unknown> } {
  return { type: "agent-task", config: { agentId, template: "Reflect {{item.name}}" } };
}

/** `fan` (a foreach over `trigger.items` with `body`) followed by `after`. */
function foreachOver(body: { type: string; config: Record<string, unknown> }): WorkflowDefinition {
  return {
    nodes: [
      {
        id: "fan",
        type: "foreach",
        config: { over: "{{trigger.items}}", itemKey: "id", body },
        next: "after",
      },
      {
        id: "after",
        type: "test-echo",
        inputs: { aggregate: "fan" },
        config: { value: "joined {{aggregate.okCount}}" },
      },
    ],
  };
}

function makeWorkflow(definition: WorkflowDefinition): Promise<Workflow> {
  return createWorkflow({ name: `foreach-bodies-${crypto.randomUUID()}`, definition });
}

async function childSteps(runId: string): Promise<WorkflowRunStep[]> {
  return (await getWorkflowRunStepsByRunId(runId)).filter((step) => step.nodeId.startsWith("fan#"));
}

async function stepByNodeId(runId: string, nodeId: string) {
  return (await getWorkflowRunStepsByRunId(runId)).find((step) => step.nodeId === nodeId);
}

async function stepById(runId: string, stepId: string) {
  return (await getWorkflowRunStepsByRunId(runId)).find((step) => step.id === stepId);
}

async function setStepStatus(stepId: string, status: string): Promise<void> {
  await getDbClient().run("UPDATE workflow_run_steps SET status = ? WHERE id = ?", [
    status,
    stepId,
  ]);
}

async function countRows(table: string, column: string, value: string): Promise<number> {
  const row = await getDbClient().get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`,
    [value],
  );
  return row?.count ?? 0;
}

async function resolveApproval(
  runId: string,
  step: WorkflowRunStep,
  status: "approved" | "rejected",
): Promise<void> {
  const request = (await getApprovalRequestByStepId(step.id))!;
  await resolveApprovalRequest(request.id, { status, responses: { ok: status === "approved" } });
  workflowEventBus.emit("approval.resolved", {
    requestId: request.id,
    status,
    responses: { ok: status === "approved" },
    workflowRunId: runId,
    workflowRunStepId: step.id,
  });
}

async function waitForStep(stepId: string, status: string): Promise<void> {
  const deadline = Date.now() + 2_000;
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
