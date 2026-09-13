import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as db from "../be/db";
import { telemetry } from "../telemetry";

const agentId = "bbbb0000-0000-4000-8000-000000000003";
const stamp = "2025-01-02T03:04:05.000Z";
let events: string[];
let taskEventSpy: ReturnType<typeof spyOn>;

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Bun.sleep(0);
}

beforeEach(async () => {
  db.closeDb();
  db.initDb(":memory:");
  await db.createAgent({ id: agentId, name: "Write fixtures", isLead: false, status: "idle" });
  events = [];
  taskEventSpy = spyOn(telemetry, "taskEvent").mockImplementation((event) => {
    events.push(event);
  });
});
afterEach(async () => {
  await flush();
  taskEventSpy.mockRestore();
  db.closeDb();
});

async function fixture() {
  const task = await db.createTask(agentId, "write fixture");
  await db.updateTaskClaudeSessionId(
    task.id,
    "session-03",
    "codex",
    { fixture: true },
    "fixture-model",
    "codex",
    { version: 3 },
  );
  await db
    .getDbClient()
    .run("UPDATE agent_tasks SET createdAt = ?, lastUpdatedAt = ? WHERE id = ?", [
      stamp,
      stamp,
      task.id,
    ]);
  return (await db.getTaskById(task.id))!;
}

// These same fixtures also run against the merged base before extraction.
describe("task write base behavior", () => {
  test("create, start, pause and resume retain session identity and lifecycle timestamps", async () => {
    const task = await fixture();
    expect(task.status).toBe("pending");
    expect(task.finishedAt).toBeUndefined();
    expect(await db.getPendingTaskForAgent(agentId)).toEqual(task);
    expect(await db.pauseTask(task.id)).toBeNull();
    for (const [operation, status] of [
      [db.startTask, "in_progress"],
      [db.pauseTask, "paused"],
      [db.resumeTask, "in_progress"],
    ] as const) {
      const result = (await operation(task.id))!;
      expect(result.status).toBe(status);
      expect(result.claudeSessionId).toBe("session-03");
      expect(result.createdAt).toBe(stamp);
      expect(result.lastUpdatedAt > stamp).toBe(true);
      expect(result.finishedAt).toBeUndefined();
      expect(result.provider).toBe("codex");
      expect(result.harnessVariantMeta).toEqual({ version: 3 });
    }
    expect(await db.resumeTask(task.id)).toBeNull();
    await flush();
    expect(events).toEqual([]);
    expect((await db.getLogsByTaskId(task.id)).map((log) => log.newValue).sort()).toEqual(
      ["in_progress", "in_progress", "paused", "pending"].sort(),
    );
  });

  for (const status of ["completed", "failed", "cancelled", "superseded"] as const) {
    test(`${status} preserves timestamps and session, emits once and rejects repeated terminal transitions`, async () => {
      const task = await fixture();
      await db.startTask(task.id);
      const terminalize =
        status === "completed"
          ? (id: string) => db.completeTask(id, "done")
          : status === "failed"
            ? (id: string) => db.failTask(id, "failed fixture")
            : status === "cancelled"
              ? (id: string) => db.cancelTask(id)
              : (id: string) => db.supersedeTask(id, { reason: "restart", resumeTaskId: null });
      const result = (await terminalize(task.id))!;
      expect(result.status).toBe(status);
      expect(result.createdAt).toBe(stamp);
      expect(result.finishedAt! > stamp).toBe(true);
      expect(result.lastUpdatedAt > stamp).toBe(true);
      expect(result.claudeSessionId).toBe("session-03");
      for (const operation of [
        db.startTask,
        db.pauseTask,
        db.resumeTask,
        db.completeTask,
        (id: string) => db.failTask(id, "again"),
        db.cancelTask,
        (id: string) => db.supersedeTask(id, { reason: "again", resumeTaskId: null }),
      ]) {
        expect(await operation(task.id)).toBeNull();
      }
      expect(await db.getTaskById(task.id)).toEqual(result);
      const updated = (await db.updateTaskProgress(task.id, "late progress"))!;
      expect(updated.status).toBe(status);
      expect(updated.finishedAt).toBe(result.finishedAt);
      expect(updated.claudeSessionId).toBe("session-03");
      await flush();
      expect(events).toEqual([status]);
    });
  }

  test("missing ids retain null, false and empty-list results", async () => {
    for (const operation of [
      db.startTask,
      db.pauseTask,
      db.resumeTask,
      db.completeTask,
      db.cancelTask,
      (id: string) => db.failTask(id, "missing"),
      (id: string) => db.supersedeTask(id, { reason: "missing", resumeTaskId: null }),
      (id: string) => db.updateTaskClaudeSessionId(id, "missing"),
      (id: string) => db.updateTaskTitle(id, "missing"),
      (id: string) => db.updateTaskProgress(id, "missing"),
      (id: string) => db.overwriteTerminalTaskResultText(id, { output: "missing" }),
      (id: string) => db.assignUnassignedTaskPending(id, agentId),
    ]) {
      expect(await operation("missing")).toBeNull();
    }
    expect(await db.deleteTask("missing")).toBe(false);
    expect(await db.backfillSupersedeTaskResumeTaskId("missing", "resume")).toBe(false);
    expect(await db.getPendingTaskForAgent("missing")).toBeNull();
    expect(await db.getPausedTasksForAgent("missing")).toEqual([]);
    expect(await db.getOrphanedInProgressTasksForAgent("missing")).toEqual([]);
    expect(await db.resetOrphanedInProgressTasksForAgent("missing")).toEqual([]);
    expect(await db.getRecentlyCancelledTasksForAgent("missing")).toEqual([]);
    await flush();
    expect(events).toEqual([]);
  });

  test("rename and terminal text overwrite preserve activity timestamps", async () => {
    const task = await fixture();
    expect((await db.updateTaskTitle(task.id, "  title  "))?.title).toBe("title");
    expect((await db.updateTaskTitle(task.id, "  "))?.title).toBeUndefined();
    expect((await db.getTaskById(task.id))?.lastUpdatedAt).toBe(stamp);
    expect(await db.overwriteTerminalTaskResultText(task.id, { output: "early" })).toBeNull();
    const completed = (await db.completeTask(task.id, "original"))!;
    const edited = (await db.overwriteTerminalTaskResultText(task.id, { output: "edited" }))!;
    expect(edited.output).toBe("edited");
    expect(edited.lastUpdatedAt).toBe(completed.lastUpdatedAt);
    expect(edited.finishedAt).toBe(completed.finishedAt);
    await flush();
    expect(events).toEqual(["completed"]);
  });

  test("assignment, orphan recovery, paused and cancelled queries, supersede backfill and deletion", async () => {
    const task = await fixture();
    await db
      .getDbClient()
      .run(
        "UPDATE agent_tasks SET agentId = NULL, status = 'unassigned', claudeSessionId = NULL WHERE id = ?",
        [task.id],
      );
    expect((await db.assignUnassignedTaskPending(task.id, agentId))?.status).toBe("pending");
    expect(await db.assignUnassignedTaskPending(task.id, agentId)).toBeNull();
    await db.startTask(task.id);
    await db
      .getDbClient()
      .run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [stamp, task.id]);
    expect((await db.getOrphanedInProgressTasksForAgent(agentId)).map((t) => t.id)).toEqual([
      task.id,
    ]);
    expect((await db.resetOrphanedInProgressTasksForAgent(agentId)).map((t) => t.status)).toEqual([
      "pending",
    ]);
    await db.startTask(task.id);
    await db.pauseTask(task.id);
    expect((await db.getPausedTasksForAgent(agentId)).map((t) => t.id)).toEqual([task.id]);
    await db.resumeTask(task.id);
    await db.cancelTask(task.id);
    expect((await db.getRecentlyCancelledTasksForAgent(agentId)).map((t) => t.id)).toEqual([
      task.id,
    ]);
    const superseded = await fixture();
    await db.supersedeTask(superseded.id, { reason: "restart", resumeTaskId: null });
    expect(await db.backfillSupersedeTaskResumeTaskId(superseded.id, "resume-id")).toBe(true);
    const log = (await db.getLogsByTaskId(superseded.id)).find(
      (l) => l.eventType === "task_superseded",
    )!;
    expect(JSON.parse(log.metadata!).resumeTaskId).toBe("resume-id");
    await flush();
    expect(await db.deleteTask(task.id)).toBe(true);
    expect(await db.getTaskById(task.id)).toBeNull();
  });
});

test("racing terminal transitions emit only for the winning write", async () => {
  const task = await fixture();
  const results = await Promise.all([
    db.completeTask(task.id, "winner"),
    db.failTask(task.id, "failure"),
    db.cancelTask(task.id),
    db.supersedeTask(task.id, { reason: "restart", resumeTaskId: null }),
  ]);
  const winners = results.filter((result) => result !== null);
  expect(winners).toHaveLength(1);
  expect((await db.getTaskById(task.id))?.status).toBe(winners[0]!.status);
  await flush();
  expect(events).toEqual([winners[0]!.status]);
});

test("outer rollback restores the task and discards terminal telemetry and logs", async () => {
  const task = await fixture();
  await expect(
    db.getDbClient().transaction(async () => {
      await db.completeTask(task.id, "rolled back");
      throw new Error("rollback fixture");
    }),
  ).rejects.toThrow("rollback fixture");
  await flush();
  expect(await db.getTaskById(task.id)).toEqual(task);
  expect(events).toEqual([]);
  expect((await db.getLogsByTaskId(task.id)).map((log) => log.newValue)).toEqual(["pending"]);
});
