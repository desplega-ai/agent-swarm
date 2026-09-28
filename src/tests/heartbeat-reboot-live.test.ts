/**
 * Counterexamples from the TLA+ heartbeat model (specs/tla/heartbeat/).
 *
 * Each test replays one TLC trace against a real temp SQLite DB, calling the
 * functions ACTIONS.md maps each trace step to. A test that passes on main
 * means the trace was model drift, not a bug.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getActiveSessionForTask,
  getDbClient,
  getTaskById,
  initDb,
  insertActiveSession,
  startTask,
} from "../be/db";
import { runRebootSweep, setBeforeHeartbeatSupersedeForTests } from "../heartbeat/heartbeat";

const TEST_DB_PATH = "./test-heartbeat-reboot-live.sqlite";

async function backdateTask(taskId: string, isoTime: string): Promise<void> {
  await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
    isoTime,
    taskId,
  ]);
}

describe("Reboot sweep live sessions (TLA+ counterexample)", () => {
  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist
    }
    closeDb();
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    for (const path of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
      try {
        await unlink(path);
      } catch {
        // Files may not exist
      }
    }
  });

  beforeEach(async () => {
    setBeforeHeartbeatSupersedeForTests(null);
    const db = getDbClient();
    await db.run("DELETE FROM agent_tasks");
    await db.run("DELETE FROM agents");
    await db.run("DELETE FROM active_sessions");
  });

  // Trace: PollStart -> RegisterSession -> ApiCrash -> ApiBoot -> RebootFail (NoLiveKill).
  test("reboot sweep does not fail a live worker whose last tool call was shortly before the API restart", async () => {
    const gs = globalThis as typeof globalThis & { __runId?: string };
    const original = gs.__runId;
    const bootTime = Date.now();
    gs.__runId = `run_${bootTime}`;
    try {
      const agent = await createAgent({ name: "live-worker", isLead: false, status: "busy" });
      const task = await createTaskExtended("Long model call", { agentId: agent.id });
      await startTask(task.id);
      await backdateTask(task.id, new Date(bootTime - 60_000).toISOString());

      // Worker container kept running through the API deploy. Its last
      // PostToolUse heartbeat landed 30s before the new API process booted.
      await insertActiveSession({
        agentId: agent.id,
        taskId: task.id,
        triggerType: "task_assigned",
      });
      await getDbClient().run("UPDATE active_sessions SET lastHeartbeatAt = ? WHERE taskId = ?", [
        new Date(bootTime - 30_000).toISOString(),
        task.id,
      ]);

      await runRebootSweep();

      expect((await getTaskById(task.id))?.status).toBe("in_progress");
      expect(await getActiveSessionForTask(task.id)).not.toBeNull();
    } finally {
      gs.__runId = original;
    }
  });
});
