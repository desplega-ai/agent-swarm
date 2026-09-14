import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  cancelTask,
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  failTask,
  getDbClient,
  getScheduledTaskById,
  getTaskById,
  initDb,
  startTask,
  updateScheduledTask,
} from "../be/db";
import {
  dispatchDeferredTaskWait,
  initDeferredTaskWaits,
  reconcileDeferredTaskWaits,
  stopDeferredTaskWaits,
  type TaskWakeEvent,
} from "../scheduler/deferred-task-waits";
import { dispatchScheduleTarget, executeSchedule } from "../scheduler/scheduler";
import { registerDeferTaskTool } from "../tools/defer-task";

type Result = { structuredContent: { success: boolean; message: string; scheduleId?: string } };
type Tool = {
  handler: (args: unknown, extra: unknown) => Promise<Result>;
  inputSchema: { safeParse: (args: unknown) => { success: boolean } };
};
const templateGlobals = globalThis as typeof globalThis & { __testMigrationTemplate?: Uint8Array };
let savedTemplate: Uint8Array | undefined;
let dir: string;
let path: string;
let agentId: string;
let tool: Tool;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "task-wake-"));
  path = join(dir, "test.sqlite");
  // The preload normally deserializes a fresh in-memory DB on every initDb.
  // Use a real file here so close/reopen verifies durable restart recovery.
  savedTemplate = templateGlobals.__testMigrationTemplate;
  if (savedTemplate) await Bun.write(path, savedTemplate);
  delete templateGlobals.__testMigrationTemplate;
  initDb(path);
  agentId = (
    await createAgent({
      name: "Wake worker",
      isLead: false,
      status: "busy",
      capabilities: [],
      maxTasks: 10,
    })
  ).id;
  const server = new McpServer({ name: "wake-test", version: "1.0.0" });
  registerDeferTaskTool(server);
  tool = (server as unknown as { _registeredTools: Record<string, Tool> })._registeredTools[
    "defer-task"
  ]!;
});
afterEach(() => stopDeferredTaskWaits());
afterAll(async () => {
  closeDb();
  templateGlobals.__testMigrationTemplate = savedTemplate;
  await rm(dir, { recursive: true, force: true });
});

async function activeTask() {
  const task = await createTaskExtended("work in progress", {
    agentId,
    modelTier: "smart",
    priority: 70,
  });
  await startTask(task.id);
  return task;
}
async function defer(
  taskId: string,
  watchedId: string,
  event: TaskWakeEvent = "settled",
  extra: Record<string, unknown> = {},
) {
  return tool.handler(
    {
      taskId,
      wakeOn: { taskId: watchedId, event },
      delayMs: 3600000,
      summary: "Work submitted",
      note: "Check the producer result",
      checks: ["verify output"],
      ...extra,
    },
    { sessionId: crypto.randomUUID(), requestInfo: { headers: { "x-agent-id": agentId } } },
  );
}
async function fixture(event: TaskWakeEvent = "settled") {
  const parent = await activeTask();
  const producer = await activeTask();
  const result = await defer(parent.id, producer.id, event);
  expect(result.structuredContent.success).toBe(true);
  const schedule = await getScheduledTaskById(result.structuredContent.scheduleId!);
  return { parent, producer, schedule: schedule! };
}
async function children(scheduleId: string) {
  const rows = await getDbClient().query<{ id: string }>(
    "SELECT id FROM agent_tasks WHERE scheduleId = ?",
    [scheduleId],
  );
  return Promise.all(rows.map((row) => getTaskById(row.id)));
}
async function awaitChild(scheduleId: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const found = await children(scheduleId);
    if (found.length) return found[0]!;
    await Bun.sleep(5);
  }
  throw new Error("Event bus did not create a wake-up child");
}

describe("defer-task wakeOn", () => {
  test("event fires first: completion bus wakes the normal child and consumes the ceiling", async () => {
    await initDeferredTaskWaits();
    const { parent, producer, schedule } = await fixture("task.completed");
    await completeTask(producer.id, "ready");
    const child = await awaitChild(schedule.id);
    expect(child.parentTaskId).toBe(parent.id);
    expect(child.agentId).toBe(agentId);
    expect(child.modelTier).toBe("smart");
    expect(child.model).toBeUndefined();
    expect(child.priority).toBe(70);
    expect(child.taskType).toBe("deferred");
    expect(child.task).toContain(`Resume task ${parent.id}: Check the producer result`);
    expect(child.task).toContain("- verify output");
    expect(child.task).toContain(`Wake-up cause: task.completed for task ${producer.id}`);
    expect((await getScheduledTaskById(schedule.id))?.enabled).toBe(false);
    await executeSchedule(schedule); // stale poller snapshot after event dispatch
    await reconcileDeferredTaskWaits();
    expect(await children(schedule.id)).toHaveLength(1);
  });

  test("ceiling fires first: later task failure cannot create a second child", async () => {
    await initDeferredTaskWaits();
    const { producer, schedule } = await fixture();
    await executeSchedule(schedule);
    await failTask(producer.id, "failed later");
    await reconcileDeferredTaskWaits();
    const found = await children(schedule.id);
    expect(found).toHaveLength(1);
    expect(found[0]?.task).toContain("Wake-up cause: ceiling expired");
  });

  test("both race: event and ceiling dispatch commit exactly one child", async () => {
    const { producer, schedule } = await fixture();
    await completeTask(producer.id, "done");
    await Promise.all([
      reconcileDeferredTaskWaits(producer.id),
      executeSchedule(schedule),
      dispatchScheduleTarget(schedule),
      reconcileDeferredTaskWaits(producer.id),
    ]);
    const found = await children(schedule.id);
    expect(found).toHaveLength(1);
    const wait = await getDbClient().get<{ childTaskId: string; status: string }>(
      "SELECT childTaskId, status FROM deferred_task_waits WHERE scheduleId = ?",
      [schedule.id],
    );
    expect(wait?.childTaskId).toBe(found[0]!.id);
    expect(wait?.status).toBe("fired");
    expect((await getScheduledTaskById(schedule.id))?.nextRunAt).toBeUndefined();
  });

  test("restart mid-wait: persisted waits regain listeners and catch events missed while stopped", async () => {
    const live = await fixture("task.failed");
    const missed = await fixture("settled");
    stopDeferredTaskWaits();
    await completeTask(missed.producer.id, "completed while listener was down");
    closeDb();
    initDb(path);
    await initDeferredTaskWaits();
    expect(await children(missed.schedule.id)).toHaveLength(1);
    expect(await children(live.schedule.id)).toHaveLength(0);
    await failTask(live.producer.id, "failed after restart");
    expect((await awaitChild(live.schedule.id)).task).toContain("Wake-up cause: task.failed");
    await initDeferredTaskWaits();
    expect(await children(missed.schedule.id)).toHaveLength(1);
    expect(await children(live.schedule.id)).toHaveLength(1);
  });

  test("failed child creation rolls back the claim and preserves the ceiling for retry", async () => {
    const { producer, schedule } = await fixture();
    await completeTask(producer.id, "done");
    await updateScheduledTask(schedule.id, { taskTemplate: "" });
    await expect(dispatchDeferredTaskWait(schedule.id, "task.completed")).rejects.toThrow(
      "no taskTemplate",
    );
    expect(
      (
        await getDbClient().get<{ status: string }>(
          "SELECT status FROM deferred_task_waits WHERE scheduleId = ?",
          [schedule.id],
        )
      )?.status,
    ).toBe("pending");
    expect((await getScheduledTaskById(schedule.id))?.enabled).toBe(true);
    expect(await children(schedule.id)).toHaveLength(0);
    await updateScheduledTask(schedule.id, { taskTemplate: schedule.taskTemplate });
    await executeSchedule(schedule);
    expect(await children(schedule.id)).toHaveLength(1);
  });

  test("unmatched task or event does not wake; cancelled producer still has a ceiling", async () => {
    await initDeferredTaskWaits();
    const { producer, schedule } = await fixture("task.completed");
    const other = await activeTask();
    await completeTask(other.id, "unrelated");
    await failTask(producer.id, "wrong event");
    await reconcileDeferredTaskWaits();
    expect(await children(schedule.id)).toHaveLength(0);
    const cancelled = await fixture();
    await cancelTask(cancelled.producer.id, "cancelled");
    await reconcileDeferredTaskWaits();
    expect(await children(cancelled.schedule.id)).toHaveLength(0);
    await executeSchedule(cancelled.schedule);
    expect(await children(cancelled.schedule.id)).toHaveLength(1);
    await executeSchedule(schedule);
  });

  test("already terminal, missing, and self-watched tasks reject without completing the parent", async () => {
    const parent = await activeTask();
    const producer = await activeTask();
    await completeTask(producer.id, "already done");
    for (const [id, message] of [
      [producer.id, "already completed"],
      [crypto.randomUUID(), "not found"],
      [parent.id, "Cannot wake on"],
    ]) {
      const result = await defer(parent.id, id!);
      expect(result.structuredContent.success).toBe(false);
      expect(result.structuredContent.message).toContain(message!);
    }
    expect((await getTaskById(parent.id))?.status).toBe("in_progress");
    expect(
      await getDbClient().query("SELECT id FROM scheduled_tasks WHERE parentTaskId = ?", [
        parent.id,
      ]),
    ).toHaveLength(0);
  });

  test("wakeOn requires exactly one ceiling and schema permits only task event sources", async () => {
    const parent = await activeTask();
    const producer = await activeTask();
    for (const extra of [
      { delayMs: undefined },
      { runAt: new Date(Date.now() + 60000).toISOString() },
    ]) {
      expect(
        (await defer(parent.id, producer.id, "settled", extra)).structuredContent.success,
      ).toBe(false);
    }
    const base = { taskId: parent.id, summary: "done", note: "wait", delayMs: 60000 };
    expect(
      tool.inputSchema.safeParse({
        ...base,
        wakeOn: { taskId: producer.id, event: "checks.completed" },
      }).success,
    ).toBe(false);
    expect(
      tool.inputSchema.safeParse({ ...base, wakeOn: { taskId: producer.id, event: "settled" } })
        .success,
    ).toBe(true);
  });
});
