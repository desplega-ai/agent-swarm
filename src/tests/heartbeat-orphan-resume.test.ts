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
  supersedeTask,
} from "../be/db";
import {
  codeLevelTriage,
  runRebootSweep,
  setBeforeHeartbeatSupersedeForTests,
} from "../heartbeat/heartbeat";

const TEST_DB_PATH = "./test-heartbeat-orphan-resume.sqlite";

describe("Heartbeat orphaned supersede repair (TLA+ counterexample)", () => {
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

  // Trace: PollStart -> Age -> HbRead -> HbWrite -> ApiCrash -> ApiBoot (SupersededGetsResume).
  test("a task superseded without a resume (crash before resume creation) gets a resume on the next sweep", async () => {
    const agent = await createAgent({ name: "crashed-worker", isLead: false, status: "idle" });
    const task = await createTaskExtended("Work interrupted mid-recovery", { agentId: agent.id });
    await startTask(task.id);

    // State the API process leaves behind if it dies between supersedeTask
    // and createResumeFollowUp in remediateCrashedWorkerTask.
    await supersedeTask(task.id, {
      reason: "Auto-superseded by heartbeat: worker session not found (no active session for task)",
      resumeTaskId: null,
    });
    await getDbClient().run("UPDATE agent_tasks SET finishedAt = ? WHERE id = ?", [
      new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      task.id,
    ]);

    // Restarted API: boot sweep, then a regular sweep.
    await runRebootSweep();
    await codeLevelTriage();

    expect((await getTaskById(task.id))?.status).toBe("superseded");
    expect(await getChildTasks(task.id)).toHaveLength(1);
  });
});
