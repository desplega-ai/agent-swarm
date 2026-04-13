import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";
import { createTrackerSync, getTrackerSync, updateTrackerSync } from "../be/db-queries/tracker";
import { initLinearOutboundSync, teardownLinearOutboundSync } from "../linear/outbound";
import { workflowEventBus } from "../workflows/event-bus";

const TEST_DB_PATH = "./test-linear-outbound-sync.sqlite";

// Mock the Linear client module
const mockCreateComment = mock(() => Promise.resolve({ success: true }));

mock.module("../linear/client", () => ({
  getLinearClient: () => ({
    createComment: mockCreateComment,
  }),
  resetLinearClient: () => {},
}));

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

describe("Linear Outbound Sync", () => {
  beforeEach(() => {
    mockCreateComment.mockClear();
    initLinearOutboundSync();
  });

  afterEach(() => {
    teardownLinearOutboundSync();
  });

  test("task.completed posts comment to Linear when mapping exists", async () => {
    createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: "outbound-task-completed",
      externalId: "LIN-OUT-COMPLETED",
      externalIdentifier: "ENG-200",
      syncDirection: "bidirectional",
    });

    workflowEventBus.emit("task.completed", {
      taskId: "outbound-task-completed",
      output: "All done!",
    });

    // Allow async handler to run
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockCreateComment).toHaveBeenCalledTimes(1);
    const callArgs = mockCreateComment.mock.calls[0] as unknown[];
    const arg = callArgs[0] as { issueId: string; body: string };
    expect(arg.issueId).toBe("LIN-OUT-COMPLETED");
    expect(arg.body).toContain("Task completed");
    expect(arg.body).toContain("All done!");

    // Verify sync record updated
    const updated = getTrackerSync("linear", "task", "outbound-task-completed");
    expect(updated!.lastSyncOrigin).toBe("swarm");
  });

  test("task.failed posts failure comment to Linear", async () => {
    createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: "outbound-task-failed",
      externalId: "LIN-OUT-FAILED",
      syncDirection: "bidirectional",
    });

    workflowEventBus.emit("task.failed", {
      taskId: "outbound-task-failed",
      failureReason: "Build error in module X",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockCreateComment).toHaveBeenCalledTimes(1);
    const callArgs = mockCreateComment.mock.calls[0] as unknown[];
    const arg = callArgs[0] as { issueId: string; body: string };
    expect(arg.issueId).toBe("LIN-OUT-FAILED");
    expect(arg.body).toContain("Task failed");
    expect(arg.body).toContain("Build error in module X");
  });

  test("no-op when no tracker_sync mapping exists", async () => {
    workflowEventBus.emit("task.completed", {
      taskId: "nonexistent-task-id",
      output: "done",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  test("loop prevention: skips if lastSyncOrigin is external and recent", async () => {
    const sync = createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: "outbound-task-loop",
      externalId: "LIN-OUT-LOOP",
      syncDirection: "bidirectional",
    });

    // Simulate a recent external sync
    updateTrackerSync(sync.id, {
      lastSyncOrigin: "external",
      lastSyncedAt: new Date().toISOString(),
    });

    workflowEventBus.emit("task.completed", {
      taskId: "outbound-task-loop",
      output: "done",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  test("allows sync when lastSyncOrigin is external but old", async () => {
    const sync = createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: "outbound-task-old-external",
      externalId: "LIN-OUT-OLD",
      syncDirection: "bidirectional",
    });

    // Set a lastSyncedAt well in the past (10 seconds ago)
    updateTrackerSync(sync.id, {
      lastSyncOrigin: "external",
      lastSyncedAt: new Date(Date.now() - 10_000).toISOString(),
    });

    workflowEventBus.emit("task.completed", {
      taskId: "outbound-task-old-external",
      output: "done",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockCreateComment).toHaveBeenCalledTimes(1);
  });

  test("allows sync when lastSyncOrigin is swarm (not external)", async () => {
    const sync = createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: "outbound-task-swarm-origin",
      externalId: "LIN-OUT-SWARM",
      syncDirection: "bidirectional",
    });

    updateTrackerSync(sync.id, {
      lastSyncOrigin: "swarm",
      lastSyncedAt: new Date().toISOString(),
    });

    workflowEventBus.emit("task.completed", {
      taskId: "outbound-task-swarm-origin",
      output: "done",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockCreateComment).toHaveBeenCalledTimes(1);
  });

  test("teardown removes event listeners", async () => {
    teardownLinearOutboundSync();

    createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: "outbound-task-teardown",
      externalId: "LIN-OUT-TEARDOWN",
      syncDirection: "bidirectional",
    });

    workflowEventBus.emit("task.completed", {
      taskId: "outbound-task-teardown",
      output: "done",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockCreateComment).not.toHaveBeenCalled();
  });
});
