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
  getScheduledTasks,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";
import { registerDeferTaskTool } from "../tools/defer-task";

const TEST_DB_PATH = "./test-defer-task.sqlite";

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
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

  async function startedTask(description: string, owner: string = agentId) {
    const task = await createTaskExtended(description, {
      agentId: owner,
      source: "mcp",
      priority: 70,
      modelTier: "smart",
    });
    await startTask(task.id);
    return task;
  }

  async function schedulesForTask(taskId: string) {
    return (await getScheduledTasks({ hideCompleted: false })).filter(
      (s) => s.parentTaskId === taskId,
    );
  }

  test("delayMs path: completes the task and books a one-off wake-up schedule", async () => {
    const task = await startedTask("wait for the deploy to finish");
    const before = Date.now();

    const result = (await buildTool().handler(
      {
        taskId: task.id,
        delayMs: 1_800_000,
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

    // nextRunAt ≈ now + delay (generous window; the handler stamps its own now)
    const nextRunMs = new Date(schedule.nextRunAt!).getTime();
    expect(nextRunMs).toBeGreaterThanOrEqual(before + 1_800_000);
    expect(nextRunMs).toBeLessThan(before + 1_800_000 + 60_000);
    expect(result.structuredContent.nextRunAt).toBe(schedule.nextRunAt!);

    const stored = await getTaskById(task.id);
    expect(stored?.status).toBe("completed");
    expect(stored?.output).toContain("deploy 42 is still running");
    expect(stored?.output).toContain(schedule.id);
  });

  test("runAt path is honoured verbatim", async () => {
    const task = await startedTask("wait for the reply");
    const runAt = new Date(Date.now() + 7_200_000).toISOString();

    const result = (await buildTool().handler(
      { taskId: task.id, runAt, note: "waiting on the customer reply" },
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
      { taskId: neither.id, note: "pending" },
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
      { taskId: task.id, delayMs: 60_000, note: "pending" },
      meta(),
    )) as DeferTaskResult;

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toContain("already completed");
    expect((await schedulesForTask(task.id)).length).toBe(0);
  });

  test("another agent's task is refused and books no schedule", async () => {
    const task = await startedTask("not yours", otherAgentId);

    const result = (await buildTool().handler(
      { taskId: task.id, delayMs: 60_000, note: "pending" },
      meta(),
    )) as DeferTaskResult;

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toContain("not assigned to you");
    expect((await schedulesForTask(task.id)).length).toBe(0);
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
  });

  test("an unknown task is refused", async () => {
    const result = (await buildTool().handler(
      { taskId: crypto.randomUUID(), delayMs: 60_000, note: "pending" },
      meta(),
    )) as DeferTaskResult;

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toContain("not found");
  });
});
