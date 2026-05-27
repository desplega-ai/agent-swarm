import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createScheduledTask,
  getScheduledTaskById,
  initDb,
  updateScheduledTask,
} from "../be/db";

const TEST_DB_PATH = "./test-scheduler-backoff.sqlite";

describe("scheduler exponential backoff", () => {
  beforeAll(async () => {
    await initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    try {
      await unlink(TEST_DB_PATH);
      await unlink(`${TEST_DB_PATH}-wal`);
      await unlink(`${TEST_DB_PATH}-shm`);
    } catch {
      // ignore
    }
  });

  test("new scheduled tasks have consecutiveErrors = 0", async () => {
    const schedule = await createScheduledTask({
      name: "backoff-test-1",
      taskTemplate: "Test task",
      intervalMs: 60000,
    });

    expect(schedule.consecutiveErrors).toBe(0);
    expect(schedule.lastErrorAt).toBeUndefined();
    expect(schedule.lastErrorMessage).toBeUndefined();
  });

  test("updateScheduledTask can set error tracking fields", async () => {
    const schedule = await createScheduledTask({
      name: "backoff-test-2",
      taskTemplate: "Test task",
      intervalMs: 60000,
    });

    const now = new Date().toISOString();
    const updated = await updateScheduledTask(schedule.id, {
      consecutiveErrors: 3,
      lastErrorAt: now,
      lastErrorMessage: "Connection refused",
    });

    expect(updated).not.toBeNull();
    expect(updated!.consecutiveErrors).toBe(3);
    expect(updated!.lastErrorAt).toBe(now);
    expect(updated!.lastErrorMessage).toBe("Connection refused");
  });

  test("error tracking can be reset to 0 on success", async () => {
    const schedule = await createScheduledTask({
      name: "backoff-test-3",
      taskTemplate: "Test task",
      intervalMs: 60000,
    });

    // Simulate errors
    await updateScheduledTask(schedule.id, {
      consecutiveErrors: 4,
      lastErrorAt: new Date().toISOString(),
      lastErrorMessage: "Some error",
    });

    // Simulate successful execution — reset errors
    const updated = await updateScheduledTask(schedule.id, {
      consecutiveErrors: 0,
      lastErrorAt: null,
      lastErrorMessage: null,
    });

    expect(updated!.consecutiveErrors).toBe(0);
    expect(updated!.lastErrorAt).toBeUndefined();
    expect(updated!.lastErrorMessage).toBeUndefined();
  });

  test("schedule can be auto-disabled via enabled = false", async () => {
    const schedule = await createScheduledTask({
      name: "backoff-test-4",
      taskTemplate: "Test task",
      intervalMs: 60000,
    });

    expect(schedule.enabled).toBe(true);

    // Simulate auto-disable after MAX_CONSECUTIVE_ERRORS
    const updated = await updateScheduledTask(schedule.id, {
      consecutiveErrors: 5,
      lastErrorAt: new Date().toISOString(),
      lastErrorMessage: "Repeated failure",
      enabled: false,
    });

    expect(updated!.enabled).toBe(false);
    expect(updated!.consecutiveErrors).toBe(5);
  });

  test("nextRunAt can be pushed forward for backoff", async () => {
    const schedule = await createScheduledTask({
      name: "backoff-test-5",
      taskTemplate: "Test task",
      intervalMs: 60000,
    });

    const now = new Date();
    const backoffMs = 300_000; // 5 minutes
    const backoffTime = new Date(now.getTime() + backoffMs).toISOString();

    const updated = await updateScheduledTask(schedule.id, {
      consecutiveErrors: 2,
      lastErrorAt: now.toISOString(),
      lastErrorMessage: "Timeout",
      nextRunAt: backoffTime,
    });

    expect(updated!.nextRunAt).toBe(backoffTime);
    expect(updated!.consecutiveErrors).toBe(2);
  });

  test("error message is truncated to 500 chars", async () => {
    const schedule = await createScheduledTask({
      name: "backoff-test-6",
      taskTemplate: "Test task",
      intervalMs: 60000,
    });

    const longMessage = "x".repeat(1000);
    const updated = await updateScheduledTask(schedule.id, {
      consecutiveErrors: 1,
      lastErrorAt: new Date().toISOString(),
      lastErrorMessage: longMessage.slice(0, 500),
    });

    expect(updated!.lastErrorMessage!.length).toBe(500);
  });

  test("consecutiveErrors persists across reads", async () => {
    const schedule = await createScheduledTask({
      name: "backoff-test-7",
      taskTemplate: "Test task",
      intervalMs: 60000,
    });

    await updateScheduledTask(schedule.id, {
      consecutiveErrors: 3,
      lastErrorAt: new Date().toISOString(),
      lastErrorMessage: "Error 3",
    });

    // Read back from DB
    const reloaded = await getScheduledTaskById(schedule.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.consecutiveErrors).toBe(3);
    expect(reloaded!.lastErrorMessage).toBe("Error 3");
  });
});
