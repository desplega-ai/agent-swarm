import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createSessionLogs,
  createTaskExtended,
  getActiveSessions,
  getSessionLogsByTaskId,
  initDb,
  insertActiveSession,
  reassociateSessionLogs,
} from "../be/db";

const TEST_DB_PATH = "./test-pool-session-logs.sqlite";

beforeAll(() => {
  closeDb();
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

describe("reassociateSessionLogs", () => {
  test("updates taskId on session logs matching the runnerSessionId", async () => {
    const runnerSessionId = "runner-sess-1";
    const randomUuid = crypto.randomUUID();
    const realTaskId = crypto.randomUUID();

    // Insert session logs under random UUID
    await createSessionLogs({
      taskId: randomUuid,
      sessionId: runnerSessionId,
      iteration: 1,
      cli: "claude",
      lines: ["log line 1", "log line 2", "log line 3"],
    });

    // Verify logs exist under random UUID
    const beforeLogs = await getSessionLogsByTaskId(randomUuid);
    expect(beforeLogs.length).toBe(3);

    // Reassociate
    const count = await reassociateSessionLogs(runnerSessionId, realTaskId);
    expect(count).toBe(3);

    // Verify logs now exist under real task ID
    const afterLogs = await getSessionLogsByTaskId(realTaskId);
    expect(afterLogs.length).toBe(3);

    // Verify no logs remain under random UUID
    const oldLogs = await getSessionLogsByTaskId(randomUuid);
    expect(oldLogs.length).toBe(0);

    const second = await reassociateSessionLogs(runnerSessionId, realTaskId);
    expect(second).toBe(0);
  });

  test("does not affect logs from other sessions", async () => {
    const runnerSessionId = "runner-sess-3";
    const otherSessionId = "runner-sess-other";
    const randomUuid = crypto.randomUUID();
    const otherTaskId = crypto.randomUUID();
    const realTaskId = crypto.randomUUID();

    // Insert logs for our session
    await createSessionLogs({
      taskId: randomUuid,
      sessionId: runnerSessionId,
      iteration: 1,
      cli: "claude",
      lines: ["our log"],
    });

    // Insert logs for a different session
    await createSessionLogs({
      taskId: otherTaskId,
      sessionId: otherSessionId,
      iteration: 1,
      cli: "claude",
      lines: ["other log"],
    });

    // Reassociate only our session
    await reassociateSessionLogs(runnerSessionId, realTaskId);

    // Other session's logs should be unchanged
    const otherLogs = await getSessionLogsByTaskId(otherTaskId);
    expect(otherLogs.length).toBe(1);
    expect(otherLogs[0]?.sessionId).toBe(otherSessionId);
  });
});

describe("pool task claim flow", () => {
  test("reassociates pool logs through active-session lookup and repeated calls", async () => {
    const agentId = crypto.randomUUID();
    const runnerSessionId = "runner-sess-flow";
    const effectiveTaskId = crypto.randomUUID();
    await createAgent({ id: agentId, name: "Pool Flow Agent", isLead: false, status: "idle" });

    // 1. Create an unassigned task (pool task)
    const task = await createTaskExtended("Test pool task", {
      source: "api",
    });
    expect(task.agentId).toBeNull();

    // 2. Simulate runner creating active session with runnerSessionId
    const session = await insertActiveSession({
      agentId,
      taskId: effectiveTaskId,
      triggerType: "pool_tasks_available",
      runnerSessionId,
    });

    expect(session.runnerSessionId).toBe(runnerSessionId);

    // 3. Simulate session logs being flushed with the random effectiveTaskId
    await createSessionLogs({
      taskId: effectiveTaskId,
      sessionId: runnerSessionId,
      iteration: 1,
      cli: "claude",
      lines: ["Starting work...", "Calling poll-task...", "Found a task to claim"],
    });

    // 4. Verify logs are NOT under the real task ID yet
    const beforeClaim = await getSessionLogsByTaskId(task.id);
    expect(beforeClaim.length).toBe(0);

    // 5. Simulate what task-action claim does: reassociate logs
    const sessions = await getActiveSessions(agentId);
    const activeSession = sessions.find((s) => s.runnerSessionId);
    expect(activeSession?.runnerSessionId).toBe(runnerSessionId);

    const count = await reassociateSessionLogs(runnerSessionId, task.id);
    expect(count).toBe(3);

    // 6. Verify logs now appear under the real task ID
    const afterClaim = await getSessionLogsByTaskId(task.id);
    expect(afterClaim.length).toBe(3);

    // 7. Simulate more logs arriving after claim (with old effectiveTaskId)
    //    A later reassociation call must include these rows.
    await createSessionLogs({
      taskId: effectiveTaskId,
      sessionId: runnerSessionId,
      iteration: 1,
      cli: "claude",
      lines: ["Working on the task now..."],
    });

    // 8. Repeat the database call to include late arrivals.
    const reinforceCount = await reassociateSessionLogs(runnerSessionId, task.id);
    expect(reinforceCount).toBe(1);

    // 9. All logs should now be under the real task ID
    const allLogs = await getSessionLogsByTaskId(task.id);
    expect(allLogs.length).toBe(4);
  });
});
