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
 * zero, negative or non-finite value through `Number(value) || default`. A threshold
 * <= 0 makes `taskAgeMs >= threshold * 60_000` true for every task, so the first sweep
 * superseded a task seconds after it started.
 *
 * These branches are unreachable black-box: the values enter only through the
 * deployment environment (`swarm_config`'s guard rejects a non-positive or fractional
 * value, and the E2E runner fixes the SUT env at boot). That is the reason carried by
 * this file's line in `scripts/unit-test-allowlist.txt`. The cases drive the public
 * `codeLevelTriage()` instead of exporting the parsers.
 */

const TEST_DB_PATH = "./test-heartbeat-stall-threshold.sqlite";

const ORIGINAL_ENV = {
  HEARTBEAT_STALL_NO_SESSION_MIN: process.env.HEARTBEAT_STALL_NO_SESSION_MIN,
  HEARTBEAT_STALL_STALE_HB_MIN: process.env.HEARTBEAT_STALL_STALE_HB_MIN,
};

const INVALID_VALUES = ["0", "-1", "-0.5", "abc", "NaN", "Infinity"];

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

/** The sweep leaves every one of these tasks in_progress and reports nothing. */
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
    for (const raw of INVALID_VALUES) {
      test(`falls back to the 5-minute default when set to ${raw}`, async () => {
        process.env.HEARTBEAT_STALL_NO_SESSION_MIN = raw;
        // One minute old with no active session: inside the documented 5-minute window.
        const recent = await startedTask(1);

        await expectNoStall(recent);
      });
    }

    test("keeps a fractional threshold instead of falling back", async () => {
      process.env.HEARTBEAT_STALL_NO_SESSION_MIN = "0.5";
      // 12 s old: inside 0.5 min, so the sweep never sees it as a candidate.
      const recent = await startedTask(0.2);
      // 2 min old: past 0.5 min (and spared by the 5-minute default this fix restores).
      const stalled = await startedTask(2);

      const findings = await codeLevelTriage();

      expect(findings.autoResumedTasks.map((resume) => resume.taskId)).toEqual([stalled.taskId]);
      expect(findings.autoResumedTasks[0]!.reason).toContain("no active session");
      expect((await getTaskById(stalled.taskId))?.status).toBe("superseded");
      expect((await getTaskById(recent.taskId))?.status).toBe("in_progress");
    });
  });

  describe("HEARTBEAT_STALL_STALE_HB_MIN", () => {
    for (const raw of INVALID_VALUES) {
      test(`falls back to the 15-minute default when set to ${raw}`, async () => {
        process.env.HEARTBEAT_STALL_STALE_HB_MIN = raw;
        // Six minutes old: past the 5-minute candidate scan and inside the 30-minute
        // fresh-stalled threshold, with a one-minute-old heartbeat that is fresh.
        const recent = await startedTask(6);
        await withSessionHeartbeat(recent, 1);

        await expectNoStall(recent);
      });
    }

    test("keeps a fractional threshold instead of falling back", async () => {
      process.env.HEARTBEAT_STALL_STALE_HB_MIN = "0.5";
      // A one-minute-old heartbeat is stale at 0.5 min, so this 6-minute-old task is
      // past both halves of the threshold. The 15-minute default would spare it.
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
