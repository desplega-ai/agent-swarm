import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";
import { createTrackerSync, getTrackerSync, updateTrackerSync } from "../be/db-queries/tracker";
import {
  formatLinearOutcomeBody,
  initLinearOutboundSync,
  LINEAR_BODY_MAX,
  teardownLinearOutboundSync,
} from "../linear/outbound";
import { taskSessionMap } from "../linear/sync";
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

// Mock the AgentSession helpers in linear/sync so we can assert which activity type
// the outbound handlers post (`action` vs `thought` vs `response`/`error`).
const mockPostAgentSessionThought = mock(() => Promise.resolve());
const mockPostAgentSessionAction = mock(() => Promise.resolve());
const mockEndAgentSession = mock(() => Promise.resolve());

mock.module("../linear/sync", () => ({
  postAgentSessionThought: mockPostAgentSessionThought,
  postAgentSessionAction: mockPostAgentSessionAction,
  endAgentSession: mockEndAgentSession,
  taskSessionMap,
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
    mockPostAgentSessionThought.mockClear();
    mockPostAgentSessionAction.mockClear();
    mockEndAgentSession.mockClear();
    taskSessionMap.clear();
    initLinearOutboundSync();
  });

  afterEach(() => {
    teardownLinearOutboundSync();
    taskSessionMap.clear();
  });

  test("task.completed posts comment to Linear when mapping exists", async () => {
    await createTrackerSync({
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
    // The output is the whole comment: no boilerplate, no collapsed `+++` section.
    expect(arg.body).toBe("All done!");

    // Verify sync record updated
    const updated = await getTrackerSync("linear", "task", "outbound-task-completed");
    expect(updated!.lastSyncOrigin).toBe("swarm");
  });

  test("task.failed posts failure comment to Linear", async () => {
    await createTrackerSync({
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
    expect(arg.body).toBe("Task failed.\n\nBuild error in module X");
  });

  test("task.completed with an AgentSession posts ONE response activity carrying the full output", async () => {
    const taskId = "outbound-session-completed";
    await createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: taskId,
      externalId: "LIN-OUT-SESSION-COMPLETED",
      syncDirection: "bidirectional",
    });
    taskSessionMap.set(taskId, "session-completed");
    // Longer than the old 2000-char cut, shorter than the Linear body cap.
    const output = `## Answer\n\n${"x".repeat(5000)}`;

    workflowEventBus.emit("task.completed", { taskId, output });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockEndAgentSession).toHaveBeenCalledTimes(1);
    expect(mockEndAgentSession.mock.calls[0] as unknown[]).toEqual([
      "session-completed",
      output,
      "response",
    ]);
    expect(mockCreateComment).not.toHaveBeenCalled();
    expect(taskSessionMap.has(taskId)).toBe(false);
  });

  test("task.failed with an AgentSession posts ONE error activity with the plain reason", async () => {
    const taskId = "outbound-session-failed";
    await createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: taskId,
      externalId: "LIN-OUT-SESSION-FAILED",
      syncDirection: "bidirectional",
    });
    taskSessionMap.set(taskId, "session-failed");

    workflowEventBus.emit("task.failed", { taskId, failureReason: "tsc:check failed" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockEndAgentSession).toHaveBeenCalledTimes(1);
    expect(mockEndAgentSession.mock.calls[0] as unknown[]).toEqual([
      "session-failed",
      "Task failed.\n\ntsc:check failed",
      "error",
    ]);
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  test("task.completed with no output still ends the session with a short body", async () => {
    const taskId = "outbound-session-empty";
    await createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: taskId,
      externalId: "LIN-OUT-SESSION-EMPTY",
      syncDirection: "bidirectional",
    });
    taskSessionMap.set(taskId, "session-empty");

    workflowEventBus.emit("task.completed", { taskId, output: "  " });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockEndAgentSession.mock.calls[0] as unknown[]).toEqual([
      "session-empty",
      "Task completed.",
      "response",
    ]);
  });

  describe("formatLinearOutcomeBody", () => {
    const savedDashboard = process.env.SWARM_DASHBOARD_URL;
    const savedApp = process.env.APP_URL;

    afterEach(() => {
      if (savedDashboard === undefined) delete process.env.SWARM_DASHBOARD_URL;
      else process.env.SWARM_DASHBOARD_URL = savedDashboard;
      if (savedApp === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = savedApp;
    });

    test("returns text at the cap unchanged", () => {
      const text = "a".repeat(LINEAR_BODY_MAX);
      expect(formatLinearOutcomeBody(text, "t1")).toBe(text);
    });

    test("caps oversized text with a visible note linking the swarm task", () => {
      delete process.env.SWARM_DASHBOARD_URL;
      process.env.APP_URL = "https://swarm.example.com/";
      const text = "b".repeat(LINEAR_BODY_MAX + 500);

      const body = formatLinearOutcomeBody(text, "task-123");

      expect(body.length).toBeLessThanOrEqual(LINEAR_BODY_MAX);
      expect(body.startsWith("b".repeat(1000))).toBe(true);
      expect(body).toContain(`of ${text.length} characters`);
      expect(body.endsWith("Full text: https://swarm.example.com/tasks/task-123_")).toBe(true);
      expect(body).not.toContain("+++");
    });

    test("names the task id when no dashboard URL is configured", () => {
      delete process.env.SWARM_DASHBOARD_URL;
      delete process.env.APP_URL;

      const body = formatLinearOutcomeBody("c".repeat(LINEAR_BODY_MAX + 1), "task-456");

      expect(body.length).toBeLessThanOrEqual(LINEAR_BODY_MAX);
      expect(body.endsWith("Full text: swarm task `task-456`_")).toBe(true);
    });
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
    const sync = await createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: "outbound-task-loop",
      externalId: "LIN-OUT-LOOP",
      syncDirection: "bidirectional",
    });

    // Simulate a recent external sync
    await updateTrackerSync(sync.id, {
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
    const sync = await createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: "outbound-task-old-external",
      externalId: "LIN-OUT-OLD",
      syncDirection: "bidirectional",
    });

    // Set a lastSyncedAt well in the past (10 seconds ago)
    await updateTrackerSync(sync.id, {
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
    const sync = await createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: "outbound-task-swarm-origin",
      externalId: "LIN-OUT-SWARM",
      syncDirection: "bidirectional",
    });

    await updateTrackerSync(sync.id, {
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

  test("task.progress posts an action activity with both action AND parameter when sessionId is mapped", async () => {
    const taskId = "outbound-task-progress";
    taskSessionMap.set(taskId, "linear-session-123");

    workflowEventBus.emit("task.progress", {
      taskId,
      progress: "📋 Reviewing task details",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Posts as `action` so the update renders as a structured card in Linear's AgentSession
    // panel. Linear's spec requires BOTH `action` AND `parameter` for action-type activities;
    // the original bug was calling postAgentSessionAction with only a single string (parameter
    // undefined), which Linear silently rejected.
    expect(mockPostAgentSessionAction).toHaveBeenCalledTimes(1);
    expect(mockPostAgentSessionThought).not.toHaveBeenCalled();

    const args = mockPostAgentSessionAction.mock.calls[0] as unknown[];
    expect(args[0]).toBe("linear-session-123");
    // Both action label and parameter must be present and non-empty
    expect(typeof args[1]).toBe("string");
    expect((args[1] as string).length).toBeGreaterThan(0);
    expect(typeof args[2]).toBe("string");
    expect((args[2] as string).length).toBeGreaterThan(0);
    // Parameter carries the actual progress text
    expect(args[2] as string).toBe("📋 Reviewing task details");
  });

  test("task.progress slices long progress strings into the parameter (cap at 2000)", async () => {
    const taskId = "outbound-task-progress-long";
    taskSessionMap.set(taskId, "linear-session-long");

    const longProgress = "x".repeat(5000);
    workflowEventBus.emit("task.progress", { taskId, progress: longProgress });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockPostAgentSessionAction).toHaveBeenCalledTimes(1);
    const args = mockPostAgentSessionAction.mock.calls[0] as unknown[];
    expect((args[2] as string).length).toBe(2000);
  });

  test("task.progress is a no-op when no sessionId is mapped for the task", async () => {
    workflowEventBus.emit("task.progress", {
      taskId: "outbound-task-progress-no-session",
      progress: "should be dropped",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockPostAgentSessionThought).not.toHaveBeenCalled();
    expect(mockPostAgentSessionAction).not.toHaveBeenCalled();
  });

  test("task.progress is a no-op when progress string is missing", async () => {
    taskSessionMap.set("outbound-task-progress-empty", "linear-session-empty");

    workflowEventBus.emit("task.progress", {
      taskId: "outbound-task-progress-empty",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockPostAgentSessionThought).not.toHaveBeenCalled();
    expect(mockPostAgentSessionAction).not.toHaveBeenCalled();
  });

  test("task.created for Linear-sourced tasks still posts an action activity (with parameter)", async () => {
    const taskId = "outbound-task-created-linear";
    taskSessionMap.set(taskId, "linear-session-created");

    workflowEventBus.emit("task.created", {
      taskId,
      source: "linear",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockPostAgentSessionAction).toHaveBeenCalledTimes(1);
    expect(mockPostAgentSessionThought).not.toHaveBeenCalled();

    const args = mockPostAgentSessionAction.mock.calls[0] as unknown[];
    expect(args[0]).toBe("linear-session-created");
    expect(args[1]).toBe("Processing");
    // parameter (3rd positional arg) must be present for `action` activities to be valid
    expect(typeof args[2]).toBe("string");
    expect(args[2] as string).toContain(taskId);
  });

  test("teardown removes event listeners", async () => {
    teardownLinearOutboundSync();

    await createTrackerSync({
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
