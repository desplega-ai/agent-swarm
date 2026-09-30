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
  getChildTasks,
  getDbClient,
  getTaskById,
  initDb,
  startTask,
  updateTaskProgress,
} from "../be/db";
import { codeLevelTriage, setBeforeHeartbeatReclaimForTests } from "../heartbeat/heartbeat";

const TEST_DB_PATH = "./test-heartbeat-stall-cas.sqlite";

async function backdateTask(taskId: string, isoTime: string): Promise<void> {
  await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
    isoTime,
    taskId,
  ]);
}

describe("Heartbeat stall classifier CAS (TLA+ counterexample)", () => {
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
    setBeforeHeartbeatReclaimForTests(null);
    const db = getDbClient();
    await db.run("DELETE FROM agent_tasks");
    await db.run("DELETE FROM agents");
    await db.run("DELETE FROM active_sessions");
  });

  // Trace: PollStart -> Age -> HbRead -> Progress -> HbWrite (NoLiveKill).
  // HbWrite is now Reclaim; its WHERE re-checks the lastUpdatedAt it read.
  test("stall classifier does not supersede a task that made progress after the candidate read", async () => {
    const agent = await createAgent({ name: "quiet-worker", isLead: false, status: "busy" });
    const task = await createTaskExtended("Long quiet work", { agentId: agent.id });
    await startTask(task.id);
    await backdateTask(task.id, new Date(Date.now() - 10 * 60 * 1000).toISOString());

    // The worker reports progress after the sweep read the candidate list.
    setBeforeHeartbeatReclaimForTests(async (candidate) => {
      await updateTaskProgress(candidate.id, "still working");
    });

    await codeLevelTriage();

    expect((await getTaskById(task.id))?.status).toBe("in_progress");
    expect((await getTaskById(task.id))?.attempt).toBe(0);
    expect(await getChildTasks(task.id)).toHaveLength(0);
  });
});
