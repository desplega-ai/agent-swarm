/**
 * Stop-hook task-context resolution.
 *
 * Regression for the silent-drop bug PR #444's gate trace surfaced: every Stop
 * hook logged `hasTaskId: false` because TASK_FILE on disk had been cleaned up
 * mid-session, so `Bun.file(taskFile).text()` threw and the catch swallowed it.
 * Fix: prefer the AGENT_SWARM_TASK_ID env var (set by `claude-adapter.ts`) and
 * only fall back to the file. See `resolveStopHookTaskContext` in hook.ts.
 */
import { describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { resolveStopHookTaskContext } from "../hooks/hook";

describe("resolveStopHookTaskContext", () => {
  test("prefers AGENT_SWARM_TASK_ID env var when TASK_FILE is missing on disk", async () => {
    const missingPath = `/tmp/stop-hook-missing-${Date.now()}.json`;
    // Sanity: file must not exist.
    try {
      await unlink(missingPath);
    } catch {}

    const { taskContext, taskId } = await resolveStopHookTaskContext({
      AGENT_SWARM_TASK_ID: "task-from-env-123",
      TASK_FILE: missingPath,
    });

    expect(taskId).toBe("task-from-env-123");
    // taskContext stays empty because the file (which carries the human task
    // text) wasn't readable. That's fine — the LLM rater only needs taskId.
    expect(taskContext).toBe("");
  });

  test("env var alone (no TASK_FILE) still populates taskId", async () => {
    const { taskContext, taskId } = await resolveStopHookTaskContext({
      AGENT_SWARM_TASK_ID: "task-env-only",
    });
    expect(taskId).toBe("task-env-only");
    expect(taskContext).toBe("");
  });

  test("falls back to TASK_FILE.id when env var unset", async () => {
    const path = `/tmp/stop-hook-file-${Date.now()}.json`;
    await Bun.write(path, JSON.stringify({ id: "task-from-file-456", task: "do the thing" }));
    try {
      const { taskContext, taskId } = await resolveStopHookTaskContext({
        TASK_FILE: path,
      });
      expect(taskId).toBe("task-from-file-456");
      expect(taskContext).toBe("Task: do the thing");
    } finally {
      await unlink(path).catch(() => {});
    }
  });

  test("env var wins over TASK_FILE.id but file still seeds taskContext", async () => {
    const path = `/tmp/stop-hook-both-${Date.now()}.json`;
    await Bun.write(path, JSON.stringify({ id: "task-from-file", task: "human task text" }));
    try {
      const { taskContext, taskId } = await resolveStopHookTaskContext({
        AGENT_SWARM_TASK_ID: "task-from-env",
        TASK_FILE: path,
      });
      expect(taskId).toBe("task-from-env");
      expect(taskContext).toBe("Task: human task text");
    } finally {
      await unlink(path).catch(() => {});
    }
  });

  test("missing file with no env var → both undefined/empty (no throw)", async () => {
    const { taskContext, taskId } = await resolveStopHookTaskContext({
      TASK_FILE: `/tmp/stop-hook-nope-${Date.now()}.json`,
    });
    expect(taskId).toBeUndefined();
    expect(taskContext).toBe("");
  });

  test("no env at all → both undefined/empty", async () => {
    const { taskContext, taskId } = await resolveStopHookTaskContext({});
    expect(taskId).toBeUndefined();
    expect(taskContext).toBe("");
  });

  test("malformed TASK_FILE JSON does not throw, env var still wins", async () => {
    const path = `/tmp/stop-hook-bad-${Date.now()}.json`;
    await Bun.write(path, "not json {");
    try {
      const { taskContext, taskId } = await resolveStopHookTaskContext({
        AGENT_SWARM_TASK_ID: "task-env-survives",
        TASK_FILE: path,
      });
      expect(taskId).toBe("task-env-survives");
      expect(taskContext).toBe("");
    } finally {
      await unlink(path).catch(() => {});
    }
  });
});
