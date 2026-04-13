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
  test("updates taskId on session logs matching the runnerSessionId", () => {
    const runnerSessionId = "runner-sess-1";
    const randomUuid = crypto.randomUUID();
    const realTaskId = crypto.randomUUID();

    // Insert session logs under random UUID
    createSessionLogs({
      taskId: randomUuid,
      sessionId: runnerSessionId,
      iteration: 1,
      cli: "claude",
      lines: ["log line 1", "log line 2", "log line 3"],
    });

    // Verify logs exist under random UUID
    const beforeLogs = getSessionLogsByTaskId(randomUuid);
    expect(beforeLogs.length).toBe(3);

    // Reassociate
    const count = reassociateSessionLogs(runnerSessionId, realTaskId);
    expect(count).toBe(3);

    // Verify logs now exist under real task ID
    const afterLogs = getSessionLogsByTaskId(realTaskId);
    expect(afterLogs.length).toBe(3);

    // Verify no logs remain under random UUID
    const oldLogs = getSessionLogsByTaskId(randomUuid);
    expect(oldLogs.length).toBe(0);
  });

  test("is idempotent — second call returns 0 changes", () => {
    const runnerSessionId = "runner-sess-2";
    const randomUuid = crypto.randomUUID();
    const realTaskId = crypto.randomUUID();

    createSessionLogs({
      taskId: randomUuid,
      sessionId: runnerSessionId,
      iteration: 1,
      cli: "claude",
      lines: ["line a"],
    });

    const first = reassociateSessionLogs(runnerSessionId, realTaskId);
    expect(first).toBe(1);

    const second = reassociateSessionLogs(runnerSessionId, realTaskId);
    expect(second).toBe(0);
  });

  test("does not affect logs from other sessions", () => {
    const runnerSessionId = "runner-sess-3";
    const otherSessionId = "runner-sess-other";
    const randomUuid = crypto.randomUUID();
    const otherTaskId = crypto.randomUUID();
    const realTaskId = crypto.randomUUID();

    // Insert logs for our session
    createSessionLogs({
      taskId: randomUuid,
      sessionId: runnerSessionId,
      iteration: 1,
      cli: "claude",
      lines: ["our log"],
    });

    // Insert logs for a different session
    createSessionLogs({
      taskId: otherTaskId,
      sessionId: otherSessionId,
      iteration: 1,
      cli: "claude",
      lines: ["other log"],
    });

    // Reassociate only our session
    reassociateSessionLogs(runnerSessionId, realTaskId);

    // Other session's logs should be unchanged
    const otherLogs = getSessionLogsByTaskId(otherTaskId);
    expect(otherLogs.length).toBe(1);
    expect(otherLogs[0]?.sessionId).toBe(otherSessionId);
  });
});

describe("pool task claim flow", () => {
  test("active session stores runnerSessionId", () => {
    const agentId = crypto.randomUUID();
    createAgent({ id: agentId, name: "Pool Test Agent", isLead: false, status: "idle" });

    const session = insertActiveSession({
      agentId,
      taskId: "effective-task-id",
      triggerType: "pool_tasks_available",
      runnerSessionId: "runner-sess-4",
    });

    expect(session.runnerSessionId).toBe("runner-sess-4");

    // Verify it can be retrieved
    const sessions = getActiveSessions(agentId);
    const found = sessions.find((s) => s.runnerSessionId === "runner-sess-4");
    expect(found).toBeDefined();
  });

  test("end-to-end: pool task logs are reassociated after claim", () => {
    const agentId = crypto.randomUUID();
    const runnerSessionId = "runner-sess-e2e";
    const effectiveTaskId = crypto.randomUUID();
    createAgent({ id: agentId, name: "E2E Pool Agent", isLead: false, status: "idle" });

    // 1. Create an unassigned task (pool task)
    const task = createTaskExtended("Test pool task", {
      source: "api",
    });
    expect(task.agentId).toBeNull();

    // 2. Simulate runner creating active session with runnerSessionId
    insertActiveSession({
      agentId,
      taskId: effectiveTaskId,
      triggerType: "pool_tasks_available",
      runnerSessionId,
    });

    // 3. Simulate session logs being flushed with the random effectiveTaskId
    createSessionLogs({
      taskId: effectiveTaskId,
      sessionId: runnerSessionId,
      iteration: 1,
      cli: "claude",
      lines: ["Starting work...", "Calling poll-task...", "Found a task to claim"],
    });

    // 4. Verify logs are NOT under the real task ID yet
    const beforeClaim = getSessionLogsByTaskId(task.id);
    expect(beforeClaim.length).toBe(0);

    // 5. Simulate what task-action claim does: reassociate logs
    const sessions = getActiveSessions(agentId);
    const activeSession = sessions.find((s) => s.runnerSessionId);
    expect(activeSession?.runnerSessionId).toBe(runnerSessionId);

    const count = reassociateSessionLogs(runnerSessionId, task.id);
    expect(count).toBe(3);

    // 6. Verify logs now appear under the real task ID
    const afterClaim = getSessionLogsByTaskId(task.id);
    expect(afterClaim.length).toBe(3);

    // 7. Simulate more logs arriving after claim (with old effectiveTaskId)
    //    These would be caught by store-progress reinforcement
    createSessionLogs({
      taskId: effectiveTaskId,
      sessionId: runnerSessionId,
      iteration: 1,
      cli: "claude",
      lines: ["Working on the task now..."],
    });

    // 8. Reinforce reassociation (like store-progress would)
    const reinforceCount = reassociateSessionLogs(runnerSessionId, task.id);
    expect(reinforceCount).toBe(1);

    // 9. All logs should now be under the real task ID
    const allLogs = getSessionLogsByTaskId(task.id);
    expect(allLogs.length).toBe(4);
  });
});
