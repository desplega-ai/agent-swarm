import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type NewScheduledTaskRow, type SchedulesRepository, type Storage, sql } from "../../src";
import type { ContractEngine } from "./env";
import { seedTask } from "./tasks";

const T0 = "2026-11-21T10:00:00.000Z";
const T1 = "2026-11-21T11:00:00.000Z";
const T2 = "2026-11-21T12:00:00.000Z";

function schedule(id: string, extra: Partial<NewScheduledTaskRow> = {}): NewScheduledTaskRow {
  return {
    id,
    key: `shared/${id}/`,
    name: id,
    description: null,
    cronExpression: null,
    intervalMs: 60000,
    taskTemplate: "t",
    taskType: null,
    tags: "[]",
    priority: 50,
    targetAgentId: null,
    enabled: true,
    nextRunAt: null,
    createdByAgentId: null,
    updatedByAgentId: null,
    parentTaskId: null,
    requestedDelayMs: null,
    requestedRunAt: null,
    timezone: "UTC",
    model: null,
    modelTier: null,
    profile: null,
    modelGroup: null,
    scheduleType: "recurring",
    targetType: "agent-task",
    workflowId: null,
    scriptName: null,
    scriptArgs: "{}",
    params: "{}",
    requiredParams: "[]",
    requires: "[]",
    createdAt: T0,
    lastUpdatedAt: T0,
    created_by: null,
    updated_by: null,
    ...extra,
  };
}

export function schedulesContract(engine: ContractEngine): void {
  describe(`schedules repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: SchedulesRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.schedules;
      await storage.executor.run(sql`DELETE FROM scheduled_tasks`);
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

    test("insert round trips the value shape; update sets only given columns", async () => {
      const row = await repo.insertScheduledTask(schedule("s1", { enabled: false }));
      expect(row).toMatchObject({ id: "s1", key: "shared/s1/", enabled: 0, consecutiveErrors: 0 });
      expect(row?.lastRunAt).toBeNull();
      const updated = await repo.updateScheduledTask(
        "s1",
        { enabled: true, key: "shared/x/", lastErrorMessage: null, intervalMs: undefined },
        T1,
      );
      expect(updated).toMatchObject({
        enabled: 1,
        key: "shared/x/",
        intervalMs: 60000,
        lastUpdatedAt: T1,
      });
      expect(await repo.updateScheduledTask("nope", { name: "n" }, T1)).toBeNull();
      expect((await repo.findScheduledTaskByName("s1"))?.id).toBe("s1");
      expect(await repo.findScheduledTaskById("zz")).toBeNull();
    });

    test("list filters and order: ever-run first, newest run, newest update, insertion", async () => {
      await repo.insertScheduledTask(schedule("never-b"));
      await repo.insertScheduledTask(schedule("never-a"));
      await repo.insertScheduledTask(schedule("ran-old", { lastUpdatedAt: T2 }));
      await repo.insertScheduledTask(schedule("ran-new"));
      await repo.insertScheduledTask(
        schedule("done", { scheduleType: "one_time", enabled: false }),
      );
      await storage.executor.run(
        sql`UPDATE scheduled_tasks SET "lastRunAt" = ${T0} WHERE id = 'ran-old'`,
      );
      await storage.executor.run(
        sql`UPDATE scheduled_tasks SET "lastRunAt" = ${T1}, "consecutiveErrors" = 2 WHERE id = 'ran-new'`,
      );
      expect(ids(await repo.listScheduledTasks({ hideCompleted: true }))).toEqual([
        "ran-new",
        "ran-old",
        "never-b",
        "never-a",
      ]);
      expect(ids(await repo.listScheduledTasks({ hideCompleted: false, enabled: false }))).toEqual([
        "done",
      ]);
      expect(
        ids(await repo.listScheduledTasks({ hideCompleted: true, name: "NEVER", limit: 1 })),
      ).toEqual(["never-b"]);
      expect(
        ids(await repo.listScheduledTasks({ hideCompleted: true, lastRunStatus: "failed" })),
      ).toEqual(["ran-new"]);
      expect(
        ids(await repo.listScheduledTasks({ hideCompleted: true, lastRunStatus: "succeeded" })),
      ).toEqual(["ran-old"]);
      expect(
        ids(await repo.listScheduledTasks({ hideCompleted: true, consecutiveErrorsMin: 1 })),
      ).toEqual(["ran-new"]);
      expect(
        ids(await repo.listScheduledTasks({ hideCompleted: true, key: "shared/never-a/" })),
      ).toEqual(["never-a"]);
      expect(
        ids(await repo.listScheduledTasks({ hideCompleted: true, keyPattern: "shared/ran\\_%" })),
      ).toEqual([]);
      expect(
        ids(await repo.listScheduledTasks({ hideCompleted: true, keyPattern: "shared/ran-%" })),
      ).toEqual(["ran-new", "ran-old"]);
    });

    test("due schedules order by nextRunAt then insertion order", async () => {
      await repo.insertScheduledTask(schedule("b", { nextRunAt: T0 }));
      await repo.insertScheduledTask(schedule("a", { nextRunAt: T0 }));
      await repo.insertScheduledTask(schedule("c", { nextRunAt: T2 }));
      await repo.insertScheduledTask(schedule("off", { nextRunAt: T0, enabled: false }));
      expect(ids(await repo.listDueScheduledTasks(T1))).toEqual(["b", "a"]);
    });

    test("unfired deferral parent, delete, and the spent-deferral reaper", async () => {
      await seedTask(storage, { id: "p" });
      const deferred = { taskType: "deferred", scheduleType: "one_time", parentTaskId: "p" };
      await repo.insertScheduledTask(schedule("d1", deferred));
      await repo.insertScheduledTask(schedule("d2", { ...deferred, enabled: false }));
      await repo.insertScheduledTask(schedule("d3", { ...deferred, enabled: false }));
      expect(await repo.findUnfiredDeferralParent("d1")).toBe("p");
      await seedTask(storage, { id: "w", scheduleId: "d1" });
      expect(await repo.findUnfiredDeferralParent("d1")).toBeNull();
      await storage.executor.run(
        sql`UPDATE scheduled_tasks SET "lastRunAt" = ${T0} WHERE id IN ('d2', 'd3')`,
      );
      await storage.executor.run(sql`
        INSERT INTO deferred_event_waits ("scheduleId", source, event, "matchKey", "matchJson", status)
        VALUES ('d3', 's', 'e', 'k', '{}', 'pending')`);
      expect(await repo.deleteSpentDeferredSchedules(T1)).toBe(1);
      expect(await repo.findScheduledTaskById("d2")).toBeNull();
      expect(await repo.deleteScheduledTask("d1")).toBe(1);
      expect(await repo.deleteScheduledTask("d1")).toBe(0);
    });
  });
}
