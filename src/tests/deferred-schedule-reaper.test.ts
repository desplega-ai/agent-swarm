/**
 * Spent deferral timers are reaped once they age past the retention window,
 * whether the ceiling fired them or a watched task's settlement woke the
 * waiter early. The wake-up task keeps its `scheduleId` and stays readable.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeDb,
  completeTask,
  createAgent,
  createScheduledTask,
  createTaskExtended,
  getDbClient,
  getScheduledTaskById,
  getTaskById,
  initDb,
  startTask,
  updateScheduledTask,
} from "../be/db";
import {
  reapSpentDeferredSchedules,
  reconcileDeferredTaskWaits,
  SPENT_DEFERRED_SCHEDULE_RETENTION_MS,
} from "../scheduler/deferred-task-waits";
import { executeSchedule } from "../scheduler/scheduler";
import { registerDeferTaskTool } from "../tools/defer-task";

const TEST_DB_PATH = "./test-deferred-schedule-reaper.sqlite";
const DAY_MS = 24 * 60 * 60 * 1000;

type Result = { structuredContent: { success: boolean; message: string; scheduleId?: string } };
type Tool = { handler: (args: unknown, extra: unknown) => Promise<Result> };

let agentId: string;
let tool: Tool;

async function removeDbFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  agentId = (
    await createAgent({
      name: "Reap worker",
      isLead: false,
      status: "busy",
      capabilities: [],
      maxTasks: 10,
    })
  ).id;
  const server = new McpServer({ name: "reap-test", version: "1.0.0" });
  registerDeferTaskTool(server);
  tool = (server as unknown as { _registeredTools: Record<string, Tool> })._registeredTools[
    "defer-task"
  ]!;
});

afterAll(async () => {
  closeDb();
  await removeDbFiles();
});

async function activeTask() {
  const task = await createTaskExtended("work in progress", { agentId });
  await startTask(task.id);
  return task;
}

async function defer(taskId: string, extra: Record<string, unknown> = {}) {
  const result = await tool.handler(
    { taskId, delayMs: 3600000, summary: "Submitted", note: "Check the result", ...extra },
    { sessionId: crypto.randomUUID(), requestInfo: { headers: { "x-agent-id": agentId } } },
  );
  expect(result.structuredContent.success).toBe(true);
  return (await getScheduledTaskById(result.structuredContent.scheduleId!))!;
}

async function wakeTask(scheduleId: string) {
  const row = await getDbClient().get<{ id: string }>(
    "SELECT id FROM agent_tasks WHERE scheduleId = ?",
    [scheduleId],
  );
  return row ? getTaskById(row.id) : null;
}

async function waitRows(scheduleId: string) {
  const row = await getDbClient().get<{ waits: number; members: number }>(
    `SELECT (SELECT COUNT(*) FROM deferred_task_waits WHERE scheduleId = ?) AS waits,
            (SELECT COUNT(*) FROM deferred_task_wait_members WHERE scheduleId = ?) AS members`,
    [scheduleId, scheduleId],
  );
  return row!;
}

/** `now` just inside and just past the retention window, measured from lastRunAt. */
async function horizons(scheduleId: string) {
  const lastRunAt = (await getScheduledTaskById(scheduleId))!.lastRunAt!;
  const firedAt = new Date(lastRunAt).getTime();
  return {
    inside: new Date(firedAt + SPENT_DEFERRED_SCHEDULE_RETENTION_MS - DAY_MS),
    past: new Date(firedAt + SPENT_DEFERRED_SCHEDULE_RETENTION_MS + DAY_MS),
  };
}

describe("reapSpentDeferredSchedules", () => {
  test("timer fires: the spent row is kept inside the window and deleted past it", async () => {
    const parent = await activeTask();
    const schedule = await defer(parent.id);
    await executeSchedule(schedule);

    const fired = (await getScheduledTaskById(schedule.id))!;
    expect(fired.enabled).toBe(false);
    expect(fired.lastRunAt).toBeDefined();
    const wake = await wakeTask(schedule.id);
    expect(wake?.parentTaskId).toBe(parent.id);

    const { inside, past } = await horizons(schedule.id);
    await reapSpentDeferredSchedules(inside);
    expect(await getScheduledTaskById(schedule.id)).not.toBeNull();

    expect(await reapSpentDeferredSchedules(past)).toBeGreaterThanOrEqual(1);
    expect(await getScheduledTaskById(schedule.id)).toBeNull();
    // The wake-up task survives with its provenance id intact.
    const after = await getTaskById(wake!.id);
    expect(after?.scheduleId).toBe(schedule.id);
    expect(after?.parentTaskId).toBe(parent.id);
  });

  test("settlement wakes early: the disabled timer is reaped and its wait cascades", async () => {
    const parent = await activeTask();
    const producer = await activeTask();
    const schedule = await defer(parent.id, {
      wakeOn: { taskId: producer.id, event: "settled" },
    });
    expect(await waitRows(schedule.id)).toEqual({ waits: 1, members: 1 });

    await completeTask(producer.id, "ready");
    await reconcileDeferredTaskWaits(producer.id);
    const woken = (await getScheduledTaskById(schedule.id))!;
    // Woken before its ceiling: disabled with lastRunAt set, never left armed.
    expect(woken.enabled).toBe(false);
    expect(woken.nextRunAt).toBeUndefined();
    expect(woken.lastRunAt).toBeDefined();
    const wake = await wakeTask(schedule.id);
    expect(wake?.task).toContain(`Wake-up cause: task.completed for task ${producer.id}`);

    const { inside, past } = await horizons(schedule.id);
    await reapSpentDeferredSchedules(inside);
    expect(await getScheduledTaskById(schedule.id)).not.toBeNull();

    await reapSpentDeferredSchedules(past);
    expect(await getScheduledTaskById(schedule.id)).toBeNull();
    expect(await waitRows(schedule.id)).toEqual({ waits: 0, members: 0 });
    expect((await getTaskById(wake!.id))?.scheduleId).toBe(schedule.id);
  });

  test("armed, never-fired, and ordinary one-time schedules are never reaped", async () => {
    const farFuture = new Date(Date.now() + 10 * 365 * DAY_MS);

    const armed = await defer((await activeTask()).id);

    // Auto-disabled after a dispatch failure: no lastRunAt, kept as evidence.
    const neverFired = await defer((await activeTask()).id);
    await updateScheduledTask(neverFired.id, { enabled: false, lastErrorMessage: "boom" });

    const ordinary = await createScheduledTask({
      name: `ordinary-one-time-${crypto.randomUUID()}`,
      taskTemplate: "one-off",
      targetType: "agent-task",
      scheduleType: "one_time",
      nextRunAt: new Date(Date.now() + DAY_MS).toISOString(),
      targetAgentId: agentId,
    });
    await updateScheduledTask(ordinary.id, {
      enabled: false,
      nextRunAt: null,
      lastRunAt: new Date().toISOString(),
    });

    await reapSpentDeferredSchedules(farFuture);
    expect((await getScheduledTaskById(armed.id))?.enabled).toBe(true);
    expect(await getScheduledTaskById(neverFired.id)).not.toBeNull();
    expect(await getScheduledTaskById(ordinary.id)).not.toBeNull();
  });
});
