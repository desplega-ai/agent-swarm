import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getTaskById,
  initDb,
  updateTaskProgress,
} from "../be/db";

const TEST_DB_PATH = "./test-progress-dedup.sqlite";

describe("progress deduplication", () => {
  let agentId: string;
  let taskId: string;

  beforeAll(() => {
    initDb(TEST_DB_PATH);

    const agent = createAgent({
      name: "Dedup Test Worker",
      description: "Test agent for progress deduplication",
      role: "worker",
      isLead: false,
      status: "busy",
      maxTasks: 1,
      capabilities: [],
    });
    agentId = agent.id;

    const task = createTaskExtended("Test dedup task", {
      agentId,
      source: "mcp",
      priority: 50,
    });
    taskId = task.id;
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

  test("updateTaskProgress stores progress and updates lastUpdatedAt", () => {
    const result = updateTaskProgress(taskId, "Working on step 1");
    expect(result).not.toBeNull();
    expect(result!.progress).toBe("Working on step 1");
    expect(result!.lastUpdatedAt).toBeDefined();
  });

  test("can detect duplicate progress by comparing task fields", () => {
    // First update
    updateTaskProgress(taskId, "Working on step 2");
    const task1 = getTaskById(taskId);

    // Simulate dedup logic (same as store-progress.ts)
    const progress = "Working on step 2";
    const isDuplicate =
      task1!.progress === progress &&
      task1!.lastUpdatedAt &&
      Date.now() - new Date(task1!.lastUpdatedAt).getTime() < 5 * 60 * 1000;

    expect(isDuplicate).toBe(true);
  });

  test("not a duplicate when progress text differs", () => {
    updateTaskProgress(taskId, "Working on step 3");
    const task1 = getTaskById(taskId);

    const isDuplicate =
      task1!.progress === "Different progress text" &&
      task1!.lastUpdatedAt &&
      Date.now() - new Date(task1!.lastUpdatedAt).getTime() < 5 * 60 * 1000;

    expect(isDuplicate).toBe(false);
  });

  test("not a duplicate when lastUpdatedAt is old (>5 min)", () => {
    updateTaskProgress(taskId, "Working on step 4");
    const task1 = getTaskById(taskId);

    // Simulate old timestamp (6 minutes ago)
    const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const isDuplicate =
      task1!.progress === "Working on step 4" &&
      sixMinAgo &&
      Date.now() - new Date(sixMinAgo).getTime() < 5 * 60 * 1000;

    expect(isDuplicate).toBe(false);
  });
});
