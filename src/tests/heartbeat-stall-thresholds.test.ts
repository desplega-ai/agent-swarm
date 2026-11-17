import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDbClient,
  getTaskById,
  initDb,
  insertActiveSession,
  startTask,
} from "../be/db";
import { codeLevelTriage } from "../heartbeat/heartbeat";

/**
 * #3170: `HEARTBEAT_STALL_NO_SESSION_MIN` and `HEARTBEAT_STALL_STALE_HB_MIN` kept a
 * non-positive or non-finite value through `Number(value) || default`, and a
 * threshold <= 0 makes `taskAgeMs >= threshold * 60_000` true for every task, so the
 * first sweep auto-superseded a task seconds after it started.
 *
 * These branches are unreachable black-box: the values arrive only through the
 * deployment environment (`swarm_config`'s guard already rejects them, and the E2E
 * runner fixes the SUT env at boot). That is the reason carried by this file's line
 * in `scripts/unit-test-allowlist.txt`; the cases drive the public
 * `codeLevelTriage()` rather than exporting the parsers.
 */

const TEST_DB_PATH = "./test-heartbeat-stall-thresholds.sqlite";

const ORIGINAL_ENV = {
  HEARTBEAT_STALL_NO_SESSION_MIN: process.env.HEARTBEAT_STALL_NO_SESSION_MIN,
  HEARTBEAT_STALL_STALE_HB_MIN: process.env.HEARTBEAT_STALL_STALE_HB_MIN,
};

type StartedTask = { taskId: string; agentId: string };

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

/** A busy worker with one in_progress task whose last update is `ageMin` minutes old. */
async function startedTask(ageMin: number): Promise<StartedTask> {
  const agent = await createAgent({
    name: "stall-threshold-worker",
    isLead: false,
    status: "busy",
  });
  const task = await createTaskExtended(`Task last updated ${ageMin} min ago`, {
    agentId: agent.id,
  });
  await startTask(task.id);
  await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
    minutesAgo(ageMin),
    task.id,
  ]);
  return { taskId: task.id, agentId: agent.id };
}

/** Attach an active session whose heartbeat is `ageMin` minutes old. */
async function withSessionHeartbeat(
  { taskId, agentId }: StartedTask,
  ageMin: number,
): Promise<void> {
  await insertActiveSession({ agentId, taskId, triggerType: "task_assigned" });
  await getDbClient().run("UPDATE active_sessions SET lastHeartbeatAt = ? WHERE taskId = ?", [
    minutesAgo(ageMin),
    taskId,
  ]);
}

async function expectNoStall(...tasks: StartedTask[]): Promise<void> {
  const findings = await codeLevelTriage();
  expect(findings.stalledTasks).toEqual([]);
  expect(findings.autoResumedTasks).toEqual([]);
  expect(findings.autoFailedTasks).toEqual([]);
  for (const { taskId } of tasks) {
    expect((await getTaskById(taskId))?.status).toBe("in_progress");
  }
}

describe("Heartbeat stall thresholds (#3170)", () => {
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
    try {
      await unlink(TEST_DB_PATH);
      await unlink(`${TEST_DB_PATH}-wal`);
      await unlink(`${TEST_DB_PATH}-shm`);
    } catch {
      // Files may not exist
    }
  });

  beforeEach(async () => {
    await getDbClient().run("DELETE FROM agent_tasks");
    await getDbClient().run("DELETE FROM agents");
    await getDbClient().run("DELETE FROM active_sessions");
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe("HEARTBEAT_STALL_NO_SESSION_MIN", () => {
    for (const raw of ["-1", "0", "NaN", "Infinity", "-Infinity"]) {
      test(`falls back to 5 minutes when set to ${raw}`, async () => {
        process.env.HEARTBEAT_STALL_NO_SESSION_MIN = raw;
        // One minute old, no active session: well inside the documented 5-minute window.
        const recent = await startedTask(1);

        await expectNoStall(recent);
      });
    }

    test("keeps a fractional threshold", async () => {
      process.env.HEARTBEAT_STALL_NO_SESSION_MIN = "0.5";
      // 12 s old: inside 0.5 min, and below the candidate scan's 30 s cutoff.
      const recent = await startedTask(0.2);
      // 2 min old: past 0.5 min (and spared by the 5-minute default this PR restores).
      const stalled = await startedTask(2);

      const findings = await codeLevelTriage();

      expect(findings.autoResumedTasks.map((resume) => resume.taskId)).toEqual([stalled.taskId]);
      expect(findings.autoResumedTasks[0]!.reason).toContain("no active session");
      expect((await getTaskById(stalled.taskId))?.status).toBe("superseded");
      expect((await getTaskById(recent.taskId))?.status).toBe("in_progress");
    });
  });

  describe("HEARTBEAT_STALL_STALE_HB_MIN", () => {
    for (const raw of ["-1", "0", "NaN", "Infinity", "-Infinity"]) {
      test(`falls back to 15 minutes when set to ${raw}`, async () => {
        process.env.HEARTBEAT_STALL_STALE_HB_MIN = raw;
        // Six minutes old: past the 5-minute candidate scan, inside the 30-minute
        // fresh-stalled threshold, and its one-minute-old heartbeat is fresh.
        const recent = await startedTask(6);
        await withSessionHeartbeat(recent, 1);

        await expectNoStall(recent);
      });
    }

    test("keeps a fractional threshold", async () => {
      process.env.HEARTBEAT_STALL_STALE_HB_MIN = "0.5";
      // A one-minute-old heartbeat is stale at 0.5 min, so a 6-minute-old task is past
      // both halves of the threshold. The 15-minute default spares it.
      const crashed = await startedTask(6);
      await withSessionHeartbeat(crashed, 1);
      // A 6 s heartbeat stays fresh at any threshold.
      const alive = await startedTask(6);
      await withSessionHeartbeat(alive, 0.1);

      const findings = await codeLevelTriage();

      expect(findings.autoResumedTasks.map((resume) => resume.taskId)).toEqual([crashed.taskId]);
      expect(findings.autoResumedTasks[0]!.reason).toContain("stale");
      expect((await getTaskById(crashed.taskId))?.status).toBe("superseded");
      expect((await getTaskById(alive.taskId))?.status).toBe("in_progress");
    });
  });
});
