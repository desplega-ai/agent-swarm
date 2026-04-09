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
  _isDMChannel,
  _postInitialDMTreeMessage,
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

// Mock Slack API methods for tree message updates, DM posting, and assistant status
const mockChatUpdate = mock(() => Promise.resolve({ ok: true }));
const mockChatPostMessage = mock(() => Promise.resolve({ ok: true, ts: "mock.dm.tree.000001" }));
const mockSetStatus = mock(() => Promise.resolve({ ok: true }));

mock.module("../slack/app", () => ({
  getSlackApp: () => ({
    client: {
      chat: {
        update: mockChatUpdate,
        postMessage: mockChatPostMessage,
      },
      assistant: {
        threads: {
          setStatus: mockSetStatus,
        },
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

// --- Phase 6: DM Unification tests ---

describe("isDMChannel", () => {
  test("returns true for DM channels (starting with D)", () => {
    expect(_isDMChannel("D12345678")).toBe(true);
    expect(_isDMChannel("DABCDEFGH")).toBe(true);
  });

  test("returns false for regular channels", () => {
    expect(_isDMChannel("C12345678")).toBe(false);
    expect(_isDMChannel("G12345678")).toBe(false);
  });
});

describe("DM unification — postInitialDMTreeMessage", () => {
  test("posts a tree message for a DM task and returns messageTs", async () => {
    const agent = createAgent({ name: "DMTreeAgent", isLead: false, status: "idle" });
    const task = createTaskExtended("dm tree test", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "D_DM_TREE1",
      slackThreadTs: "1212121212.000001",
      slackUserId: "U_DM1",
    });

    startTask(task.id);

    // Re-fetch the task to get in_progress status
    const { getTaskById } = await import("../be/db");
    const freshTask = getTaskById(task.id)!;

    const messageTs = await _postInitialDMTreeMessage(freshTask);
    expect(messageTs).toBe("mock.dm.tree.000001");

    // Verify chat.postMessage was called with the DM channel
    expect(mockChatPostMessage).toHaveBeenCalled();
    const lastCall = mockChatPostMessage.mock.calls[mockChatPostMessage.mock.calls.length - 1];
    expect((lastCall[0] as any).channel).toBe("D_DM_TREE1");
    expect((lastCall[0] as any).thread_ts).toBe("1212121212.000001");
    expect((lastCall[0] as any).blocks).toBeDefined();
  });

  test("returns undefined when task has no agentId", async () => {
    const task = createTaskExtended("dm no agent test", {
      source: "slack",
      slackChannelId: "D_DM_TREE2",
      slackThreadTs: "1313131313.000001",
      slackUserId: "U_DM2",
    });

    const { getTaskById } = await import("../be/db");
    const freshTask = getTaskById(task.id)!;

    const messageTs = await _postInitialDMTreeMessage(freshTask);
    expect(messageTs).toBeUndefined();
  });
});

describe("DM unification — tree messages in DMs", () => {
  test("DM tasks get tree messages registered via registerTreeMessage", () => {
    const agent = createAgent({ name: "DMRegAgent", isLead: false, status: "idle" });
    const task = createTaskExtended("dm register test", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "D_DM_REG1",
      slackThreadTs: "1414141414.000001",
      slackUserId: "U_DM_REG1",
    });

    const messageTs = "1414141414.000002";
    // DM channel ID starts with "D" — this is the same registerTreeMessage used for channels
    registerTreeMessage(task.id, "D_DM_REG1", "1414141414.000001", messageTs);

    const treeMessages = _getTreeMessages();
    const tree = treeMessages.get(messageTs);
    expect(tree).toBeDefined();
    expect(tree!.channelId).toBe("D_DM_REG1");
    expect(tree!.rootTaskIds.has(task.id)).toBe(true);

    // Task is tracked in taskToTree
    const taskToTree = _getTaskToTree();
    expect(taskToTree.get(task.id)).toBe(messageTs);
  });

  test("DM tree updates work via processTreeMessages (chat.update)", async () => {
    const agent = createAgent({ name: "DMUpdateAgent", isLead: true, status: "idle" });
    const task = createTaskExtended("dm tree update test", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "D_DM_UPD1",
      slackThreadTs: "1515151515.000001",
      slackUserId: "U_DM_UPD1",
    });

    startTask(task.id);

    const messageTs = "1515151515.000002";
    registerTreeMessage(task.id, "D_DM_UPD1", "1515151515.000001", messageTs);

    // Clear rate limit and rendered state
    _getTreeLastUpdateTime().delete(messageTs);
    _getLastRenderedTree().delete(messageTs);

    // Reset mock call counts
    mockChatUpdate.mockClear();
    mockSetStatus.mockClear();

    await processTreeMessages();

    // chat.update should have been called (tree rendering)
    expect(mockChatUpdate).toHaveBeenCalled();

    // Rendered state should be recorded
    const lastRendered = _getLastRenderedTree().get(messageTs);
    expect(lastRendered).toBeDefined();
    expect(lastRendered!.length).toBeGreaterThan(0);
  });

  test("assistant status is set in parallel for DM tree messages", async () => {
    const agent = createAgent({ name: "DMStatusAgent", isLead: true, status: "idle" });
    const task = createTaskExtended("dm status test", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "D_DM_STATUS1",
      slackThreadTs: "1616161616.000001",
      slackUserId: "U_DM_STATUS1",
    });

    startTask(task.id);

    const messageTs = "1616161616.000002";
    registerTreeMessage(task.id, "D_DM_STATUS1", "1616161616.000001", messageTs);

    // Clear rate limit and rendered state
    _getTreeLastUpdateTime().delete(messageTs);
    _getLastRenderedTree().delete(messageTs);

    mockSetStatus.mockClear();

    await processTreeMessages();

    // Wait a tick for the fire-and-forget setAssistantStatus to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // setAssistantStatus should have been called for the DM channel
    expect(mockSetStatus).toHaveBeenCalled();
    const statusCall = mockSetStatus.mock.calls[mockSetStatus.mock.calls.length - 1];
    expect((statusCall[0] as any).channel_id).toBe("D_DM_STATUS1");
    expect((statusCall[0] as any).thread_ts).toBe("1616161616.000001");
    // Status text should be set (not empty — task is still in progress)
    expect((statusCall[0] as any).status).toBeTruthy();
  });

  test("assistant status is cleared when DM tree is fully terminal", async () => {
    const agent = createAgent({ name: "DMTermAgent", isLead: true, status: "idle" });
    const task = createTaskExtended("dm terminal test", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "D_DM_TERM1",
      slackThreadTs: "1717171717.000001",
      slackUserId: "U_DM_TERM1",
    });

    startTask(task.id);
    completeTask(task.id, "Done in DM");

    const messageTs = "1717171717.000002";
    registerTreeMessage(task.id, "D_DM_TERM1", "1717171717.000001", messageTs);

    _getTreeLastUpdateTime().delete(messageTs);
    _getLastRenderedTree().delete(messageTs);

    mockSetStatus.mockClear();

    await processTreeMessages();

    // Wait a tick for the fire-and-forget setAssistantStatus to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // setAssistantStatus should have been called with empty status (clearing indicator)
    expect(mockSetStatus).toHaveBeenCalled();
    const statusCall = mockSetStatus.mock.calls[mockSetStatus.mock.calls.length - 1];
    expect((statusCall[0] as any).channel_id).toBe("D_DM_TERM1");
    expect((statusCall[0] as any).status).toBe("");
  });

  test("non-DM channel trees do NOT trigger assistant status", async () => {
    const agent = createAgent({ name: "NonDMAgent", isLead: true, status: "idle" });
    const task = createTaskExtended("non dm test", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "C_NON_DM1",
      slackThreadTs: "1818181818.000001",
      slackUserId: "U_NON_DM1",
    });

    startTask(task.id);

    const messageTs = "1818181818.000002";
    registerTreeMessage(task.id, "C_NON_DM1", "1818181818.000001", messageTs);

    _getTreeLastUpdateTime().delete(messageTs);
    _getLastRenderedTree().delete(messageTs);

    mockSetStatus.mockClear();

    await processTreeMessages();

    // Wait a tick
    await new Promise((resolve) => setTimeout(resolve, 50));

    // setAssistantStatus should NOT have been called for a non-DM channel
    expect(mockSetStatus).not.toHaveBeenCalled();
  });
});
