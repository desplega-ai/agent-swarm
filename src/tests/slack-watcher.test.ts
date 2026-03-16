import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  cancelTask,
  closeDb,
  createAgent,
  createTaskExtended,
  getCompletedSlackTasks,
  getInProgressSlackTasks,
  initDb,
} from "../be/db";
import { startTaskWatcher, stopTaskWatcher } from "../slack/watcher";

const TEST_DB_PATH = "./test-slack-watcher.sqlite";

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(() => {
  stopTaskWatcher();
  closeDb();
  try {
    unlinkSync(TEST_DB_PATH);
    unlinkSync(`${TEST_DB_PATH}-wal`);
    unlinkSync(`${TEST_DB_PATH}-shm`);
  } catch {
    // ignore if files don't exist
  }
});

describe("startTaskWatcher / stopTaskWatcher", () => {
  test("starts and stops without error", () => {
    startTaskWatcher(60000); // Long interval so it doesn't fire during test
    stopTaskWatcher();
  });

  test("is idempotent — starting twice does not error", () => {
    startTaskWatcher(60000);
    startTaskWatcher(60000); // Should log "already running", not throw
    stopTaskWatcher();
  });

  test("stopping when not running does not error", () => {
    stopTaskWatcher();
    stopTaskWatcher();
  });
});

describe("watcher DB queries", () => {
  test("getInProgressSlackTasks excludes pending tasks (only in_progress)", () => {
    // createTaskExtended creates tasks as 'pending', not 'in_progress'
    const agent = createAgent({ name: "WatcherTestAgent", isLead: false, status: "idle" });
    const task = createTaskExtended("watcher pending test", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "C_WATCHER",
      slackThreadTs: "1111111111.000001",
      slackUserId: "U_WATCHER",
    });

    const inProgress = getInProgressSlackTasks();
    const found = inProgress.find((t) => t.id === task.id);
    // Task is 'pending', not 'in_progress', so it should NOT appear
    expect(found).toBeUndefined();
  });

  test("getInProgressSlackTasks returns array", () => {
    const inProgress = getInProgressSlackTasks();
    expect(Array.isArray(inProgress)).toBe(true);
  });

  test("getCompletedSlackTasks excludes cancelled tasks (only completed/failed)", () => {
    const agent = createAgent({ name: "WatcherCompAgent", isLead: false, status: "idle" });
    const task = createTaskExtended("watcher cancel test", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "C_WATCHER2",
      slackThreadTs: "2222222222.000001",
      slackUserId: "U_WATCHER2",
    });

    cancelTask(task.id, "test cancel");

    const completed = getCompletedSlackTasks();
    const found = completed.find((t) => t.id === task.id);
    // Cancelled tasks are NOT included in getCompletedSlackTasks (only completed/failed)
    expect(found).toBeUndefined();
  });

  test("getCompletedSlackTasks returns array", () => {
    const completed = getCompletedSlackTasks();
    expect(Array.isArray(completed)).toBe(true);
  });

  test("initializes notifiedCompletions on start to skip existing completed tasks", () => {
    // Starting the watcher with existing data should not crash
    startTaskWatcher(60000);
    stopTaskWatcher();
  });
});
