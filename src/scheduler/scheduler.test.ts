import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDb, createAgent, createScheduledTask, createTaskExtended, initDb } from "../be/db";
import { calculateNextRun, createStandaloneScheduleTask } from "./scheduler";

const TEST_DB_PATH = "./test-scheduler.sqlite";

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(() => {
  closeDb();
  try {
    unlinkSync(TEST_DB_PATH);
    unlinkSync(`${TEST_DB_PATH}-wal`);
    unlinkSync(`${TEST_DB_PATH}-shm`);
  } catch {
    // ignore if files don't exist
  }
});

describe("calculateNextRun", () => {
  test("calculates next run with cron expression", () => {
    const schedule = createScheduledTask({
      name: "test-cron-1",
      taskTemplate: "Test task",
      cronExpression: "0 9 * * *", // Daily at 9 AM
      timezone: "UTC",
    });

    // Calculate next run from a fixed date
    const fromDate = new Date("2026-01-15T08:00:00Z");
    const nextRun = calculateNextRun(schedule, fromDate);

    // Should be 9 AM on the same day
    expect(nextRun).toBe("2026-01-15T09:00:00.000Z");
  });

  test("calculates next run with cron expression crossing day", () => {
    const schedule = createScheduledTask({
      name: "test-cron-2",
      taskTemplate: "Test task",
      cronExpression: "0 9 * * *", // Daily at 9 AM
      timezone: "UTC",
    });

    // Calculate next run from after 9 AM
    const fromDate = new Date("2026-01-15T10:00:00Z");
    const nextRun = calculateNextRun(schedule, fromDate);

    // Should be 9 AM on the next day
    expect(nextRun).toBe("2026-01-16T09:00:00.000Z");
  });

  test("calculates next run with interval", () => {
    const schedule = createScheduledTask({
      name: "test-interval-1",
      taskTemplate: "Test task",
      intervalMs: 3600000, // 1 hour
    });

    const fromDate = new Date("2026-01-15T08:00:00Z");
    const nextRun = calculateNextRun(schedule, fromDate);

    // Should be 1 hour later
    expect(nextRun).toBe("2026-01-15T09:00:00.000Z");
  });

  test("calculates next run with small interval", () => {
    const schedule = createScheduledTask({
      name: "test-interval-2",
      taskTemplate: "Test task",
      intervalMs: 60000, // 1 minute
    });

    const fromDate = new Date("2026-01-15T08:30:00Z");
    const nextRun = calculateNextRun(schedule, fromDate);

    // Should be 1 minute later
    expect(nextRun).toBe("2026-01-15T08:31:00.000Z");
  });

  test("calculates next run with timezone", () => {
    const schedule = createScheduledTask({
      name: "test-tz-1",
      taskTemplate: "Test task",
      cronExpression: "0 9 * * *", // 9 AM in specified timezone
      timezone: "America/New_York", // EST/EDT
    });

    // Calculate from midnight UTC on Jan 15
    const fromDate = new Date("2026-01-15T00:00:00Z");
    const nextRun = calculateNextRun(schedule, fromDate);

    // 9 AM EST is 14:00 UTC (EST is UTC-5)
    expect(nextRun).toBe("2026-01-15T14:00:00.000Z");
  });

  test("throws error for schedule without cron or interval", () => {
    // Create a mock schedule object without cron or interval
    const mockSchedule = {
      id: "test-id",
      key: "shared/",
      name: "test-no-schedule",
      taskTemplate: "Test task",
      tags: [],
      priority: 50,
      enabled: true,
      timezone: "UTC",
      consecutiveErrors: 0,
      scheduleType: "recurring" as const,
      targetType: "agent-task" as const,
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    } as Parameters<typeof calculateNextRun>[0];

    expect(() => calculateNextRun(mockSchedule)).toThrow(
      "Schedule must have cronExpression or intervalMs",
    );
  });

  test("calculates next run with every-minute cron", () => {
    const schedule = createScheduledTask({
      name: "test-cron-every-minute",
      taskTemplate: "Test task",
      cronExpression: "* * * * *", // Every minute
      timezone: "UTC",
    });

    const fromDate = new Date("2026-01-15T08:30:30Z");
    const nextRun = calculateNextRun(schedule, fromDate);

    // Should be next minute
    expect(nextRun).toBe("2026-01-15T08:31:00.000Z");
  });

  test("calculates next run with weekly cron", () => {
    const schedule = createScheduledTask({
      name: "test-cron-weekly",
      taskTemplate: "Test task",
      cronExpression: "0 9 * * 1", // Every Monday at 9 AM
      timezone: "UTC",
    });

    // Jan 15, 2026 is a Thursday
    const fromDate = new Date("2026-01-15T08:00:00Z");
    const nextRun = calculateNextRun(schedule, fromDate);

    // Next Monday is Jan 19, 2026
    expect(nextRun).toBe("2026-01-19T09:00:00.000Z");
  });
});

describe("createStandaloneScheduleTask", () => {
  test("passes the schedule's parentTaskId through to the created task", () => {
    const agent = createAgent({
      name: "Deferred Wake-up Worker",
      description: "Agent that owns the deferred task",
      role: "worker",
      isLead: false,
      status: "idle",
      maxTasks: 1,
      capabilities: [],
    });
    const parent = createTaskExtended("original work that needed time", {
      agentId: agent.id,
      source: "mcp",
    });

    const schedule = createScheduledTask({
      name: "test-deferred-parent",
      taskTemplate: `Resume task ${parent.id}: the deploy should be green now`,
      scheduleType: "one_time",
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      targetAgentId: agent.id,
      createdByAgentId: agent.id,
      taskType: "deferred",
      tags: ["deferred"],
      parentTaskId: parent.id,
    });

    const task = createStandaloneScheduleTask(schedule);
    expect(task.parentTaskId).toBe(parent.id);
    expect(task.taskType).toBe("deferred");
    expect(task.tags).toContain("deferred");
  });

  test("a schedule without parentTaskId creates a parentless task", () => {
    const schedule = createScheduledTask({
      name: "test-no-parent",
      taskTemplate: "Ordinary scheduled work",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
    });

    const task = createStandaloneScheduleTask(schedule);
    expect(task.parentTaskId).toBeFalsy();
  });
});
