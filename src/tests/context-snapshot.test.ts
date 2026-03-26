import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createContextSnapshot,
  createTaskExtended,
  getContextSnapshotsByTaskId,
  getContextSummaryByTaskId,
  initDb,
} from "../be/db";

const TEST_DB_PATH = "./test-context-snapshot.sqlite";

describe("Context Snapshots", () => {
  const agentId = "aaaa0000-0000-4000-8000-000000000001";
  const sessionId = "sess-001";
  let taskId: string;

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {
        // File doesn't exist
      }
    }

    initDb(TEST_DB_PATH);
    createAgent({ id: agentId, name: "Test Worker", isLead: false, status: "idle" });
    const task = createTaskExtended("Test task for context snapshots", {
      agentId,
      source: "mcp",
    });
    taskId = task.id;
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {
        // ignore
      }
    }
  });

  test("completion snapshot without contextUsedTokens preserves last known usage", () => {
    // Simulate progress snapshots during task execution
    createContextSnapshot({
      taskId,
      agentId,
      sessionId,
      eventType: "progress",
      contextUsedTokens: 50000,
      contextTotalTokens: 200000,
      contextPercent: 25,
    });

    createContextSnapshot({
      taskId,
      agentId,
      sessionId,
      eventType: "progress",
      contextUsedTokens: 80000,
      contextTotalTokens: 200000,
      contextPercent: 40,
    });

    // Simulate completion snapshot — runner doesn't have contextUsedTokens at session end
    createContextSnapshot({
      taskId,
      agentId,
      sessionId,
      eventType: "completion",
      // No contextUsedTokens or contextPercent — this is the bug scenario
      contextTotalTokens: 200000,
      cumulativeInputTokens: 100000,
      cumulativeOutputTokens: 20000,
    });

    // The summary should preserve the last known context usage, not null/0
    const summary = getContextSummaryByTaskId(taskId);
    expect(summary.totalContextTokensUsed).toBe(80000);
    expect(summary.contextWindowSize).toBe(200000);
    expect(summary.peakContextPercent).toBe(40);
  });

  test("completion snapshot with contextUsedTokens uses provided value", () => {
    // Create a second task for an isolated test
    const task2 = createTaskExtended("Test task 2", { agentId, source: "mcp" });

    createContextSnapshot({
      taskId: task2.id,
      agentId,
      sessionId,
      eventType: "progress",
      contextUsedTokens: 50000,
      contextTotalTokens: 200000,
      contextPercent: 25,
    });

    // Completion with explicit contextUsedTokens should use that value
    createContextSnapshot({
      taskId: task2.id,
      agentId,
      sessionId,
      eventType: "completion",
      contextUsedTokens: 60000,
      contextTotalTokens: 200000,
      contextPercent: 30,
    });

    const summary = getContextSummaryByTaskId(task2.id);
    expect(summary.totalContextTokensUsed).toBe(60000);
    expect(summary.contextWindowSize).toBe(200000);
  });

  test("snapshots are returned in chronological order", () => {
    const snapshots = getContextSnapshotsByTaskId(taskId);
    expect(snapshots.length).toBe(3);
    expect(snapshots[0].eventType).toBe("progress");
    expect(snapshots[1].eventType).toBe("progress");
    expect(snapshots[2].eventType).toBe("completion");
  });
});
