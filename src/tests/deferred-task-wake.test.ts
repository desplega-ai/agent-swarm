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
  createScheduledTask,
  createTaskExtended,
  deleteScheduledTask,
  failTask,
  getDbClient,
  getLogsByTaskId,
  getScheduledTaskById,
  getTaskById,
  initDb,
  startTask,
  supersedeTask,
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
import { createResumeFollowUp } from "../tasks/worker-follow-up";
import { registerDeferTaskTool } from "../tools/defer-task";
import type { AgentTask } from "../types";

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
async function waitState(scheduleId: string) {
  return getDbClient().get<{
    taskId: string;
    status: string;
    firedBy: string | null;
    childTaskId: string | null;
    resolvedAt: string | null;
    updated_at: string;
  }>(
    `SELECT w.*, m.taskId FROM deferred_task_waits w
     JOIN deferred_task_wait_members m ON m.scheduleId = w.scheduleId
     WHERE w.scheduleId = ?`,
    [scheduleId],
  );
}

async function resumeTask(parentId: string) {
  const result = await createResumeFollowUp({ parentId, reason: "manual_supersede" });
  if (result.kind !== "created") throw new Error(`Resume creation failed: ${result.kind}`);
  return result.task;
}

async function awaitWatchedTask(scheduleId: string, taskId: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if ((await waitState(scheduleId))?.taskId === taskId) return;
    await Bun.sleep(5);
  }
  throw new Error("Event bus did not transfer the watched task");
}

async function multiFixture(mode?: "all" | "any", event: TaskWakeEvent = "settled") {
  const parent = await activeTask();
  const producers = [await activeTask(), await activeTask()];
  const result = await defer(parent.id, producers[0]!.id, event, {
    wakeOn: { taskIds: producers.map((producer) => producer.id), event, mode },
  });
  expect(result.structuredContent.success).toBe(true);
  const schedule = (await getScheduledTaskById(result.structuredContent.scheduleId!))!;
  return { parent, producers, schedule };
}

describe("defer-task wakeOn", () => {
  test.each([
    "completed",
    "failed",
    "cancelled",
  ])("all is the default and waits for the final member to be %s", async (status) => {
    const { producers, schedule } = await multiFixture();
    await completeTask(producers[0]!.id, "first result");
    await reconcileDeferredTaskWaits(producers[0]!.id);
    expect(await children(schedule.id)).toHaveLength(0);
    // The dispatch entry point must also enforce the whole set.
    expect(await dispatchDeferredTaskWait(schedule.id, "task.completed")).toEqual({});
    if (status === "completed") await completeTask(producers[1]!.id, "second result");
    else if (status === "failed") await failTask(producers[1]!.id, "second result failed");
    else await cancelTask(producers[1]!.id, "second result cancelled");
    await reconcileDeferredTaskWaits(producers[1]!.id);
    const found = await children(schedule.id);
    expect(found).toHaveLength(1);
    expect(found[0]!.task).toContain("all tasks matched settled");
    expect(found[0]!.task).toContain(`${producers[1]!.id} (${status})`);
    expect((await getScheduledTaskById(schedule.id))?.enabled).toBe(false);
  });

  test.each([
    "completed",
    "failed",
    "cancelled",
  ])("explicit any wakes on the first %s member", async (status) => {
    const { producers, schedule } = await multiFixture("any");
    if (status === "completed") await completeTask(producers[1]!.id, "ready");
    else if (status === "failed") await failTask(producers[1]!.id, "failed");
    else await cancelTask(producers[1]!.id, "cancelled");
    await reconcileDeferredTaskWaits(producers[1]!.id);
    expect(await children(schedule.id)).toHaveLength(1);
    expect((await children(schedule.id))[0]!.task).toContain("any tasks matched settled");
    expect((await getTaskById(producers[0]!.id))?.status).toBe("in_progress");
    await completeTask(producers[0]!.id, "later");
    await reconcileDeferredTaskWaits();
    await executeSchedule(schedule);
    expect(await children(schedule.id)).toHaveLength(1);
  });

  test("all follows one member through repeated deferrals and restart without extending the ceiling", async () => {
    const { producers, schedule } = await multiFixture("all");
    await completeTask(producers[0]!.id, "ready");
    let current = producers[1]!;
    for (let step = 0; step < 2; step++) {
      const deferred = await defer(current.id, current.id, "settled", { wakeOn: undefined });
      expect(deferred.structuredContent.success).toBe(true);
      await reconcileDeferredTaskWaits(current.id);
      expect(await children(schedule.id)).toHaveLength(0);
      expect(await dispatchDeferredTaskWait(schedule.id, "task.completed")).toEqual({});
      const successor = (await getScheduledTaskById(deferred.structuredContent.scheduleId!))!;
      await executeSchedule(successor);
      current = (await children(successor.id))[0]!;
      closeDb();
      initDb(path);
      await initDeferredTaskWaits();
      expect(await children(schedule.id)).toHaveLength(0);
      expect((await getScheduledTaskById(schedule.id))?.nextRunAt).toBe(schedule.nextRunAt);
    }
    await completeTask(current.id, "final result");
    const child = await awaitChild(schedule.id);
    expect(child.task).toContain(`${current.id} (completed)`);
    expect(child.task).toContain(`${producers[0]!.id} (completed)`);
    expect(await children(schedule.id)).toHaveLength(1);
  });

  test("any ignores a deferred completion until another member really settles", async () => {
    const { producers, schedule } = await multiFixture("any");
    await defer(producers[0]!.id, producers[0]!.id, "settled", { wakeOn: undefined });
    await reconcileDeferredTaskWaits();
    expect(await children(schedule.id)).toHaveLength(0);
    await failTask(producers[1]!.id, "real failure");
    await reconcileDeferredTaskWaits(producers[1]!.id);
    expect(await children(schedule.id)).toHaveLength(1);
  });

  test("the set's ceiling fires before all settle and later events cannot duplicate it", async () => {
    const { producers, schedule } = await multiFixture();
    await completeTask(producers[0]!.id, "ready");
    await reconcileDeferredTaskWaits();
    expect(await children(schedule.id)).toHaveLength(0);
    await executeSchedule(schedule);
    expect((await children(schedule.id))[0]!.task).toContain("ceiling expired");
    await completeTask(producers[1]!.id, "late");
    await reconcileDeferredTaskWaits();
    expect(await children(schedule.id)).toHaveLength(1);
    expect((await waitState(schedule.id))?.firedBy).toBe("ceiling");
  });

  test.each([
    "all",
    "any",
  ] as const)("%s concurrent terminal events and the ceiling create exactly one child", async (mode) => {
    const { producers, schedule } = await multiFixture(mode);
    await initDeferredTaskWaits();
    await Promise.all([
      completeTask(producers[0]!.id, "ready"),
      failTask(producers[1]!.id, "failed"),
      executeSchedule(schedule),
    ]);
    await reconcileDeferredTaskWaits();
    const found = await children(schedule.id);
    expect(found).toHaveLength(1);
    expect((await waitState(schedule.id))?.childTaskId).toBe(found[0]!.id);
  });

  test.each([
    "all",
    "any",
  ] as const)("%s respects event filters when a member fails", async (mode) => {
    const { producers, schedule } = await multiFixture(mode, "task.completed");
    await failTask(producers[0]!.id, "wrong event");
    await reconcileDeferredTaskWaits();
    expect(await children(schedule.id)).toHaveLength(0);
    await completeTask(producers[1]!.id, "right event");
    await reconcileDeferredTaskWaits();
    expect(await children(schedule.id)).toHaveLength(mode === "all" ? 0 : 1);
    await executeSchedule(schedule);
    expect(await children(schedule.id)).toHaveLength(1);
  });

  test("one invalid member rejects the entire set before any schedule or completion is committed", async () => {
    const parent = await activeTask();
    const valid = await activeTask();
    const terminal = await activeTask();
    await completeTask(terminal.id, "done");
    for (const mode of ["all", "any"]) {
      for (const [id, message] of [
        [terminal.id, "already completed"],
        [crypto.randomUUID(), "not found"],
        [parent.id, "Cannot wake on"],
      ]) {
        const result = await defer(parent.id, valid.id, "settled", {
          wakeOn: { taskIds: [valid.id, id], event: "settled", mode },
        });
        expect(result.structuredContent.success).toBe(false);
        expect(result.structuredContent.message).toContain(message!);
      }
    }
    expect((await getTaskById(parent.id))?.status).toBe("in_progress");
    expect(
      await getDbClient().query("SELECT id FROM scheduled_tasks WHERE parentTaskId = ?", [
        parent.id,
      ]),
    ).toHaveLength(0);
  });

  test("multi-ID schema rejects empty, duplicate, ambiguous, or missing IDs and invalid modes", async () => {
    const parent = await activeTask();
    const producer = await activeTask();
    const base = { taskId: parent.id, summary: "done", note: "wait", delayMs: 60000 };
    for (const fields of [
      {},
      { taskIds: [] },
      { taskIds: [""] },
      { taskIds: [producer.id, producer.id] },
      { taskId: producer.id, taskIds: [producer.id] },
      { taskIds: [producer.id], mode: "some" },
    ]) {
      expect(
        tool.inputSchema.safeParse({ ...base, wakeOn: { event: "settled", ...fields } }).success,
      ).toBe(false);
    }
    const wakeOn = { taskIds: [producer.id], event: "settled" };
    expect(tool.inputSchema.safeParse({ ...base, wakeOn }).success).toBe(true);
    for (const extra of [
      { delayMs: undefined },
      { runAt: new Date(Date.now() + 60000).toISOString() },
    ]) {
      expect(
        (await defer(parent.id, producer.id, "settled", { wakeOn, ...extra })).structuredContent
          .success,
      ).toBe(false);
    }
  });

  test("ordinary schedules neither suppress a completion nor retarget its waiters", async () => {
    const { producer, schedule } = await fixture();
    const ordinary = await createScheduledTask({
      name: `ordinary-${crypto.randomUUID()}`,
      taskTemplate: "Related scheduled work",
      taskType: "maintenance",
      intervalMs: 60000,
      parentTaskId: producer.id,
    });
    await dispatchScheduleTarget(ordinary);
    expect(await waitState(schedule.id)).toMatchObject({ taskId: producer.id, status: "pending" });
    await completeTask(producer.id, "done");
    await reconcileDeferredTaskWaits(producer.id);
    expect(await children(schedule.id)).toHaveLength(1);
  });

  test("two waiters follow a time-based deferral and fire once on the resume task's completion", async () => {
    await initDeferredTaskWaits();
    const { producer, schedule } = await fixture();
    const second = await defer((await activeTask()).id, producer.id, "task.completed");
    const secondSchedule = (await getScheduledTaskById(second.structuredContent.scheduleId!))!;
    const deferred = await defer(producer.id, producer.id, "settled", { wakeOn: undefined });
    expect(deferred.structuredContent.success).toBe(true);
    const successor = (await getScheduledTaskById(deferred.structuredContent.scheduleId!))!;

    await reconcileDeferredTaskWaits(producer.id);
    for (const waiter of [schedule, secondSchedule]) {
      expect(await children(waiter.id)).toHaveLength(0);
      expect(await waitState(waiter.id)).toMatchObject({
        taskId: producer.id,
        status: "pending",
        firedBy: null,
      });
    }

    await executeSchedule(successor);
    const resumed = (await children(successor.id))[0]!;
    for (const waiter of [schedule, secondSchedule]) {
      expect(await waitState(waiter.id)).toMatchObject({ taskId: resumed.id, status: "pending" });
      expect((await getScheduledTaskById(waiter.id))?.nextRunAt).toBe(waiter.nextRunAt);
    }
    await reconcileDeferredTaskWaits();
    expect(await children(schedule.id)).toHaveLength(0);
    await completeTask(resumed.id, "real result");
    for (const waiter of [schedule, secondSchedule]) {
      const child = await awaitChild(waiter.id);
      expect(child.task).toContain(`Wake-up cause: task.completed for task ${resumed.id}`);
      const fired = await waitState(waiter.id);
      expect(fired).toMatchObject({
        status: "fired",
        firedBy: "task.completed",
        childTaskId: child.id,
      });
      expect(fired?.updated_at).toBe(fired?.resolvedAt);
      await Promise.all([executeSchedule(waiter), reconcileDeferredTaskWaits(resumed.id)]);
      expect(await children(waiter.id)).toHaveLength(1);
      expect(await waitState(waiter.id)).toEqual(fired);
    }
  });

  test("event-driven deferrals retarget through a chain without refreshing the waiter's ceiling", async () => {
    const { producer, schedule } = await fixture("task.failed");
    let current = producer;
    for (let step = 0; step < 2; step++) {
      const dependency = await activeTask();
      const deferred = await defer(current.id, dependency.id);
      expect(deferred.structuredContent.success).toBe(true);
      await reconcileDeferredTaskWaits(current.id);
      expect(await waitState(schedule.id)).toMatchObject({ taskId: current.id, status: "pending" });
      await completeTask(dependency.id, "dependency ready");
      await reconcileDeferredTaskWaits(dependency.id);
      current = (await children(deferred.structuredContent.scheduleId!))[0]!;
      expect(await waitState(schedule.id)).toMatchObject({ taskId: current.id, status: "pending" });
      expect((await getScheduledTaskById(schedule.id))?.nextRunAt).toBe(schedule.nextRunAt);
    }

    await failTask(current.id, "real failure");
    // Reopen to verify the new watched task is durable across restarts.
    closeDb();
    initDb(path);
    await initDeferredTaskWaits();
    const child = await awaitChild(schedule.id);
    expect(child.task).toContain(`Wake-up cause: task.failed for task ${current.id}`);
    expect(await children(schedule.id)).toHaveLength(1);
  });

  test("the original ceiling still fires during the defer gap and fired waits never retarget", async () => {
    const { producer, schedule } = await fixture();
    const deferred = await defer(producer.id, producer.id, "settled", { wakeOn: undefined });
    const successor = (await getScheduledTaskById(deferred.structuredContent.scheduleId!))!;
    await reconcileDeferredTaskWaits(producer.id);
    expect(await children(schedule.id)).toHaveLength(0);
    expect((await getScheduledTaskById(schedule.id))?.nextRunAt).toBe(schedule.nextRunAt);
    await executeSchedule(schedule);
    const fired = await waitState(schedule.id);
    expect(fired).toMatchObject({ taskId: producer.id, firedBy: "ceiling", status: "fired" });
    expect(fired?.updated_at).toBe(fired?.resolvedAt);
    await executeSchedule(successor);
    const resumed = (await children(successor.id))[0]!;
    await completeTask(resumed.id, "late result");
    await reconcileDeferredTaskWaits();
    expect(await waitState(schedule.id)).toEqual(fired);
    expect(await children(schedule.id)).toHaveLength(1);
  });

  test.each([
    "disabled",
    "deleted",
  ])("a successor schedule that is %s during the gap releases the parent's completion", async (action) => {
    const { producer, schedule } = await fixture();
    const deferred = await defer(producer.id, producer.id, "settled", { wakeOn: undefined });
    const successorId = deferred.structuredContent.scheduleId!;
    await reconcileDeferredTaskWaits(producer.id);
    expect(await children(schedule.id)).toHaveLength(0);
    if (action === "disabled") await updateScheduledTask(successorId, { enabled: false });
    else await deleteScheduledTask(successorId);
    await reconcileDeferredTaskWaits();
    expect(await children(schedule.id)).toHaveLength(1);
    expect(await waitState(schedule.id)).toMatchObject({
      taskId: producer.id,
      status: "fired",
      firedBy: "task.completed",
    });
  });

  test("schema output stays verbatim while a task event wakes the continuation", async () => {
    const parent = await createTaskExtended("structured deferral", {
      agentId,
      outputSchema: { type: "string" },
    });
    await startTask(parent.id);
    const producer = await activeTask();

    for (const output of [undefined, "not JSON", "42"]) {
      const result = await defer(parent.id, producer.id, "settled", { output });
      expect(result.structuredContent.success).toBe(false);
      expect((await getTaskById(parent.id))?.status).toBe("in_progress");
      expect(
        await getDbClient().query("SELECT id FROM scheduled_tasks WHERE parentTaskId = ?", [
          parent.id,
        ]),
      ).toHaveLength(0);
    }

    const output = ' "deploy pending"\n';
    const result = await defer(parent.id, producer.id, "settled", { output });
    expect(result.structuredContent.success).toBe(true);
    expect((await getTaskById(parent.id))?.output).toBe(output);
    const scheduleId = result.structuredContent.scheduleId!;
    const logs = (await getLogsByTaskId(parent.id)).filter(
      (log) => log.eventType === "task_progress",
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]!.newValue).toContain("Work submitted");
    expect(logs[0]!.newValue).toContain(scheduleId);

    await completeTask(producer.id, "ready");
    await reconcileDeferredTaskWaits(producer.id);
    const found = await children(scheduleId);
    expect(found).toHaveLength(1);
    expect(found[0]!.parentTaskId).toBe(parent.id);
    expect(found[0]!.task).toContain("Wake-up cause: task.completed");
    expect((await getTaskById(parent.id))?.output).toBe(output);
  });

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

  test("settled wakes on the cancellation bus and consumes the ceiling once", async () => {
    await initDeferredTaskWaits();
    const { producer, schedule } = await fixture();
    await cancelTask(producer.id, "cancelled");
    expect((await awaitChild(schedule.id)).task).toContain(
      `Wake-up cause: task.cancelled for task ${producer.id}`,
    );
    expect(await waitState(schedule.id)).toMatchObject({ firedBy: "task.cancelled" });
    await executeSchedule(schedule);
    expect(await children(schedule.id)).toHaveLength(1);
  });

  test("restart reconciles cancellation missed while the listener was stopped", async () => {
    const { producer, schedule } = await fixture();
    await cancelTask(producer.id, "cancelled while stopped");
    closeDb();
    initDb(path);
    await initDeferredTaskWaits();
    expect(await waitState(schedule.id)).toMatchObject({
      status: "fired",
      firedBy: "task.cancelled",
    });
    expect(await children(schedule.id)).toHaveLength(1);
  });

  test.each([
    "task.completed",
    "task.failed",
  ] as const)("%s does not wake on cancellation and retains the ceiling", async (event) => {
    await initDeferredTaskWaits();
    const { producer, schedule } = await fixture(event);
    await cancelTask(producer.id, "cancelled");
    await reconcileDeferredTaskWaits(producer.id);
    expect(await dispatchDeferredTaskWait(schedule.id, "task.cancelled")).toEqual({});
    expect(await children(schedule.id)).toHaveLength(0);
    expect(await waitState(schedule.id)).toMatchObject({ status: "pending" });
    await executeSchedule(schedule);
    expect(await waitState(schedule.id)).toMatchObject({ firedBy: "ceiling" });
  });

  test.each([
    "resume first",
    "supersede first",
  ])("superseded follows the resume without waking or extending the ceiling: %s", async (order) => {
    await initDeferredTaskWaits();
    for (const event of ["settled", "task.completed", "task.failed"] as const) {
      const { producer, schedule } = await fixture(event);
      let resume: AgentTask | undefined;
      if (order === "resume first") {
        resume = await resumeTask(producer.id);
        await reconcileDeferredTaskWaits();
        expect(await waitState(schedule.id)).toMatchObject({ taskId: producer.id });
      }
      await supersedeTask(producer.id, {
        reason: "manual_supersede",
        resumeTaskId: resume?.id ?? null,
      });
      if (!resume) {
        await reconcileDeferredTaskWaits(producer.id);
        expect(await waitState(schedule.id)).toMatchObject({
          taskId: producer.id,
          status: "pending",
        });
        resume = await resumeTask(producer.id);
      }
      await awaitWatchedTask(schedule.id, resume.id);
      expect(await waitState(schedule.id)).toMatchObject({ status: "pending", firedBy: null });
      expect(await children(schedule.id)).toHaveLength(0);
      expect((await getScheduledTaskById(schedule.id))?.nextRunAt).toBe(schedule.nextRunAt);
      if (event === "task.failed") await failTask(resume.id, "resume failed");
      else await completeTask(resume.id, "resume completed");
      expect((await awaitChild(schedule.id)).task).toContain(`for task ${resume.id}`);
      await executeSchedule(schedule);
      expect(await children(schedule.id)).toHaveLength(1);
    }
  });

  test("superseded without a resume holds to its ceiling and a late resume cannot retarget a fired wait", async () => {
    await initDeferredTaskWaits();
    const { producer, schedule } = await fixture();
    await supersedeTask(producer.id, { reason: "manual_supersede", resumeTaskId: null });
    // An ordinary follow-up is not the replacement for superseded work.
    await createTaskExtended("unrelated follow-up", {
      parentTaskId: producer.id,
      taskType: "follow-up",
    });
    await reconcileDeferredTaskWaits(producer.id);
    expect(await waitState(schedule.id)).toMatchObject({ taskId: producer.id, status: "pending" });
    expect(await children(schedule.id)).toHaveLength(0);
    await executeSchedule(schedule);
    const fired = await waitState(schedule.id);
    expect(fired).toMatchObject({ firedBy: "ceiling" });
    const resume = await resumeTask(producer.id);
    await completeTask(resume.id, "too late");
    await reconcileDeferredTaskWaits();
    expect(await waitState(schedule.id)).toEqual(fired);
    expect(await children(schedule.id)).toHaveLength(1);
  });

  test("restart follows a missed supersede chain to an already-terminal resume", async () => {
    const { producer, schedule } = await fixture();
    let current = producer;
    for (let step = 0; step < 2; step++) {
      await supersedeTask(current.id, { reason: "manual_supersede", resumeTaskId: null });
      current = await resumeTask(current.id);
    }
    await completeTask(current.id, "final result");
    closeDb();
    initDb(path);
    await initDeferredTaskWaits();
    expect(await waitState(schedule.id)).toMatchObject({ taskId: current.id, status: "fired" });
    expect((await awaitChild(schedule.id)).task).toContain(`for task ${current.id}`);
    expect(await children(schedule.id)).toHaveLength(1);
  });

  test("a wait watching both the superseded parent and its resume collapses to one member", async () => {
    const parent = await activeTask();
    const producer = await activeTask();
    const resume = await resumeTask(producer.id);
    const deferred = await defer(parent.id, producer.id, "settled", {
      wakeOn: { taskIds: [producer.id, resume.id], event: "settled" },
    });
    const scheduleId = deferred.structuredContent.scheduleId!;
    await supersedeTask(producer.id, { reason: "manual_supersede", resumeTaskId: resume.id });
    await reconcileDeferredTaskWaits();
    expect(await waitState(scheduleId)).toMatchObject({ taskId: resume.id, status: "pending" });
    expect(
      await getDbClient().query("SELECT * FROM deferred_task_wait_members WHERE scheduleId = ?", [
        scheduleId,
      ]),
    ).toHaveLength(1);
    await completeTask(resume.id, "done");
    await reconcileDeferredTaskWaits(resume.id);
    expect(await children(scheduleId)).toHaveLength(1);
  });

  test("unmatched task or event does not wake", async () => {
    await initDeferredTaskWaits();
    const { producer, schedule } = await fixture("task.completed");
    const other = await activeTask();
    await completeTask(other.id, "unrelated");
    await failTask(producer.id, "wrong event");
    await reconcileDeferredTaskWaits();
    expect(await children(schedule.id)).toHaveLength(0);
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
