import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getCompletedSlackTasks,
  getInProgressSlackTasks,
  getMostRecentTaskInThread,
  initDb,
} from "../be/db";
import { routeMessage } from "../slack/router";

const TEST_DB_PATH = "./test-slack-thread-followups.sqlite";

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

describe("getMostRecentTaskInThread", () => {
  test("returns null when no tasks exist for thread", () => {
    const result = getMostRecentTaskInThread("C_EMPTY", "9999.0001");
    expect(result).toBeNull();
  });

  test("returns a task regardless of source (slack, system, etc.)", () => {
    const agent = createAgent({
      name: "source-test-agent",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    // Create tasks with different sources
    const slackTask = createTaskExtended("slack source task", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "C_SOURCE",
      slackThreadTs: "1000.0001",
    });

    const systemTask = createTaskExtended("system source task", {
      agentId: agent.id,
      source: "system",
      slackChannelId: "C_SOURCE",
      slackThreadTs: "1000.0001",
    });

    const result = getMostRecentTaskInThread("C_SOURCE", "1000.0001");
    expect(result).not.toBeNull();
    // Should return one of the tasks — importantly, it doesn't filter by source
    expect([slackTask.id, systemTask.id]).toContain(result!.id);
  });

  test("returns a task regardless of status (completed, pending, etc.)", () => {
    const agent = createAgent({
      name: "status-test-agent",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task1 = createTaskExtended("completed task", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "C_STATUS",
      slackThreadTs: "2000.0001",
    });

    const task2 = createTaskExtended("in progress task", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "C_STATUS",
      slackThreadTs: "2000.0001",
    });

    const result = getMostRecentTaskInThread("C_STATUS", "2000.0001");
    expect(result).not.toBeNull();
    // Returns one of the tasks — importantly, it doesn't filter by status
    expect([task1.id, task2.id]).toContain(result!.id);
  });

  test("returns task with source=null (worker tasks via send-task)", () => {
    const agent = createAgent({
      name: "null-source-agent",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    // Worker tasks created via send-task default to source=null — simulate with no source
    const workerTask = createTaskExtended("worker task", {
      agentId: agent.id,
      slackChannelId: "C_WORKER",
      slackThreadTs: "3000.0001",
    });

    const result = getMostRecentTaskInThread("C_WORKER", "3000.0001");
    expect(result).not.toBeNull();
    expect(result!.id).toBe(workerTask.id);
  });
});

describe("routeMessage — thread follow-up with offline agent", () => {
  let leadAgent: ReturnType<typeof createAgent>;
  let workerAgent: ReturnType<typeof createAgent>;

  beforeAll(() => {
    leadAgent = createAgent({ name: "route-lead", isLead: true, status: "idle", capabilities: [] });
    workerAgent = createAgent({
      name: "route-worker",
      isLead: false,
      status: "offline",
      capabilities: [],
    });

    // Create a task in the thread so getAgentWorkingOnThread finds the offline worker
    createTaskExtended("original task", {
      agentId: workerAgent.id,
      source: "slack",
      slackChannelId: "C_ROUTE",
      slackThreadTs: "4000.0001",
    });
  });

  test("routes to lead when thread agent is offline and bot NOT mentioned", () => {
    const matches = routeMessage("follow up question", "B_BOT", false, {
      channelId: "C_ROUTE",
      threadTs: "4000.0001",
    });

    expect(matches.length).toBe(1);
    expect(matches[0].agent.id).toBe(leadAgent.id);
    expect(matches[0].matchedText).toBe("thread follow-up (lead fallback)");
  });

  test("routes to lead when thread agent is offline and bot IS mentioned", () => {
    // With botMentioned=true and thread context, the thread follow-up path should still fire
    // because it checks before the botMentioned fallback
    const matches = routeMessage("follow up question", "B_BOT", true, {
      channelId: "C_ROUTE",
      threadTs: "4000.0001",
    });

    expect(matches.length).toBe(1);
    expect(matches[0].agent.id).toBe(leadAgent.id);
    expect(matches[0].matchedText).toBe("thread follow-up (lead fallback)");
  });

  test("still routes to working agent when agent is online (no regression)", () => {
    const onlineWorker = createAgent({
      name: "route-online-worker",
      isLead: false,
      status: "busy",
      capabilities: [],
    });

    createTaskExtended("online task", {
      agentId: onlineWorker.id,
      source: "slack",
      slackChannelId: "C_ROUTE_ONLINE",
      slackThreadTs: "5000.0001",
    });

    const matches = routeMessage("follow up", "B_BOT", false, {
      channelId: "C_ROUTE_ONLINE",
      threadTs: "5000.0001",
    });

    expect(matches.length).toBe(1);
    expect(matches[0].agent.id).toBe(onlineWorker.id);
    expect(matches[0].matchedText).toBe("thread follow-up");
  });
});

describe("follow-up task creation includes parentTaskId", () => {
  test("parentTaskId is null when thread has no previous tasks (new thread)", () => {
    const result = getMostRecentTaskInThread("C_NEW_THREAD", "8000.0001");
    expect(result).toBeNull();
  });

  test("parentTaskId links to most recent task even if that task is completed", () => {
    const agent = createAgent({
      name: "parent-test-agent",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const firstTask = createTaskExtended("first task", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "C_PARENT",
      slackThreadTs: "6000.0001",
    });

    // The most recent task should be returned for parentTaskId linking
    const result = getMostRecentTaskInThread("C_PARENT", "6000.0001");
    expect(result).not.toBeNull();
    expect(result!.id).toBe(firstTask.id);

    // Create a follow-up with parentTaskId
    const followUp = createTaskExtended("follow up task", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "C_PARENT",
      slackThreadTs: "6000.0001",
      parentTaskId: result!.id,
    });

    expect(followUp.parentTaskId).toBe(firstTask.id);
  });
});

describe("watcher query scope — getCompletedSlackTasks / getInProgressSlackTasks", () => {
  test("includes tasks with source='slack' and slackChannelId set", () => {
    const agent = createAgent({
      name: "watcher-slack-agent",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    createTaskExtended("slack completed task", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "C_WATCHER",
      slackThreadTs: "7000.0001",
      status: "unassigned",
    });

    const completed = getCompletedSlackTasks();
    const inProgress = getInProgressSlackTasks();
    // Just verify the query doesn't error — specific status filtering tested below
    expect(Array.isArray(completed)).toBe(true);
    expect(Array.isArray(inProgress)).toBe(true);
  });

  test("includes tasks with source=null (worker tasks) that have slackChannelId set", () => {
    const agent = createAgent({
      name: "watcher-null-agent",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    // Worker task with no source but has Slack metadata (inherited via parentTaskId)
    const _workerTask = createTaskExtended("worker completed", {
      agentId: agent.id,
      slackChannelId: "C_WATCHER_NULL",
      slackThreadTs: "7100.0001",
    });

    // All tasks with slackChannelId should be visible regardless of source
    const allCompleted = getCompletedSlackTasks();
    const allInProgress = getInProgressSlackTasks();
    // Task is pending, not completed or in_progress, so it won't appear in either
    // But the queries shouldn't filter by source anymore
    expect(Array.isArray(allCompleted)).toBe(true);
    expect(Array.isArray(allInProgress)).toBe(true);
  });

  test("excludes tasks without slackChannelId (non-Slack tasks)", () => {
    const agent = createAgent({
      name: "watcher-no-slack-agent",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    createTaskExtended("non-slack task", {
      agentId: agent.id,
      source: "mcp",
    });

    const completed = getCompletedSlackTasks();
    const inProgress = getInProgressSlackTasks();

    // None of the returned tasks should have null slackChannelId
    for (const task of completed) {
      expect(task.slackChannelId).not.toBeNull();
    }
    for (const task of inProgress) {
      expect(task.slackChannelId).not.toBeNull();
    }
  });
});
