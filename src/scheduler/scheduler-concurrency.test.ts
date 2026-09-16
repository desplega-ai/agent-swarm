import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as db from "@/be/db";
import { ExecutorRegistry } from "@/workflows/executors/registry";
import { executeSchedule, runScheduleNow, startScheduler, stopScheduler } from "./scheduler";

beforeEach(() => {
  db.initDb(":memory:");
});

afterEach(() => {
  stopScheduler();
  mock.restore();
  db.closeDb();
});

async function createDueSchedule(scheduleType: "recurring" | "one_time" = "recurring") {
  return db.createScheduledTask({
    name: `concurrency-${crypto.randomUUID()}`,
    taskTemplate: "Run this occurrence once",
    scheduleType,
    intervalMs: scheduleType === "recurring" ? 60_000 : undefined,
    nextRunAt: new Date(Date.now() - 60_000).toISOString(),
  });
}

async function tasksFor(scheduleId: string) {
  return db
    .getDbClient()
    .query<{ id: string; tags: string }>("SELECT id, tags FROM agent_tasks WHERE scheduleId = ?", [
      scheduleId,
    ]);
}

async function waitUntil(condition: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Scheduler did not settle");
    await Bun.sleep(5);
  }
}

describe("standalone schedule occurrence concurrency", () => {
  for (const scheduleType of ["recurring", "one_time"] as const) {
    test(`${scheduleType}: concurrent stale snapshots create only one task`, async () => {
      const schedule = await createDueSchedule(scheduleType);
      await db.updateScheduledTask(schedule.id, {
        consecutiveErrors: 2,
        lastErrorMessage: "previous failure",
      });

      await Promise.all([executeSchedule(schedule), executeSchedule({ ...schedule })]);
      const advanced = await db.getScheduledTaskById(schedule.id);
      expect(await tasksFor(schedule.id)).toHaveLength(1);
      expect(advanced?.lastRunAt).toBeDefined();
      expect(advanced?.consecutiveErrors).toBe(0);
      expect(advanced?.lastErrorMessage).toBeUndefined();
      if (scheduleType === "one_time") {
        expect(advanced?.enabled).toBe(false);
        expect(advanced?.nextRunAt).toBeUndefined();
      } else {
        expect(advanced?.enabled).toBe(true);
        expect(new Date(advanced!.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
      }

      await executeSchedule(schedule);
      expect(await tasksFor(schedule.id)).toHaveLength(1);
      expect(await db.getScheduledTaskById(schedule.id)).toEqual(advanced);
    });
  }

  test("schedule advancement failure rolls task creation back", async () => {
    const schedule = await createDueSchedule();
    await db.getDbClient().run(`CREATE TRIGGER fail_schedule_advance
      BEFORE UPDATE OF lastRunAt ON scheduled_tasks
      BEGIN SELECT RAISE(ABORT, 'injected advancement failure'); END`);

    await executeSchedule(schedule);
    expect(await tasksFor(schedule.id)).toHaveLength(0);
    const failed = await db.getScheduledTaskById(schedule.id);
    expect(failed?.lastRunAt).toBeUndefined();
    expect(failed?.consecutiveErrors).toBe(1);

    await db.getDbClient().run("DROP TRIGGER fail_schedule_advance");
    await executeSchedule(failed!);
    expect(await tasksFor(schedule.id)).toHaveLength(1);
  });

  test("manual runs remain independent of the scheduled occurrence", async () => {
    const schedule = await createDueSchedule();
    await Promise.all([runScheduleNow(schedule.id), runScheduleNow(schedule.id)]);
    expect(await tasksFor(schedule.id)).toHaveLength(2);
    expect((await db.getScheduledTaskById(schedule.id))?.nextRunAt).toBe(schedule.nextRunAt);
  });
});

describe("scheduler startup recovery", () => {
  test("recovery rejects a snapshot already dispatched by another poller", async () => {
    const schedule = await createDueSchedule();
    const captured = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const getDue = db.getDueScheduledTasks;
    spyOn(db, "getDueScheduledTasks").mockImplementationOnce(async () => {
      const snapshot = await getDue();
      captured.resolve();
      await release.promise;
      return snapshot;
    });
    const intervals = spyOn(globalThis, "setInterval");
    startScheduler(new ExecutorRegistry(), 60_000);
    await captured.promise;
    try {
      await executeSchedule(schedule);
    } finally {
      release.resolve();
      await waitUntil(() => intervals.mock.calls.length === 1);
      // Let the startup chain finish even on the unfixed source.
      await db.getDbClient().transaction(async () => {});
      await Bun.sleep(20);
    }
    expect(await tasksFor(schedule.id)).toHaveLength(1);
  });

  test("does not install polling until recovery finishes, including repeated starts", async () => {
    const schedule = await createDueSchedule();
    const captured = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const getDue = db.getDueScheduledTasks;
    spyOn(db, "getDueScheduledTasks").mockImplementationOnce(async () => {
      const snapshot = await getDue();
      captured.resolve();
      await release.promise;
      return snapshot;
    });
    const intervals = spyOn(globalThis, "setInterval");
    startScheduler(new ExecutorRegistry(), 60_000);
    await captured.promise;
    try {
      startScheduler(new ExecutorRegistry(), 60_000);
      expect(intervals).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await waitUntil(() => intervals.mock.calls.length === 1);
      await Bun.sleep(20);
    }
    const tasks = await tasksFor(schedule.id);
    expect(tasks).toHaveLength(1);
    expect(JSON.parse(tasks[0]!.tags)).toContain("recovered");
  });

  test("stopping during recovery prevents a late polling timer", async () => {
    await createDueSchedule();
    const captured = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const getDue = db.getDueScheduledTasks;
    const reads = spyOn(db, "getDueScheduledTasks").mockImplementationOnce(async () => {
      const snapshot = await getDue();
      captured.resolve();
      await release.promise;
      return snapshot;
    });
    const intervals = spyOn(globalThis, "setInterval");
    startScheduler(new ExecutorRegistry(), 60_000);
    await captured.promise;
    stopScheduler();
    release.resolve();
    await Bun.sleep(50);
    expect(intervals).not.toHaveBeenCalled();
    expect(reads).toHaveBeenCalledTimes(1);
  });
});
