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
  getTaskByWorkflowRunStepId,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
} from "../be/db";
import type { Workflow, WorkflowDefinition } from "../types";
import { validateDefinition } from "../workflows/definition";
import { startWorkflowExecution, walkGraph } from "../workflows/engine";
import { InProcessEventBus } from "../workflows/event-bus";
import { AgentTaskExecutor } from "../workflows/executors/agent-task";
import {
  type AsyncExecutorResult,
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import { ForeachExecutor } from "../workflows/executors/foreach";
import { ExecutorRegistry } from "../workflows/executors/registry";
import { recoverIncompleteRuns } from "../workflows/recovery";
import {
  cancelWorkflowRun,
  retryFailedRun,
  setupWorkflowResumeListener,
} from "../workflows/resume";
import { startRetryPoller, stopRetryPoller } from "../workflows/retry-poller";
import { interpolate } from "../workflows/template";

const TEST_DB_PATH = "./test-workflow-foreach.sqlite";

class RecordExecutor extends BaseExecutor<
  typeof RecordExecutor.configSchema,
  typeof RecordExecutor.outputSchema
> {
  static readonly configSchema = z.object({ message: z.string() });
  static readonly outputSchema = z.object({ message: z.string() });

  readonly type = "record";
  readonly mode = "instant" as const;
  readonly configSchema = RecordExecutor.configSchema;
  readonly outputSchema = RecordExecutor.outputSchema;

  protected async execute(
    config: z.infer<typeof RecordExecutor.configSchema>,
  ): Promise<ExecutorResult<z.infer<typeof RecordExecutor.outputSchema>>> {
    return { status: "success", output: { message: config.message } };
  }
}

class FlakyAsyncExecutor extends BaseExecutor<
  typeof FlakyAsyncExecutor.configSchema,
  typeof FlakyAsyncExecutor.outputSchema
> {
  static readonly configSchema = z.object({});
  static readonly outputSchema = z.object({ ok: z.boolean() });

  readonly type = "flaky-async";
  readonly mode = "async" as const;
  readonly configSchema = FlakyAsyncExecutor.configSchema;
  readonly outputSchema = FlakyAsyncExecutor.outputSchema;
  attempts = 0;

  protected async execute(): Promise<
    ExecutorResult<z.infer<typeof FlakyAsyncExecutor.outputSchema>>
  > {
    this.attempts += 1;
    if (this.attempts === 1) {
      return { status: "failed", error: "transient dispatch failure" };
    }
    return {
      status: "success",
      async: true,
      waitFor: "task.completed",
      correlationId: "flaky",
    } as AsyncExecutorResult<z.infer<typeof FlakyAsyncExecutor.outputSchema>>;
  }
}

let agentItems: Array<{ id: string; name: string }>;

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  agentItems = ["Ada", "Babbage", "Curie"].map((name) => {
    const agent = createAgent({ name, status: "idle" });
    return { id: agent.id, name };
  });
});

afterAll(async () => {
  closeDb();
  await removeDbFiles();
});

describe("workflow foreach", () => {
  test("waits for all children, preserves item order, and runs the successor", async () => {
    const { bus, registry } = createRegistry(true);
    const workflow = makeWorkflow(foreachDefinition());
    const runId = await startWorkflowExecution(workflow, { items: agentItems }, registry);

    const childSteps = foreachChildren(runId);
    expect(childSteps).toHaveLength(3);
    expect(
      childSteps.map((step) => getTaskByWorkflowRunStepId(step.id)?.task.split("\n").at(-1)),
    ).toEqual(["Reflect Ada at 0", "Reflect Babbage at 1", "Reflect Curie at 2"]);

    await completeChild(runId, childSteps[0]!.id, "first", bus);
    expect(getWorkflowRun(runId)?.status).not.toBe("completed");
    expect(stepByNodeId(runId, "after")).toBeUndefined();

    await completeChild(runId, childSteps[1]!.id, "second", bus);
    expect(getWorkflowRun(runId)?.status).not.toBe("completed");
    expect(stepByNodeId(runId, "after")).toBeUndefined();

    await completeChild(runId, childSteps[2]!.id, "third", bus);
    await waitFor(() => getWorkflowRun(runId)?.status === "completed");

    expect(stepByNodeId(runId, "after")?.status).toBe("completed");
    const aggregate = getContext(runId).reflect as {
      results: Array<{ itemKey: string; output: { taskOutput: string } }>;
      okCount: number;
      failedCount: number;
    };
    expect(aggregate.results.map((result) => result.itemKey)).toEqual(
      agentItems.map((item) => item.id),
    );
    expect(aggregate.results.map((result) => result.output.taskOutput)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(aggregate.okCount).toBe(3);
    expect(aggregate.failedCount).toBe(0);
    expect(Object.keys(getContext(runId)).some((key) => key.startsWith("reflect#"))).toBe(false);
  });

  test("empty over completes synchronously and still runs the successor", async () => {
    const { registry } = createRegistry(false);
    const workflow = makeWorkflow(foreachDefinition());
    const runId = await startWorkflowExecution(workflow, { items: [] }, registry);

    expect(getWorkflowRun(runId)?.status).toBe("completed");
    expect(foreachChildren(runId)).toHaveLength(0);
    expect(stepByNodeId(runId, "after")?.status).toBe("completed");
    expect(getContext(runId).reflect).toEqual({ results: [], okCount: 0, failedCount: 0 });
  });

  test("onNodeFailure continue aggregates a failed child and completes", async () => {
    const { bus, registry } = createRegistry(true);
    const items = agentItems.slice(0, 2);
    const workflow = makeWorkflow({
      ...foreachDefinition(),
      onNodeFailure: "continue",
    });
    const runId = await startWorkflowExecution(workflow, { items }, registry);
    const children = foreachChildren(runId);

    await completeChild(runId, children[0]!.id, "ok", bus);
    await failChild(runId, children[1]!.id, "reflection broke", bus);
    await waitFor(() => getWorkflowRun(runId)?.status === "completed");

    const aggregate = getContext(runId).reflect as {
      results: Array<{ status: string; output: { taskOutput: string } }>;
      okCount: number;
      failedCount: number;
    };
    expect(aggregate.okCount).toBe(1);
    expect(aggregate.failedCount).toBe(1);
    expect(aggregate.results[1]?.status).toBe("failed");
    expect(aggregate.results[1]?.output.taskOutput).toStartWith("[FAILED: reflection broke]");
    // The failure is explicit metadata on the completed child, not just output text.
    expect(stepById(runId, children[1]!.id)?.error).toBe("reflection broke");
    expect(stepByNodeId(runId, "after")?.status).toBe("completed");
  });

  test("a successful child whose output text starts with [FAILED: is not misclassified", async () => {
    const { bus, registry } = createRegistry(true);
    const workflow = makeWorkflow(foreachDefinition());
    const runId = await startWorkflowExecution(
      workflow,
      { items: agentItems.slice(0, 1) },
      registry,
    );
    const child = foreachChildren(runId)[0]!;

    // A legitimate completion quoting a log line — user-controlled text, not the
    // continue-on-failure marker. Only step.error may mark a completed child failed.
    await completeChild(
      runId,
      child.id,
      "[FAILED: 3 assertions] was the CI summary I analyzed",
      bus,
    );
    await waitFor(() => getWorkflowRun(runId)?.status === "completed");

    const aggregate = getContext(runId).reflect as {
      results: Array<{ status: string }>;
      okCount: number;
      failedCount: number;
    };
    expect(aggregate.okCount).toBe(1);
    expect(aggregate.failedCount).toBe(0);
    expect(aggregate.results[0]?.status).toBe("completed");
  });

  test("foreach body config cannot read undeclared upstream outputs", async () => {
    const { registry } = createRegistry(false);
    const definition: WorkflowDefinition = {
      nodes: [
        {
          id: "seed",
          type: "record",
          config: { message: "classified" },
          next: "reflect",
        },
        {
          id: "reflect",
          type: "foreach",
          // `seed` is deliberately NOT declared in inputs — the deferred body pass
          // must obey the same explicit-dataflow boundary as normal node config.
          config: {
            over: "{{trigger.items}}",
            itemKey: "id",
            body: {
              type: "agent-task",
              config: {
                agentId: "{{item.id}}",
                template: "leak:{{seed.message}} name:{{item.name}}",
              },
            },
          },
        },
      ],
    };
    const workflow = makeWorkflow(definition);
    const runId = await startWorkflowExecution(
      workflow,
      { items: agentItems.slice(0, 1) },
      registry,
    );

    const child = foreachChildren(runId)[0]!;
    const task = getTaskByWorkflowRunStepId(child.id)!;
    expect(task.task.split("\n").at(-1)).toBe(`leak: name:${agentItems[0]!.name}`);
    expect(child.diagnostics).toContain("seed.message");
  });

  test("the retry poller rebuilds declared input aliases for a retried foreach", async () => {
    const { registry } = createRegistry(false);
    const definition: WorkflowDefinition = {
      nodes: [
        {
          id: "reflect",
          type: "foreach",
          inputs: { items: "trigger.items" },
          config: {
            over: "{{items}}",
            itemKey: "id",
            body: {
              type: "agent-task",
              config: { agentId: "{{item.id}}", template: "Retry reflect {{item.name}}" },
            },
          },
          retry: { maxRetries: 2, strategy: "static", baseDelayMs: 1, maxDelayMs: 10 },
          next: "after",
        },
        {
          id: "after",
          type: "record",
          inputs: { aggregate: "reflect" },
          config: { message: "ok" },
        },
      ],
    };
    const workflow = makeWorkflow(definition);
    const runId = await startWorkflowExecution(
      workflow,
      { items: agentItems.slice(0, 2) },
      registry,
    );
    expect(foreachChildren(runId)).toHaveLength(2);

    // Simulate a transient fan-out failure recorded for the retry poller: the
    // parent step failed before any child survived, run is failed, retry due.
    for (const child of foreachChildren(runId)) {
      db.getDb().prepare("DELETE FROM agent_tasks WHERE workflowRunStepId = ?").run(child.id);
      db.getDb().prepare("DELETE FROM workflow_run_steps WHERE id = ?").run(child.id);
    }
    const parent = stepByNodeId(runId, "reflect")!;
    db.updateWorkflowRunStep(parent.id, {
      status: "failed",
      error: "transient dispatch failure",
      nextRetryAt: new Date(Date.now() - 1000).toISOString(),
    });
    db.updateWorkflowRun(runId, { status: "failed" });

    try {
      startRetryPoller(registry, 10);
      // Without buildNodeInterpolationCtx on the retry path, {{items}} resolves to
      // "" from raw run.context, the config schema rejects it, and no child is
      // ever re-dispatched.
      await waitFor(() => foreachChildren(runId).length === 2);
      await waitFor(() => getWorkflowRun(runId)?.status === "waiting");
    } finally {
      stopRetryPoller();
    }
    expect(stepByNodeId(runId, "reflect")?.status).toBe("waiting");
    expect(taskCountForForeachChildren(runId)).toBe(2);
  });

  test("re-walk after partial completion does not duplicate children or tasks", async () => {
    const { bus, registry } = createRegistry(true);
    const definition = foreachDefinition();
    const workflow = makeWorkflow(definition);
    const runId = await startWorkflowExecution(workflow, { items: agentItems }, registry);
    const children = foreachChildren(runId);

    await completeChild(runId, children[0]!.id, "done", bus);
    const completedBefore = stepById(runId, children[0]!.id)!;
    const parentBefore = stepByNodeId(runId, "reflect")!;
    db.updateWorkflowRunStep(parentBefore.id, { status: "running" });
    const ctx = getContext(runId);
    await walkGraph(definition, runId, ctx, [definition.nodes[0]!], registry, workflow.id);

    const childrenAfterRewalk = foreachChildren(runId);
    expect(childrenAfterRewalk).toHaveLength(3);
    expect(childrenAfterRewalk.map((step) => step.id)).toEqual(children.map((step) => step.id));
    expect(taskCountForForeachChildren(runId)).toBe(3);
    const completedAfter = stepById(runId, children[0]!.id)!;
    expect(completedAfter.output).toEqual(completedBefore.output);
    expect(completedAfter.finishedAt).toBe(completedBefore.finishedAt);
    expect(
      getWorkflowRunStepsByRunId(runId).filter((step) => step.nodeId === "reflect"),
    ).toHaveLength(1);
  });

  test("recovery closes a join when tasks completed while listeners were down", async () => {
    const { registry } = createRegistry(false);
    const workflow = makeWorkflow(foreachDefinition());
    const runId = await startWorkflowExecution(workflow, { items: agentItems }, registry);

    const taskIds: string[] = [];
    for (const [index, step] of foreachChildren(runId).entries()) {
      const task = getTaskByWorkflowRunStepId(step.id)!;
      taskIds.push(task.id);
      completeTask(task.id, JSON.stringify({ recovered: index }));
    }

    const recovered = await recoverIncompleteRuns(registry);
    expect(recovered).toBe(3);
    expect(getWorkflowRun(runId)?.status).toBe("completed");
    expect(stepByNodeId(runId, "after")?.status).toBe("completed");
    const aggregate = getContext(runId).reflect as {
      results: Array<{ output: { taskId: string } }>;
    };
    expect(aggregate.results).toHaveLength(3);
    expect(aggregate.results.map((result) => result.output.taskId)).toEqual(taskIds);
  });

  test("retryFailedRun resolves a failed synthetic child to its foreach parent", async () => {
    const { bus, registry } = createRegistry(true);
    const items = agentItems.slice(0, 1);
    const workflow = makeWorkflow(foreachDefinition());
    const runId = await startWorkflowExecution(workflow, { items }, registry);
    const child = foreachChildren(runId)[0]!;
    const originalTask = getTaskByWorkflowRunStepId(child.id)!;

    await failChild(runId, child.id, "retry me", bus);
    await waitFor(() => getWorkflowRun(runId)?.status === "failed");

    await expect(retryFailedRun(runId, registry)).resolves.toBeUndefined();
    const replacementTask = getTaskByWorkflowRunStepId(child.id);
    expect(replacementTask).not.toBeNull();
    expect(replacementTask?.id).not.toBe(originalTask.id);
    expect(getWorkflowRun(runId)?.status).toBe("waiting");

    await completeChild(runId, child.id, "retried", bus);
    await waitFor(() => getWorkflowRun(runId)?.status === "completed");
    expect(stepByNodeId(runId, "after")?.status).toBe("completed");
    expect((getContext(runId).reflect as { okCount: number }).okCount).toBe(1);
    expect(stepById(runId, child.id)?.error).toBeUndefined();
    expect(getWorkflowRun(runId)?.error).toBeUndefined();
  });

  test("stale events from a superseded task cannot fail or complete a retried step", async () => {
    const { bus, registry } = createRegistry(true);
    const workflow = makeWorkflow(foreachDefinition());
    const runId = await startWorkflowExecution(
      workflow,
      { items: agentItems.slice(0, 1) },
      registry,
    );
    const child = foreachChildren(runId)[0]!;
    const originalTask = getTaskByWorkflowRunStepId(child.id)!;

    await failChild(runId, child.id, "first attempt broke", bus);
    await waitFor(() => getWorkflowRun(runId)?.status === "failed");
    await retryFailedRun(runId, registry);
    expect(getWorkflowRun(runId)?.status).toBe("waiting");

    // failTask's own after-commit bus emit lands on a later tick and can arrive
    // AFTER the retry re-dispatched the step with a new task (the exact sequence
    // that flaked CI shard 3). Neither a duplicate failure nor a completion for
    // the superseded task may touch the step.
    bus.emit("task.failed", {
      taskId: originalTask.id,
      failureReason: "first attempt broke",
      workflowRunId: runId,
      workflowRunStepId: child.id,
    });
    bus.emit("task.completed", {
      taskId: originalTask.id,
      output: "zombie output",
      workflowRunId: runId,
      workflowRunStepId: child.id,
    });
    await Bun.sleep(20);

    expect(getWorkflowRun(runId)?.status).toBe("waiting");
    expect(stepById(runId, child.id)?.status).toBe("waiting");

    await completeChild(runId, child.id, "real retry output", bus);
    await waitFor(() => getWorkflowRun(runId)?.status === "completed");
    const aggregate = getContext(runId).reflect as {
      results: Array<{ output: { taskOutput: string } }>;
    };
    expect(aggregate.results[0]?.output.taskOutput).toBe("real retry output");
  });

  test("nodes can reference their own run via the run.id context builtin", async () => {
    const { registry } = createRegistry(false);
    const workflow = makeWorkflow({
      nodes: [
        {
          id: "receipt",
          type: "record",
          inputs: { runId: "run.id" },
          config: { message: "run {{runId}}" },
        },
      ],
    });
    const runId = await startWorkflowExecution(workflow, {}, registry);

    expect(getWorkflowRun(runId)?.status).toBe("completed");
    expect((stepByNodeId(runId, "receipt")?.output as { message: string }).message).toBe(
      `run ${runId}`,
    );
  });

  test("late task cancellation cannot resurrect a cancelled run", async () => {
    const { bus, registry } = createRegistry(true);
    const workflow = makeWorkflow({ ...foreachDefinition(), onNodeFailure: "continue" });
    const runId = await startWorkflowExecution(
      workflow,
      { items: agentItems.slice(0, 1) },
      registry,
    );
    const child = foreachChildren(runId)[0]!;
    const task = getTaskByWorkflowRunStepId(child.id)!;

    cancelWorkflowRun(runId, "stop now");
    bus.emit("task.cancelled", {
      taskId: task.id,
      workflowRunId: runId,
      workflowRunStepId: child.id,
    });
    await Bun.sleep(10);

    expect(getWorkflowRun(runId)?.status).toBe("cancelled");
    expect(stepById(runId, child.id)?.status).toBe("cancelled");
    expect(stepByNodeId(runId, "after")).toBeUndefined();
  });

  test("recovery continues an offline failed child and closes the foreach join", async () => {
    const { registry } = createRegistry(false);
    const workflow = makeWorkflow({ ...foreachDefinition(), onNodeFailure: "continue" });
    const runId = await startWorkflowExecution(workflow, { items: agentItems }, registry);
    const children = foreachChildren(runId);

    const failedTask = getTaskByWorkflowRunStepId(children[0]!.id)!;
    failTask(failedTask.id, "offline failure");
    for (const [index, child] of children.slice(1).entries()) {
      const task = getTaskByWorkflowRunStepId(child.id)!;
      completeTask(task.id, `offline-${index}`);
    }

    const recovered = await recoverIncompleteRuns(registry);
    expect(recovered).toBe(3);
    expect(getWorkflowRun(runId)?.status).toBe("completed");
    expect(stepByNodeId(runId, "after")?.status).toBe("completed");
    const aggregate = getContext(runId).reflect as {
      results: Array<{ status: string; output: { taskOutput: string } }>;
      okCount: number;
      failedCount: number;
    };
    expect(aggregate.okCount).toBe(2);
    expect(aggregate.failedCount).toBe(1);
    expect(aggregate.results[0]?.status).toBe("failed");
    expect(aggregate.results[0]?.output.taskOutput).toStartWith(
      "[FAILED: Task failed (recovered)]",
    );
  });

  test("failed recovery rows prevent completed siblings from resurrecting a fail-fast run", async () => {
    const { registry } = createRegistry(false);
    const workflow = makeWorkflow(foreachDefinition());
    const runId = await startWorkflowExecution(
      workflow,
      { items: agentItems.slice(0, 2) },
      registry,
    );
    const children = foreachChildren(runId);
    failTask(getTaskByWorkflowRunStepId(children[0]!.id)!.id, "offline failure");
    completeTask(getTaskByWorkflowRunStepId(children[1]!.id)!.id, "offline success");

    const recovered = await recoverIncompleteRuns(registry);
    expect(recovered).toBe(1);
    expect(getWorkflowRun(runId)?.status).toBe("failed");
    expect(stepById(runId, children[0]!.id)?.status).toBe("failed");
    expect(stepById(runId, children[1]!.id)?.status).toBe("waiting");
    expect(stepByNodeId(runId, "after")).toBeUndefined();
  });

  test("foreach fails before dispatch when its children exceed the run step limit", async () => {
    const originalLimit = process.env.WORKFLOW_MAX_STEPS_PER_RUN;
    process.env.WORKFLOW_MAX_STEPS_PER_RUN = "3";
    try {
      const { registry } = createRegistry(false);
      const workflow = makeWorkflow(foreachDefinition());
      const runId = await startWorkflowExecution(workflow, { items: agentItems }, registry);

      expect(getWorkflowRun(runId)?.status).toBe("failed");
      expect(stepByNodeId(runId, "reflect")?.status).toBe("failed");
      expect(stepByNodeId(runId, "reflect")?.error).toContain("WORKFLOW_MAX_STEPS_PER_RUN");
      expect(foreachChildren(runId)).toHaveLength(0);
      expect(taskCountForForeachChildren(runId)).toBe(0);
    } finally {
      if (originalLimit === undefined) {
        delete process.env.WORKFLOW_MAX_STEPS_PER_RUN;
      } else {
        process.env.WORKFLOW_MAX_STEPS_PER_RUN = originalLimit;
      }
    }
  });

  test("foreach rejects a fan-out that lands exactly on the step cap when reaching it", async () => {
    // 1 existing (parent) + 3 children == cap of 4. Admitting this would spend all
    // child work and then trip walkGraph's inclusive `>=` breaker when routing the
    // "after" successor — so the executor must refuse upfront, before any dispatch.
    const originalLimit = process.env.WORKFLOW_MAX_STEPS_PER_RUN;
    process.env.WORKFLOW_MAX_STEPS_PER_RUN = "4";
    try {
      const { registry } = createRegistry(false);
      const workflow = makeWorkflow(foreachDefinition());
      const runId = await startWorkflowExecution(workflow, { items: agentItems }, registry);

      expect(getWorkflowRun(runId)?.status).toBe("failed");
      expect(stepByNodeId(runId, "reflect")?.error).toContain("WORKFLOW_MAX_STEPS_PER_RUN");
      expect(foreachChildren(runId)).toHaveLength(0);
      expect(taskCountForForeachChildren(runId)).toBe(0);
    } finally {
      if (originalLimit === undefined) {
        delete process.env.WORKFLOW_MAX_STEPS_PER_RUN;
      } else {
        process.env.WORKFLOW_MAX_STEPS_PER_RUN = originalLimit;
      }
    }
  });

  test("a terminal foreach (no successors) may land exactly on the step cap", async () => {
    // With no post-join walk to reserve headroom for, 1 parent + 3 children == cap 4
    // is legal: the last child closes the join and the run finalizes.
    const originalLimit = process.env.WORKFLOW_MAX_STEPS_PER_RUN;
    process.env.WORKFLOW_MAX_STEPS_PER_RUN = "4";
    try {
      const { registry } = createRegistry(false);
      const definition: WorkflowDefinition = {
        nodes: [
          {
            id: "reflect",
            type: "foreach",
            config: {
              over: "{{trigger.items}}",
              itemKey: "id",
              body: {
                type: "agent-task",
                config: { agentId: "{{item.id}}", template: "Terminal {{item.name}}" },
              },
            },
          },
        ],
      };
      const workflow = makeWorkflow(definition);
      const runId = await startWorkflowExecution(workflow, { items: agentItems }, registry);

      expect(getWorkflowRun(runId)?.status).toBe("waiting");
      expect(stepByNodeId(runId, "reflect")?.status).toBe("waiting");
      expect(foreachChildren(runId)).toHaveLength(3);

      // One item beyond the cap must still be refused.
      process.env.WORKFLOW_MAX_STEPS_PER_RUN = "3";
      const secondRun = await startWorkflowExecution(workflow, { items: agentItems }, registry);
      expect(getWorkflowRun(secondRun)?.status).toBe("failed");
      expect(stepByNodeId(secondRun, "reflect")?.error).toContain("WORKFLOW_MAX_STEPS_PER_RUN");
    } finally {
      if (originalLimit === undefined) {
        delete process.env.WORKFLOW_MAX_STEPS_PER_RUN;
      } else {
        process.env.WORKFLOW_MAX_STEPS_PER_RUN = originalLimit;
      }
    }
  });

  test("the retry poller rehydrates the run.id builtin for a never-checkpointed run", async () => {
    const { registry } = createRegistry(false);
    const definition: WorkflowDefinition = {
      nodes: [
        {
          id: "reflect",
          type: "foreach",
          inputs: { items: "trigger.items", runId: "run.id" },
          config: {
            over: "{{items}}",
            itemKey: "id",
            body: {
              type: "agent-task",
              config: { agentId: "{{item.id}}", template: "RetryRun {{runId}} {{item.name}}" },
            },
          },
          retry: { maxRetries: 2, strategy: "static", baseDelayMs: 1, maxDelayMs: 10 },
        },
      ],
    };
    const workflow = makeWorkflow(definition);
    const runId = await startWorkflowExecution(
      workflow,
      { items: agentItems.slice(0, 2) },
      registry,
    );
    expect(foreachChildren(runId)).toHaveLength(2);

    // Reset to a pre-checkpoint world: no children, parent failed and retry-due,
    // and a persisted context WITHOUT the walkGraph-hydrated `run` key.
    for (const child of foreachChildren(runId)) {
      db.getDb().prepare("DELETE FROM agent_tasks WHERE workflowRunStepId = ?").run(child.id);
      db.getDb().prepare("DELETE FROM workflow_run_steps WHERE id = ?").run(child.id);
    }
    const parent = stepByNodeId(runId, "reflect")!;
    db.updateWorkflowRunStep(parent.id, {
      status: "failed",
      error: "transient dispatch failure",
      nextRetryAt: new Date(Date.now() - 1000).toISOString(),
    });
    db.updateWorkflowRun(runId, {
      status: "failed",
      context: { trigger: { items: agentItems.slice(0, 2) } },
    });

    try {
      startRetryPoller(registry, 10);
      await waitFor(() => foreachChildren(runId).length === 2);
    } finally {
      stopRetryPoller();
    }
    const redispatched = db
      .getDb()
      .prepare(
        "SELECT t.task FROM agent_tasks t JOIN workflow_run_steps s ON s.id = t.workflowRunStepId WHERE s.runId = ?",
      )
      .all(runId) as Array<{ task: string }>;
    expect(redispatched).toHaveLength(2);
    for (const row of redispatched) {
      expect(row.task).toContain(`RetryRun ${runId}`);
    }
  });

  test("a grandfathered hash id can stay a normal node but never become a foreach parent", () => {
    const foreachWithHashId = {
      nodes: [
        {
          id: "legacy#fan",
          type: "foreach",
          config: {
            over: [],
            itemKey: "id",
            body: { type: "agent-task", config: { template: "Reflect" } },
          },
        },
      ],
    };
    const asForeach = validateDefinition(foreachWithHashId, undefined, {
      legacyNodeIds: new Set(["legacy#fan"]),
    });
    expect(asForeach.valid).toBe(false);
    expect(
      asForeach.errors.some((error) => error.includes('cannot be a foreach: its id contains "#"')),
    ).toBe(true);

    // The same grandfathered id stays editable as a NORMAL node.
    const asRecord = validateDefinition(
      { nodes: [{ id: "legacy#fan", type: "record", config: { message: "ok" } }] },
      undefined,
      { legacyNodeIds: new Set(["legacy#fan"]) },
    );
    expect(asRecord.valid).toBe(true);
  });

  test("all child rows are materialized before any child task is dispatched", async () => {
    // A real agent can complete an early child while later children are still
    // being set up; the join must never observe a partial child set. The
    // executor's pre-dispatch linkedTask lookup is the first per-child call on
    // the dispatch side, so the full fan-out must already be materialized then.
    let childRowsAtFirstDispatch: number | null = null;
    const wrappedDb: ExecutorDependencies["db"] = {
      ...db,
      getTaskByWorkflowRunStepId: (stepId: string) => {
        if (childRowsAtFirstDispatch === null) {
          const step = db.getWorkflowRunStep(stepId);
          if (step) {
            childRowsAtFirstDispatch = getWorkflowRunStepsByRunId(step.runId).filter((s) =>
              s.nodeId.startsWith("reflect#"),
            ).length;
          }
        }
        return getTaskByWorkflowRunStepId(stepId);
      },
    };
    const bus = new InProcessEventBus();
    const deps: ExecutorDependencies = {
      db: wrappedDb,
      eventBus: bus,
      interpolate: (template, ctx) => interpolate(template, ctx).result,
    };
    const registry = new ExecutorRegistry();
    registry.register(new ForeachExecutor(deps));
    registry.register(new AgentTaskExecutor(deps));
    registry.register(new RecordExecutor(deps));

    const workflow = makeWorkflow(foreachDefinition());
    const runId = await startWorkflowExecution(workflow, { items: agentItems }, registry);

    expect(childRowsAtFirstDispatch).toBe(3);
    expect(foreachChildren(runId)).toHaveLength(3);
    expect(taskCountForForeachChildren(runId)).toBe(3);
  });

  test("the retry poller keeps a re-dispatched async step waiting instead of routing successors", async () => {
    const bus = new InProcessEventBus();
    const deps: ExecutorDependencies = {
      db,
      eventBus: bus,
      interpolate: (template, ctx) => interpolate(template, ctx).result,
    };
    const registry = new ExecutorRegistry();
    const flaky = new FlakyAsyncExecutor(deps);
    registry.register(flaky);
    registry.register(new RecordExecutor(deps));

    const workflow = makeWorkflow({
      nodes: [
        {
          id: "dispatch",
          type: "flaky-async",
          config: {},
          retry: { maxRetries: 1, strategy: "static", baseDelayMs: 1, maxDelayMs: 10 },
          next: "after",
        },
        { id: "after", type: "record", config: { message: "routed" } },
      ],
    });

    const runId = await startWorkflowExecution(workflow, {}, registry);
    expect(flaky.attempts).toBe(1);

    try {
      startRetryPoller(registry, 10);
      await waitFor(() => flaky.attempts === 2);
      await waitFor(() => getWorkflowRun(runId)?.status === "waiting");
    } finally {
      stopRetryPoller();
    }

    // The second attempt returned the async marker — the step is waiting on task
    // events again, and the successor must not have run off the marker object.
    expect(stepByNodeId(runId, "dispatch")?.status).toBe("waiting");
    expect(stepByNodeId(runId, "after")).toBeUndefined();
    expect(getWorkflowRun(runId)?.status).toBe("waiting");
  });

  test("definition validation rejects node-level outputSchema and validation on foreach", () => {
    const base = {
      id: "reflect",
      type: "foreach",
      config: {
        over: [],
        itemKey: "id",
        body: { type: "agent-task", config: { template: "Reflect" } },
      },
    };
    const withOutputSchema = validateDefinition({
      nodes: [{ ...base, outputSchema: { type: "object" } }],
    });
    expect(withOutputSchema.valid).toBe(false);
    expect(
      withOutputSchema.errors.some((error) =>
        error.includes("node-level outputSchema/validation is not supported in v1"),
      ),
    ).toBe(true);

    const withValidation = validateDefinition({
      nodes: [{ ...base, validation: { rules: [] } }],
    });
    expect(withValidation.valid).toBe(false);
    expect(
      withValidation.errors.some((error) =>
        error.includes("node-level outputSchema/validation is not supported in v1"),
      ),
    ).toBe(true);
  });

  test("a foreach cannot share its synthetic child id space with a legacy hash node", () => {
    // A grandfathered `reflect#foo` node beside a `reflect` foreach would be
    // indistinguishable from reflect's own children — reject the foreach.
    const result = validateDefinition(
      {
        nodes: [
          {
            id: "reflect",
            type: "foreach",
            config: {
              over: [],
              itemKey: "id",
              body: { type: "agent-task", config: { template: "Reflect" } },
            },
            next: "reflect#foo",
          },
          { id: "reflect#foo", type: "record", config: { message: "legacy" } },
        ],
      },
      undefined,
      { legacyNodeIds: new Set(["reflect#foo"]) },
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((error) => error.includes("collides with its synthetic child id space")),
    ).toBe(true);
  });

  test("static foreach body config is validated against the agent-task schema at authoring", () => {
    const { registry } = createRegistry(false);
    const invalid = validateDefinition(
      {
        nodes: [
          {
            id: "reflect",
            type: "foreach",
            config: {
              over: "{{trigger.items}}",
              itemKey: "id",
              body: {
                type: "agent-task",
                config: { template: "Reflect", priority: 101, tags: "review" },
              },
            },
          },
        ],
      },
      registry,
    );
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.some((error) => error.includes("config.body.config.priority"))).toBe(
      true,
    );
    expect(invalid.errors.some((error) => error.includes("config.body.config.tags"))).toBe(true);

    // Interpolated fields still defer to execution-time validation.
    const deferred = validateDefinition(
      {
        nodes: [
          {
            id: "reflect",
            type: "foreach",
            config: {
              over: "{{trigger.items}}",
              itemKey: "id",
              body: {
                type: "agent-task",
                config: { template: "Reflect {{item.name}}", agentId: "{{item.id}}" },
              },
            },
          },
        ],
      },
      registry,
    );
    expect(deferred.valid).toBe(true);
  });

  test("definition validation rejects reserved hashes and foreach concurrency", () => {
    const hashResult = validateDefinition({
      nodes: [{ id: "reflect#bad", type: "record", config: { message: "bad" } }],
    });
    expect(hashResult.valid).toBe(false);
    expect(hashResult.errors.some((error) => error.includes('reserved character "#"'))).toBe(true);

    // A workflow stored BEFORE the reserved-# rule stays editable: update/patch
    // paths pass the stored definition's ids as legacyNodeIds, which exempts the
    // pre-existing id while a NEW hash id in the same definition is still rejected.
    const legacy = new Set(["legacy#node"]);
    const grandfathered = validateDefinition(
      { nodes: [{ id: "legacy#node", type: "record", config: { message: "old" } }] },
      undefined,
      { legacyNodeIds: legacy },
    );
    expect(grandfathered.valid).toBe(true);
    const newHashId = validateDefinition(
      {
        nodes: [
          { id: "legacy#node", type: "record", config: { message: "old" }, next: "fresh#node" },
          { id: "fresh#node", type: "record", config: { message: "new" } },
        ],
      },
      undefined,
      { legacyNodeIds: legacy },
    );
    expect(newHashId.valid).toBe(false);
    expect(
      newHashId.errors.some((error) => error.includes('Node "fresh#node" contains reserved')),
    ).toBe(true);

    const concurrencyResult = validateDefinition({
      nodes: [
        {
          id: "reflect",
          type: "foreach",
          config: {
            over: [],
            itemKey: "id",
            concurrency: 2,
            body: { type: "agent-task", config: { template: "Reflect" } },
          },
        },
      ],
    });
    expect(concurrencyResult.valid).toBe(false);
    expect(concurrencyResult.errors.some((error) => error.includes("not supported in v1"))).toBe(
      true,
    );
  });

  test("definition validation rejects foreach inside a cycle through a port edge", () => {
    const result = validateDefinition({
      nodes: [
        { id: "start", type: "record", config: { message: "start" }, next: "reflect" },
        {
          id: "reflect",
          type: "foreach",
          config: {
            over: [],
            itemKey: "id",
            body: { type: "agent-task", config: { template: "Reflect" } },
          },
          next: "loop",
        },
        {
          id: "loop",
          type: "record",
          config: { message: "loop" },
          next: { again: "reflect" },
        },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("foreach inside a loop is not supported in v1");
  });
});

function createRegistry(withListener: boolean): {
  bus: InProcessEventBus;
  registry: ExecutorRegistry;
} {
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
  if (withListener) setupWorkflowResumeListener(bus, registry);
  return { bus, registry };
}

function foreachDefinition(): WorkflowDefinition {
  return {
    nodes: [
      {
        id: "reflect",
        type: "foreach",
        config: {
          over: "{{trigger.items}}",
          itemKey: "id",
          body: {
            type: "agent-task",
            config: {
              agentId: "{{item.id}}",
              template: "Reflect {{item.name}} at {{index}}",
            },
          },
        },
        next: "after",
      },
      {
        id: "after",
        type: "record",
        inputs: { aggregate: "reflect" },
        config: { message: "joined {{aggregate.okCount}}" },
      },
    ],
  };
}

function makeWorkflow(definition: WorkflowDefinition): Workflow {
  return createWorkflow({
    name: `foreach-${crypto.randomUUID()}`,
    definition,
  });
}

function foreachChildren(runId: string) {
  return getWorkflowRunStepsByRunId(runId).filter((step) => step.nodeId.startsWith("reflect#"));
}

function stepByNodeId(runId: string, nodeId: string) {
  return getWorkflowRunStepsByRunId(runId).find((step) => step.nodeId === nodeId);
}

function taskCountForForeachChildren(runId: string): number {
  return (
    db
      .getDb()
      .prepare<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count
         FROM agent_tasks at
         JOIN workflow_run_steps wrs ON wrs.id = at.workflowRunStepId
         WHERE wrs.runId = ? AND wrs.nodeId LIKE 'reflect#%'`,
      )
      .get(runId)?.count ?? 0
  );
}

function getContext(runId: string): Record<string, unknown> {
  return (getWorkflowRun(runId)?.context ?? {}) as Record<string, unknown>;
}

async function completeChild(
  runId: string,
  stepId: string,
  output: string,
  bus: InProcessEventBus,
): Promise<void> {
  const task = getTaskByWorkflowRunStepId(stepId)!;
  completeTask(task.id, output);
  bus.emit("task.completed", {
    taskId: task.id,
    output,
    workflowRunId: runId,
    workflowRunStepId: stepId,
  });
  await waitFor(() => stepById(runId, stepId)?.status === "completed");
}

async function failChild(
  runId: string,
  stepId: string,
  reason: string,
  bus: InProcessEventBus,
): Promise<void> {
  const task = getTaskByWorkflowRunStepId(stepId)!;
  failTask(task.id, reason);
  bus.emit("task.failed", {
    taskId: task.id,
    failureReason: reason,
    workflowRunId: runId,
    workflowRunStepId: stepId,
  });
  await waitFor(() => {
    const status = stepById(runId, stepId)?.status;
    return status === "completed" || status === "failed";
  });
}

function stepById(runId: string, stepId: string) {
  return getWorkflowRunStepsByRunId(runId).find((step) => step.id === stepId);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for workflow state");
}

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(TEST_DB_PATH + suffix).catch(() => {});
  }
}
