import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  findCompletedTaskInThread,
  getDb,
  getTaskById,
  initDb,
} from "../be/db";

const TEST_DB_PATH = "./test-follow-up-redelivery-guard.sqlite";

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

describe("findCompletedTaskInThread", () => {
  test("finds completed tasks in a thread within the time window", () => {
    const agent = createAgent({
      name: "dedup-worker-1",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = createTaskExtended("test task for thread", {
      agentId: agent.id,
      slackChannelId: "C_DEDUP_1",
      slackThreadTs: "1000.0001",
    });

    // Mark as completed
    completeTask(task.id, "done");

    // Should find the completed task within a 2880-minute (48h) window
    const result = findCompletedTaskInThread("C_DEDUP_1", "1000.0001", 2880);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(task.id);
    expect(result!.status).toBe("completed");
  });

  test("returns null when no completed tasks exist in the thread", () => {
    const agent = createAgent({
      name: "dedup-worker-2",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    // Create a task but don't complete it
    createTaskExtended("pending task in thread", {
      agentId: agent.id,
      slackChannelId: "C_DEDUP_2",
      slackThreadTs: "2000.0001",
    });

    const result = findCompletedTaskInThread("C_DEDUP_2", "2000.0001", 2880);
    expect(result).toBeNull();
  });

  test("returns null outside the time window", () => {
    const agent = createAgent({
      name: "dedup-worker-3",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = createTaskExtended("old completed task", {
      agentId: agent.id,
      slackChannelId: "C_DEDUP_3",
      slackThreadTs: "3000.0001",
    });

    completeTask(task.id, "done long ago");

    // Backdate the lastUpdatedAt to 49 hours ago (beyond the 48h window)
    const fortyNineHoursAgo = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
    getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
      fortyNineHoursAgo,
      task.id,
    ]);

    // Should not find with a 48 hour window
    const result = findCompletedTaskInThread("C_DEDUP_3", "3000.0001", 2880);
    expect(result).toBeNull();
  });

  test("returns null for a different thread", () => {
    const agent = createAgent({
      name: "dedup-worker-4",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = createTaskExtended("task in different thread", {
      agentId: agent.id,
      slackChannelId: "C_DEDUP_4",
      slackThreadTs: "4000.0001",
    });

    completeTask(task.id, "done");

    // Search in a different thread — should not find
    const result = findCompletedTaskInThread("C_DEDUP_4", "4000.9999", 2880);
    expect(result).toBeNull();
  });
});

describe("follow-up re-delegation guard logic", () => {
  let leadAgent: ReturnType<typeof createAgent>;
  let workerAgent: ReturnType<typeof createAgent>;

  beforeAll(() => {
    leadAgent = createAgent({
      name: "guard-lead",
      isLead: true,
      status: "idle",
      capabilities: [],
    });
    workerAgent = createAgent({
      name: "guard-worker",
      isLead: false,
      status: "idle",
      capabilities: [],
      maxTasks: 5,
    });
  });

  test("blocks re-delegation when source task is a follow-up and thread has completed work", () => {
    // Step 1: Create and complete a worker task in a Slack thread
    const workerTask = createTaskExtended("implement feature X", {
      agentId: workerAgent.id,
      slackChannelId: "C_GUARD_1",
      slackThreadTs: "5000.0001",
    });
    completeTask(workerTask.id, "Feature X implemented");

    // Step 2: Create a follow-up task (as store-progress would)
    const followUpTask = createTaskExtended("Worker task completed — review needed.", {
      agentId: leadAgent.id,
      source: "system",
      taskType: "follow-up",
      parentTaskId: workerTask.id,
      slackChannelId: "C_GUARD_1",
      slackThreadTs: "5000.0001",
    });

    // Step 3: Simulate the guard logic from send-task.ts
    // The lead's sourceTaskId would be the follow-up task
    const sourceTask = getTaskById(followUpTask.id);
    expect(sourceTask).not.toBeNull();
    expect(sourceTask!.taskType).toBe("follow-up");
    expect(sourceTask!.slackChannelId).toBe("C_GUARD_1");
    expect(sourceTask!.slackThreadTs).toBe("5000.0001");

    // The guard should find the completed worker task
    const recentCompleted = findCompletedTaskInThread(
      sourceTask!.slackChannelId!,
      sourceTask!.slackThreadTs!,
      2880,
    );
    expect(recentCompleted).not.toBeNull();
    expect(recentCompleted!.id).toBe(workerTask.id);

    // → Guard would block: re-delegation should be prevented
  });

  test("allows delegation when source task is NOT a follow-up (normal behavior)", () => {
    // Create a normal Slack task (not a follow-up)
    const slackTask = createTaskExtended("user asked a question", {
      agentId: leadAgent.id,
      source: "slack",
      taskType: "inbox",
      slackChannelId: "C_GUARD_2",
      slackThreadTs: "6000.0001",
    });

    // Even if there are completed tasks in the thread, guard shouldn't trigger
    // because the source task is not a "follow-up"
    const sourceTask = getTaskById(slackTask.id);
    expect(sourceTask).not.toBeNull();
    expect(sourceTask!.taskType).not.toBe("follow-up");

    // Guard condition: sourceTask?.taskType === "follow-up" → false
    // → Guard does NOT block: delegation proceeds normally
    const shouldBlock =
      sourceTask?.taskType === "follow-up" && sourceTask.slackThreadTs && sourceTask.slackChannelId;
    expect(shouldBlock).toBeFalsy();
  });

  test("allows delegation when source task is a follow-up but thread has NO completed work", () => {
    // Create a follow-up task in a thread with no completed work
    const followUpTask = createTaskExtended("Worker task failed — action needed.", {
      agentId: leadAgent.id,
      source: "system",
      taskType: "follow-up",
      slackChannelId: "C_GUARD_3",
      slackThreadTs: "7000.0001",
    });

    const sourceTask = getTaskById(followUpTask.id);
    expect(sourceTask).not.toBeNull();
    expect(sourceTask!.taskType).toBe("follow-up");

    // No completed tasks in this thread
    const recentCompleted = findCompletedTaskInThread(
      sourceTask!.slackChannelId!,
      sourceTask!.slackThreadTs!,
      2880,
    );
    expect(recentCompleted).toBeNull();

    // → Guard does NOT block: first-time delegation is fine
  });

  test("allows delegation when source task is a follow-up but completed work is outside time window", () => {
    // Create and complete a worker task, then backdate it
    const oldWorkerTask = createTaskExtended("old task", {
      agentId: workerAgent.id,
      slackChannelId: "C_GUARD_4",
      slackThreadTs: "8000.0001",
    });
    completeTask(oldWorkerTask.id, "done long ago");

    // Backdate to 49 hours ago (beyond the 48h window)
    const fortyNineHoursAgo = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
    getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
      fortyNineHoursAgo,
      oldWorkerTask.id,
    ]);

    // Create a follow-up in the same thread
    const followUpTask = createTaskExtended("Worker task completed — review needed.", {
      agentId: leadAgent.id,
      source: "system",
      taskType: "follow-up",
      slackChannelId: "C_GUARD_4",
      slackThreadTs: "8000.0001",
    });

    const sourceTask = getTaskById(followUpTask.id);
    const recentCompleted = findCompletedTaskInThread(
      sourceTask!.slackChannelId!,
      sourceTask!.slackThreadTs!,
      2880,
    );
    expect(recentCompleted).toBeNull();

    // → Guard does NOT block: completed work is too old
  });
});
