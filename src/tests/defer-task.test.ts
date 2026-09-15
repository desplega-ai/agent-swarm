/**
 * Handler-level coverage for the `defer-task` MCP tool.
 *
 * `defer-task` completes the task the caller is working on and books a one-off
 * schedule that wakes the same agent up later with a child task whose
 * `parentTaskId` is the deferred task. The schedule row IS the state — there
 * is no new task status — so every test below asserts on the schedule row and
 * the task row together.
 *
 * The handler is pulled straight out of the SDK registry, same pattern as
 * `store-progress-attachments-handler.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  createWorkflow,
  createWorkflowRun,
  createWorkflowRunStep,
  getLogsByTaskId,
  getScheduledTasks,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";
import { registerDeferTaskTool } from "../tools/defer-task";

const TEST_DB_PATH = "./test-defer-task.sqlite";

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
  // The handler is the raw callback: calling it directly bypasses the SDK's
  // zod validation, so input-schema assertions go through this field.
  inputSchema: { safeParse: (value: unknown) => { success: boolean } };
};

type DeferTaskResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent: {
    success: boolean;
    message: string;
    yourAgentId?: string;
    taskId?: string;
    scheduleId?: string;
    nextRunAt?: string;
    nudge?: string;
  };
};

function buildTool(): RegisteredTool {
  const server = new McpServer({ name: "defer-task-test", version: "1.0.0" });
  registerDeferTaskTool(server);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = registered["defer-task"];
  if (!tool) throw new Error("defer-task tool not registered");
  return tool;
}

describe("defer-task handler", () => {
  let agentId: string;
  let otherAgentId: string;

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    agentId = (
      await createAgent({
        name: "Defer Worker",
        description: "Agent that defers tasks",
        role: "worker",
        isLead: false,
        status: "busy",
        maxTasks: 1,
        capabilities: [],
      })
    ).id;
    otherAgentId = (
      await createAgent({
        name: "Other Worker",
        description: "Agent that owns a different task",
        role: "worker",
        isLead: false,
        status: "busy",
        maxTasks: 1,
        capabilities: [],
      })
    ).id;
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  function meta(callerId: string = agentId) {
    return {
      sessionId: `session-${crypto.randomUUID()}`,
      requestInfo: { headers: { "x-agent-id": callerId } },
    };
  }

  async function startedTask(
    description: string,
    owner: string = agentId,
    extra: Partial<Parameters<typeof createTaskExtended>[1]> = {},
  ) {
    const task = await createTaskExtended(description, {
      agentId: owner,
      source: "mcp",
      priority: 70,
      modelTier: "smart",
      ...extra,
    });
    await startTask(task.id);
    return task;
  }

  async function schedulesForTask(taskId: string) {
    return (await getScheduledTasks({ hideCompleted: false })).filter(
      (s) => s.parentTaskId === taskId,
    );
  }

  const SUMMARY = "pushed the config change and kicked off deploy 42";

  test("delayMs path: completes the task and books a one-off wake-up schedule", async () => {
    const task = await startedTask("wait for the deploy to finish");
    const before = Date.now();

    const result = (await buildTool().handler(
      {
        taskId: task.id,
        delayMs: 1_800_000,
        summary: SUMMARY,
        note: "deploy 42 is still running",
        checks: ["deploy 42 status is green", "smoke tests pass"],
      },
      meta(),
    )) as DeferTaskResult;

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.taskId).toBe(task.id);
    // The NUDGES entry tells the caller to stop working on the task.
    expect(result.structuredContent.nudge).toContain("Stop working on this task now");

    const schedules = await schedulesForTask(task.id);
    expect(schedules.length).toBe(1);
    const schedule = schedules[0]!;
    expect(schedule.id).toBe(result.structuredContent.scheduleId!);
    expect(schedule.scheduleType).toBe("one_time");
    expect(schedule.targetType).toBe("agent-task");
    expect(schedule.targetAgentId).toBe(agentId);
    expect(schedule.createdByAgentId).toBe(agentId);
    expect(schedule.parentTaskId).toBe(task.id);
    expect(schedule.taskType).toBe("deferred");
    expect(schedule.tags).toContain("deferred");
    expect(schedule.priority).toBe(70);
    expect(schedule.modelTier).toBe("smart");
    expect(schedule.taskTemplate).toContain(`Resume task ${task.id}`);
    expect(schedule.taskTemplate).toContain("- deploy 42 status is green");
    // The wake-up run reads the summary through the parent task's context.
    expect(schedule.taskTemplate).not.toContain(SUMMARY);

    // nextRunAt ≈ now + delay (generous window; the handler stamps its own now)
    const nextRunMs = new Date(schedule.nextRunAt!).getTime();
    expect(nextRunMs).toBeGreaterThanOrEqual(before + 1_800_000);
    expect(nextRunMs).toBeLessThan(before + 1_800_000 + 60_000);
    expect(result.structuredContent.nextRunAt).toBe(schedule.nextRunAt!);

    const stored = await getTaskById(task.id);
    expect(stored?.status).toBe("completed");
    // Human-facing output: summary, plain-language pause line, no internals.
    expect(stored?.output).toStartWith(`${SUMMARY}\n\n⏳ Paused for about 30 minutes — back at `);
    expect(stored?.output).toContain("Waiting on: deploy 42 is still running");
    expect(stored?.output).toContain("Wake-up schedule: ");
    expect(stored?.output).not.toContain(schedule.nextRunAt!);
    expect(stored?.output).not.toContain(schedule.id);
    expect(stored?.output).not.toContain("Checks:");
    expect(stored?.output).not.toContain("- smoke tests pass");

    // Full detail (ISO timestamp, schedule id, checks) lands in the task log.
    const logs = (await getLogsByTaskId(task.id)).filter(
      (log) => log.eventType === "task_progress",
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]!.newValue).toBe(
      `${SUMMARY}\n\nDeferred until ${schedule.nextRunAt} (schedule ${schedule.id}). Pending: deploy 42 is still running\n\nChecks:\n- deploy 42 status is green\n- smoke tests pass`,
    );
  });

  test("runAt path is honoured verbatim", async () => {
    const task = await startedTask("wait for the reply");
    const runAt = new Date(Date.now() + 7_200_000).toISOString();

    const result = (await buildTool().handler(
      {
        taskId: task.id,
        runAt,
        summary: "asked the customer",
        note: "waiting on the customer reply",
      },
      meta(),
    )) as DeferTaskResult;

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.nextRunAt).toBe(runAt);

    const schedules = await schedulesForTask(task.id);
    expect(schedules.length).toBe(1);
    expect(schedules[0]!.nextRunAt).toBe(runAt);
    expect((await getTaskById(task.id))?.status).toBe("completed");
  });

  test("rejects both delayMs and runAt, and rejects neither", async () => {
    const both = await startedTask("both timings");
    const bothResult = (await buildTool().handler(
      {
        taskId: both.id,
        delayMs: 60_000,
        runAt: new Date(Date.now() + 60_000).toISOString(),
        summary: "did some work",
        note: "pending",
      },
      meta(),
    )) as DeferTaskResult;
    expect(bothResult.structuredContent.success).toBe(false);
    expect(bothResult.structuredContent.message).toContain("not both");
    expect((await schedulesForTask(both.id)).length).toBe(0);
    expect((await getTaskById(both.id))?.status).toBe("in_progress");

    const neither = await startedTask("no timing");
    const neitherResult = (await buildTool().handler(
      { taskId: neither.id, summary: "did some work", note: "pending" },
      meta(),
    )) as DeferTaskResult;
    expect(neitherResult.structuredContent.success).toBe(false);
    expect(neitherResult.structuredContent.message).toContain("delayMs or runAt");
    expect((await schedulesForTask(neither.id)).length).toBe(0);
    expect((await getTaskById(neither.id))?.status).toBe("in_progress");
  });

  test("an already-terminal task cannot be deferred and books no schedule", async () => {
    const task = await startedTask("already done");
    await completeTask(task.id, "finished");

    const result = (await buildTool().handler(
      { taskId: task.id, delayMs: 60_000, summary: "did some work", note: "pending" },
      meta(),
    )) as DeferTaskResult;

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toContain("already completed");
    expect((await schedulesForTask(task.id)).length).toBe(0);
  });

  test("another agent's task is refused and books no schedule", async () => {
    const task = await startedTask("not yours", otherAgentId);

    const result = (await buildTool().handler(
      { taskId: task.id, delayMs: 60_000, summary: "did some work", note: "pending" },
      meta(),
    )) as DeferTaskResult;

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toContain("not assigned to you");
    expect((await schedulesForTask(task.id)).length).toBe(0);
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
  });

  test("summary is required by the input schema", () => {
    const schema = buildTool().inputSchema;
    const base = { taskId: crypto.randomUUID(), delayMs: 60_000, note: "pending" };
    expect(schema.safeParse(base).success).toBe(false);
    expect(schema.safeParse({ ...base, summary: "" }).success).toBe(false);
    expect(schema.safeParse({ ...base, summary: SUMMARY }).success).toBe(true);
  });

  test("an unknown task is refused", async () => {
    const result = (await buildTool().handler(
      { taskId: crypto.randomUUID(), delayMs: 60_000, summary: "did some work", note: "pending" },
      meta(),
    )) as DeferTaskResult;

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toContain("not found");
  });

  test("a workflow-owned task cannot be deferred and books no schedule", async () => {
    const workflow = await createWorkflow({
      name: `defer-race-${crypto.randomUUID()}`,
      definition: { nodes: [] },
    });
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    await createWorkflowRun({ id: runId, workflowId: workflow.id });
    await createWorkflowRunStep({ id: stepId, runId, nodeId: "step", nodeType: "agent-task" });

    const task = await startedTask("workflow step", agentId, {
      workflowRunId: runId,
      workflowRunStepId: stepId,
    });

    const result = (await buildTool().handler(
      { taskId: task.id, delayMs: 60_000, summary: "did some work", note: "pending" },
      meta(),
    )) as DeferTaskResult;

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toContain("workflow");
    expect((await schedulesForTask(task.id)).length).toBe(0);
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
  });

  test("a task with an outputSchema requires explicit output and books no schedule", async () => {
    const task = await startedTask("structured output task", agentId, {
      outputSchema: {
        type: "object",
        required: ["result"],
        properties: { result: { type: "string" } },
      },
    });

    const result = (await buildTool().handler(
      { taskId: task.id, delayMs: 60_000, summary: "did some work", note: "pending" },
      meta(),
    )) as DeferTaskResult;

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toContain(
      "Call defer-task with output: a JSON string",
    );
    expect((await schedulesForTask(task.id)).length).toBe(0);
    const stored = await getTaskById(task.id);
    expect(stored?.status).toBe("in_progress");
    expect(stored?.output).toBeFalsy();
  });

  test("valid schema output is preserved verbatim and deferral details are logged", async () => {
    const task = await startedTask("structured deferral", agentId, {
      outputSchema: {
        type: "object",
        required: ["result"],
        properties: { result: { type: "string" } },
      },
    });
    const output = ' { "result": "deploy pending" }\n';
    const result = (await buildTool().handler(
      {
        taskId: task.id,
        delayMs: 60_000,
        summary: SUMMARY,
        note: "pending deploy",
        checks: ["check deploy"],
        output,
      },
      meta(),
    )) as DeferTaskResult;

    expect(result.structuredContent.success).toBe(true);
    const stored = await getTaskById(task.id);
    expect(stored?.status).toBe("completed");
    expect(stored?.output).toBe(output);
    const schedules = await schedulesForTask(task.id);
    expect(schedules).toHaveLength(1);
    const schedule = schedules[0]!;
    expect(schedule.taskTemplate).toBe(
      `Resume task ${task.id}: pending deploy\n\nChecks:\n- check deploy`,
    );
    const logs = (await getLogsByTaskId(task.id)).filter(
      (log) => log.eventType === "task_progress",
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]!.newValue).toBe(
      `${SUMMARY}\n\nDeferred until ${schedule.nextRunAt} (schedule ${schedule.id}). Pending: pending deploy\n\nChecks:\n- check deploy`,
    );
  });

  test.each([
    "not JSON",
    '{"result": 42}',
  ])("invalid schema output %s has no side effects", async (output) => {
    const task = await startedTask("invalid structured deferral", agentId, {
      outputSchema: {
        type: "object",
        required: ["result"],
        properties: { result: { type: "string" } },
      },
    });
    const result = (await buildTool().handler(
      { taskId: task.id, delayMs: 60_000, summary: SUMMARY, note: "pending", output },
      meta(),
    )) as DeferTaskResult;
    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toContain("outputSchema");
    expect(await schedulesForTask(task.id)).toHaveLength(0);
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
    expect((await getTaskById(task.id))?.output).toBeFalsy();
    expect(
      (await getLogsByTaskId(task.id)).filter((log) => log.eventType === "task_progress"),
    ).toHaveLength(0);
  });

  test("JSON string schema output can defer", async () => {
    const task = await startedTask("string output", agentId, { outputSchema: { type: "string" } });
    const output = '"pending"';
    const result = (await buildTool().handler(
      { taskId: task.id, delayMs: 60_000, summary: SUMMARY, note: "pending", output },
      meta(),
    )) as DeferTaskResult;
    expect(result.structuredContent.success).toBe(true);
    expect((await getTaskById(task.id))?.output).toBe(output);
  });

  test("explicit output is ignored without a schema", async () => {
    const task = await startedTask("unstructured output");
    const result = (await buildTool().handler(
      { taskId: task.id, delayMs: 60_000, summary: SUMMARY, note: "pending", output: '"ignored"' },
      meta(),
    )) as DeferTaskResult;
    expect(result.structuredContent.success).toBe(true);
    const stored = await getTaskById(task.id);
    expect(stored?.output).toStartWith(`${SUMMARY}\n\n⏳ Paused for about 1 minute — back at `);
    expect(stored?.output).toContain("Waiting on: pending");
    expect(stored?.output).not.toContain(result.structuredContent.scheduleId!);
  });

  test("human-facing output strips a repeated Pending: prefix and caps a long note", async () => {
    const task = await startedTask("verbose note");
    const longNote = `Pending: ${"x".repeat(300)}\nsecond line is dropped`;
    const result = (await buildTool().handler(
      { taskId: task.id, delayMs: 60_000, summary: SUMMARY, note: longNote },
      meta(),
    )) as DeferTaskResult;

    expect(result.structuredContent.success).toBe(true);
    const stored = await getTaskById(task.id);
    // No doubled "Pending: Pending:", no second line, capped with an ellipsis.
    expect(stored?.output).not.toContain("Pending: Pending:");
    expect(stored?.output).not.toContain("second line is dropped");
    expect(stored?.output).toContain(`Waiting on: ${"x".repeat(239)}…`);

    // The full untrimmed note still reaches the task log and the wake-up task.
    const logs = (await getLogsByTaskId(task.id)).filter(
      (log) => log.eventType === "task_progress",
    );
    expect(logs[0]!.newValue).toContain(`Pending: ${longNote}`);
    const schedules = await schedulesForTask(task.id);
    expect(schedules[0]!.taskTemplate).toContain(longNote);
  });

  test("the wake-up schedule carries modelTier but never the parent's concrete model", async () => {
    const task = await startedTask("pinned model task", agentId, {
      model: "claude-sonnet-5",
    });

    const result = (await buildTool().handler(
      { taskId: task.id, delayMs: 60_000, summary: "did some work", note: "pending" },
      meta(),
    )) as DeferTaskResult;

    expect(result.structuredContent.success).toBe(true);
    const schedules = await schedulesForTask(task.id);
    expect(schedules.length).toBe(1);
    expect(schedules[0]!.modelTier).toBe("smart");
    expect(schedules[0]!.model).toBeFalsy();
  });

  test("a competing terminal transition between schedule creation and completion aborts the loser and books no orphan schedule", async () => {
    const task = await startedTask("race target", agentId, { outputSchema: { type: "string" } });

    const [first, second] = (await Promise.all([
      buildTool().handler(
        {
          taskId: task.id,
          delayMs: 60_000,
          summary: "first writer",
          note: "pending A",
          output: '"first"',
        },
        meta(),
      ),
      buildTool().handler(
        {
          taskId: task.id,
          delayMs: 90_000,
          summary: "second writer",
          note: "pending B",
          output: '"second"',
        },
        meta(),
      ),
    ])) as [DeferTaskResult, DeferTaskResult];

    const results = [first, second];
    const succeeded = results.filter((r) => r.structuredContent.success);
    const failed = results.filter((r) => !r.structuredContent.success);

    // Both pass the early terminal check (neither has completed yet when it
    // reads); the FIFO transaction lock serializes their writes, so exactly
    // one wins the completeTask race and the other's completeTask() returns
    // null and must abort rather than substitute the stale pre-write task.
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);
    expect(failed[0]!.structuredContent.message).toContain("terminal state");

    const logs = (await getLogsByTaskId(task.id)).filter(
      (log) => log.eventType === "task_progress",
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]!.newValue).toContain(succeeded[0]!.structuredContent.scheduleId!);

    // The loser's schedule INSERT rolled back with its transaction — only
    // the winner's wake-up was committed. No orphan schedule.
    const schedules = await schedulesForTask(task.id);
    expect(schedules.length).toBe(1);

    const stored = await getTaskById(task.id);
    expect(stored?.status).toBe("completed");
  });
});
