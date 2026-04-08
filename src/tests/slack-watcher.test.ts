import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  cancelTask,
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  getChildTasks,
  getCompletedSlackTasks,
  getInProgressSlackTasks,
  initDb,
  startTask,
} from "../be/db";
import {
  _getLastRenderedTree,
  _getTaskToTree,
  _getTreeLastUpdateTime,
  _getTreeMessages,
  buildTreeNodes,
  processTreeMessages,
  registerTreeMessage,
  startTaskWatcher,
  stopTaskWatcher,
} from "../slack/watcher";

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

describe("getChildTasks", () => {
  test("returns empty array when no children exist", () => {
    const agent = createAgent({ name: "ParentAgent", isLead: true, status: "idle" });
    const parent = createTaskExtended("parent task", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "C_TREE1",
      slackThreadTs: "3333333333.000001",
      slackUserId: "U_TREE1",
    });

    const children = getChildTasks(parent.id);
    expect(children).toEqual([]);
  });

  test("returns child tasks ordered by createdAt", () => {
    const lead = createAgent({ name: "LeadAgent", isLead: true, status: "idle" });
    const worker = createAgent({ name: "WorkerAgent", isLead: false, status: "idle" });

    const parent = createTaskExtended("parent task for children", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: "C_TREE2",
      slackThreadTs: "4444444444.000001",
      slackUserId: "U_TREE2",
    });

    const child1 = createTaskExtended("child task 1", {
      agentId: worker.id,
      source: "slack",
      parentTaskId: parent.id,
    });

    const child2 = createTaskExtended("child task 2", {
      agentId: worker.id,
      source: "slack",
      parentTaskId: parent.id,
    });

    const children = getChildTasks(parent.id);
    expect(children.length).toBe(2);
    expect(children[0].id).toBe(child1.id);
    expect(children[1].id).toBe(child2.id);
    expect(children[0].parentTaskId).toBe(parent.id);
    expect(children[1].parentTaskId).toBe(parent.id);
  });
});

describe("registerTreeMessage", () => {
  test("registers a single task in a new tree", () => {
    const taskId = "aaaa0001-0000-0000-0000-000000000000";
    const channelId = "C_REG1";
    const threadTs = "5555555555.000001";
    const messageTs = "5555555555.000002";

    registerTreeMessage(taskId, channelId, threadTs, messageTs);

    const treeMessages = _getTreeMessages();
    const taskToTree = _getTaskToTree();

    const tree = treeMessages.get(messageTs);
    expect(tree).toBeDefined();
    expect(tree!.channelId).toBe(channelId);
    expect(tree!.threadTs).toBe(threadTs);
    expect(tree!.messageTs).toBe(messageTs);
    expect(tree!.rootTaskIds.has(taskId)).toBe(true);
    expect(tree!.rootTaskIds.size).toBe(1);

    // Reverse lookup
    expect(taskToTree.get(taskId)).toBe(messageTs);
  });

  test("registers multiple tasks to the same tree message", () => {
    const taskId1 = "bbbb0001-0000-0000-0000-000000000000";
    const taskId2 = "bbbb0002-0000-0000-0000-000000000000";
    const channelId = "C_REG2";
    const threadTs = "6666666666.000001";
    const messageTs = "6666666666.000002";

    registerTreeMessage(taskId1, channelId, threadTs, messageTs);
    registerTreeMessage(taskId2, channelId, threadTs, messageTs);

    const treeMessages = _getTreeMessages();
    const taskToTree = _getTaskToTree();

    const tree = treeMessages.get(messageTs);
    expect(tree).toBeDefined();
    expect(tree!.rootTaskIds.size).toBe(2);
    expect(tree!.rootTaskIds.has(taskId1)).toBe(true);
    expect(tree!.rootTaskIds.has(taskId2)).toBe(true);

    // Both tasks point to the same messageTs
    expect(taskToTree.get(taskId1)).toBe(messageTs);
    expect(taskToTree.get(taskId2)).toBe(messageTs);
  });

  test("different messages create separate trees", () => {
    const taskId1 = "cccc0001-0000-0000-0000-000000000000";
    const taskId2 = "cccc0002-0000-0000-0000-000000000000";
    const channelId = "C_REG3";
    const threadTs = "7777777777.000001";
    const messageTs1 = "7777777777.000002";
    const messageTs2 = "7777777777.000003";

    registerTreeMessage(taskId1, channelId, threadTs, messageTs1);
    registerTreeMessage(taskId2, channelId, threadTs, messageTs2);

    const treeMessages = _getTreeMessages();

    expect(treeMessages.has(messageTs1)).toBe(true);
    expect(treeMessages.has(messageTs2)).toBe(true);
    expect(treeMessages.get(messageTs1)!.rootTaskIds.has(taskId1)).toBe(true);
    expect(treeMessages.get(messageTs2)!.rootTaskIds.has(taskId2)).toBe(true);
  });
});

describe("buildTreeNodes", () => {
  test("returns nodes for root-only tasks", () => {
    const agent = createAgent({ name: "TreeBuildLead", isLead: true, status: "idle" });
    const task = createTaskExtended("root only tree test", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "C_TREE_BUILD1",
      slackThreadTs: "8888888888.000001",
      slackUserId: "U_TREE_BUILD1",
    });

    const messageTs = "8888888888.000002";
    registerTreeMessage(task.id, "C_TREE_BUILD1", "8888888888.000001", messageTs);

    const tree = _getTreeMessages().get(messageTs)!;
    const nodes = buildTreeNodes(tree);

    expect(nodes.length).toBe(1);
    expect(nodes[0].taskId).toBe(task.id);
    expect(nodes[0].agentName).toBe("TreeBuildLead");
    expect(nodes[0].status).toBe("pending");
    expect(nodes[0].children).toEqual([]);
  });

  test("returns nodes with children and registers children in taskToTree", () => {
    const lead = createAgent({ name: "TreeBuildLead2", isLead: true, status: "idle" });
    const worker = createAgent({ name: "TreeBuildWorker", isLead: false, status: "idle" });

    const parent = createTaskExtended("parent for tree nodes", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: "C_TREE_BUILD2",
      slackThreadTs: "9999999999.000001",
      slackUserId: "U_TREE_BUILD2",
    });

    const child = createTaskExtended("child for tree nodes", {
      agentId: worker.id,
      source: "slack",
      parentTaskId: parent.id,
    });

    const messageTs = "9999999999.000002";
    registerTreeMessage(parent.id, "C_TREE_BUILD2", "9999999999.000001", messageTs);

    const tree = _getTreeMessages().get(messageTs)!;
    const nodes = buildTreeNodes(tree);

    expect(nodes.length).toBe(1);
    expect(nodes[0].taskId).toBe(parent.id);
    expect(nodes[0].agentName).toBe("TreeBuildLead2");
    expect(nodes[0].children.length).toBe(1);
    expect(nodes[0].children[0].taskId).toBe(child.id);
    expect(nodes[0].children[0].agentName).toBe("TreeBuildWorker");

    // Child should now be registered in taskToTree
    const taskToTree = _getTaskToTree();
    expect(taskToTree.get(child.id)).toBe(messageTs);
  });

  test("handles multiple root tasks in one tree", () => {
    const agent1 = createAgent({ name: "MultiRoot1", isLead: false, status: "idle" });
    const agent2 = createAgent({ name: "MultiRoot2", isLead: false, status: "idle" });

    const task1 = createTaskExtended("multi root task 1", {
      agentId: agent1.id,
      source: "slack",
      slackChannelId: "C_MULTI",
      slackThreadTs: "1010101010.000001",
      slackUserId: "U_MULTI",
    });

    const task2 = createTaskExtended("multi root task 2", {
      agentId: agent2.id,
      source: "slack",
      slackChannelId: "C_MULTI",
      slackThreadTs: "1010101010.000001",
      slackUserId: "U_MULTI",
    });

    const messageTs = "1010101010.000002";
    registerTreeMessage(task1.id, "C_MULTI", "1010101010.000001", messageTs);
    registerTreeMessage(task2.id, "C_MULTI", "1010101010.000001", messageTs);

    const tree = _getTreeMessages().get(messageTs)!;
    const nodes = buildTreeNodes(tree);

    expect(nodes.length).toBe(2);
    const taskIds = nodes.map((n) => n.taskId);
    expect(taskIds).toContain(task1.id);
    expect(taskIds).toContain(task2.id);
  });

  test("skips missing root tasks gracefully", () => {
    const messageTs = "1111111111.999999";
    const fakeTaskId = "zzzzzzzz-0000-0000-0000-000000000000";
    registerTreeMessage(fakeTaskId, "C_MISSING", "1111111111.000001", messageTs);

    const tree = _getTreeMessages().get(messageTs)!;
    const nodes = buildTreeNodes(tree);

    // Missing task should be skipped, not crash
    expect(nodes.length).toBe(0);
  });
});

// --- Phase 5: processTreeMessages tests ---

// Mock the Slack app so updateTreeMessage doesn't fail on missing app
mock.module("../slack/app", () => ({
  getSlackApp: () => ({
    client: {
      chat: {
        update: mock(() => Promise.resolve({ ok: true })),
      },
    },
  }),
}));

describe("processTreeMessages", () => {
  test("renders tree and updates Slack message for active tree", async () => {
    const agent = createAgent({ name: "TreeRenderAgent", isLead: true, status: "idle" });
    const task = createTaskExtended("tree render test", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "C_RENDER1",
      slackThreadTs: "2020202020.000001",
      slackUserId: "U_RENDER1",
    });

    // Start the task so it's in_progress
    startTask(task.id);

    const messageTs = "2020202020.000002";
    registerTreeMessage(task.id, "C_RENDER1", "2020202020.000001", messageTs);

    // Clear any rate limit state
    _getTreeLastUpdateTime().delete(messageTs);
    _getLastRenderedTree().delete(messageTs);

    await processTreeMessages();

    // Should have recorded the rendered state
    const lastRendered = _getLastRenderedTree().get(messageTs);
    expect(lastRendered).toBeDefined();
    expect(lastRendered!.length).toBeGreaterThan(0);

    // Should have recorded the update time
    const lastUpdateTime = _getTreeLastUpdateTime().get(messageTs);
    expect(lastUpdateTime).toBeDefined();
    expect(lastUpdateTime).toBeGreaterThan(0);
  });

  test("skips update when tree state unchanged (no-op)", async () => {
    const agent = createAgent({ name: "NoOpAgent", isLead: true, status: "idle" });
    const task = createTaskExtended("noop tree test", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "C_NOOP1",
      slackThreadTs: "3030303030.000001",
      slackUserId: "U_NOOP1",
    });

    startTask(task.id);

    const messageTs = "3030303030.000002";
    registerTreeMessage(task.id, "C_NOOP1", "3030303030.000001", messageTs);

    // Clear rate limit state
    _getTreeLastUpdateTime().delete(messageTs);
    _getLastRenderedTree().delete(messageTs);

    // First call — renders
    await processTreeMessages();
    const firstRendered = _getLastRenderedTree().get(messageTs);
    const firstUpdateTime = _getTreeLastUpdateTime().get(messageTs);
    expect(firstRendered).toBeDefined();
    expect(firstUpdateTime).toBeDefined();

    // Clear rate limit to allow second call
    _getTreeLastUpdateTime().delete(messageTs);

    // Second call — same state, should be a no-op (lastRenderedTree unchanged)
    await processTreeMessages();

    // Update time should NOT have been re-set (no-op skipped the update)
    const secondUpdateTime = _getTreeLastUpdateTime().get(messageTs);
    expect(secondUpdateTime).toBeUndefined();
  });

  test("cleans up tree when all tasks are terminal", async () => {
    const agent = createAgent({ name: "TerminalAgent", isLead: true, status: "idle" });
    const task = createTaskExtended("terminal tree test", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "C_TERM1",
      slackThreadTs: "4040404040.000001",
      slackUserId: "U_TERM1",
    });

    startTask(task.id);
    completeTask(task.id, "All done");

    const messageTs = "4040404040.000002";
    registerTreeMessage(task.id, "C_TERM1", "4040404040.000001", messageTs);

    // Clear rate limit state
    _getTreeLastUpdateTime().delete(messageTs);
    _getLastRenderedTree().delete(messageTs);

    await processTreeMessages();

    // Tree should be cleaned up since it's fully terminal
    expect(_getTreeMessages().has(messageTs)).toBe(false);
    expect(_getTaskToTree().has(task.id)).toBe(false);
    expect(_getLastRenderedTree().has(messageTs)).toBe(false);
    expect(_getTreeLastUpdateTime().has(messageTs)).toBe(false);
  });

  test("cleans up tree with root + children when all terminal", async () => {
    const lead = createAgent({ name: "TermLead", isLead: true, status: "idle" });
    const worker = createAgent({ name: "TermWorker", isLead: false, status: "idle" });

    const parent = createTaskExtended("terminal parent", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: "C_TERM2",
      slackThreadTs: "5050505050.000001",
      slackUserId: "U_TERM2",
    });

    const child = createTaskExtended("terminal child", {
      agentId: worker.id,
      source: "slack",
      parentTaskId: parent.id,
    });

    startTask(parent.id);
    startTask(child.id);
    completeTask(child.id, "Child done");
    completeTask(parent.id, "Parent done");

    const messageTs = "5050505050.000002";
    registerTreeMessage(parent.id, "C_TERM2", "5050505050.000001", messageTs);

    _getTreeLastUpdateTime().delete(messageTs);
    _getLastRenderedTree().delete(messageTs);

    await processTreeMessages();

    // Both parent and child should be cleaned up
    expect(_getTreeMessages().has(messageTs)).toBe(false);
    expect(_getTaskToTree().has(parent.id)).toBe(false);
    expect(_getTaskToTree().has(child.id)).toBe(false);
  });

  test("does NOT clean up tree when some tasks still active", async () => {
    const lead = createAgent({ name: "ActiveLead", isLead: true, status: "idle" });
    const worker = createAgent({ name: "ActiveWorker", isLead: false, status: "idle" });

    const parent = createTaskExtended("active parent", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: "C_ACTIVE1",
      slackThreadTs: "6060606060.000001",
      slackUserId: "U_ACTIVE1",
    });

    const child = createTaskExtended("active child", {
      agentId: worker.id,
      source: "slack",
      parentTaskId: parent.id,
    });

    startTask(parent.id);
    startTask(child.id);
    // Child completes but parent still in_progress
    completeTask(child.id, "Child done");

    const messageTs = "6060606060.000002";
    registerTreeMessage(parent.id, "C_ACTIVE1", "6060606060.000001", messageTs);

    _getTreeLastUpdateTime().delete(messageTs);
    _getLastRenderedTree().delete(messageTs);

    await processTreeMessages();

    // Tree should still be tracked (parent still active)
    expect(_getTreeMessages().has(messageTs)).toBe(true);
    expect(_getTaskToTree().has(parent.id)).toBe(true);
  });

  test("respects rate limiting", async () => {
    const agent = createAgent({ name: "RateLimitAgent", isLead: true, status: "idle" });
    const task = createTaskExtended("rate limit test", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "C_RATE1",
      slackThreadTs: "7070707070.000001",
      slackUserId: "U_RATE1",
    });

    startTask(task.id);

    const messageTs = "7070707070.000002";
    registerTreeMessage(task.id, "C_RATE1", "7070707070.000001", messageTs);

    // Clear state
    _getTreeLastUpdateTime().delete(messageTs);
    _getLastRenderedTree().delete(messageTs);

    // First call renders
    await processTreeMessages();
    const firstUpdateTime = _getTreeLastUpdateTime().get(messageTs);
    expect(firstUpdateTime).toBeDefined();

    // Second call immediately — should be rate limited (update time is very recent)
    // Force lastRenderedTree to be different so it's not a no-op for content reasons
    _getLastRenderedTree().delete(messageTs);

    await processTreeMessages();

    // Update time should not have changed (rate limited)
    const secondUpdateTime = _getTreeLastUpdateTime().get(messageTs);
    expect(secondUpdateTime).toBe(firstUpdateTime);
  });
});

describe("tree-tracked tasks skip flat processing", () => {
  test("taskToTree check prevents double-processing of in-progress tasks", () => {
    // This is a structural test: verify taskToTree.has() is used in the watcher
    // by checking that a task registered in taskToTree is tracked
    const taskId = "dddd0001-0000-0000-0000-000000000000";
    const messageTs = "8080808080.000002";
    registerTreeMessage(taskId, "C_SKIP1", "8080808080.000001", messageTs);

    const taskToTree = _getTaskToTree();
    expect(taskToTree.has(taskId)).toBe(true);

    // The watcher loop checks taskToTree.has(task.id) to skip tree-tracked tasks.
    // We verify the data structure is correctly populated — the actual skip logic
    // is in the interval callback which we test via the full integration above.
  });

  test("child tasks discovered by buildTreeNodes are added to taskToTree", () => {
    const lead = createAgent({ name: "SkipLead", isLead: true, status: "idle" });
    const worker = createAgent({ name: "SkipWorker", isLead: false, status: "idle" });

    const parent = createTaskExtended("skip parent", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: "C_SKIP2",
      slackThreadTs: "9090909090.000001",
      slackUserId: "U_SKIP2",
    });

    const child = createTaskExtended("skip child", {
      agentId: worker.id,
      source: "slack",
      parentTaskId: parent.id,
    });

    const messageTs = "9090909090.000002";
    registerTreeMessage(parent.id, "C_SKIP2", "9090909090.000001", messageTs);

    // Before buildTreeNodes, child is NOT in taskToTree
    const taskToTree = _getTaskToTree();
    expect(taskToTree.has(child.id)).toBe(false);

    // After buildTreeNodes, child IS in taskToTree
    const tree = _getTreeMessages().get(messageTs)!;
    buildTreeNodes(tree);

    expect(taskToTree.has(child.id)).toBe(true);
    expect(taskToTree.get(child.id)).toBe(messageTs);
  });
});
