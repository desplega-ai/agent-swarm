import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  cancelTask,
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  failTask,
  getDb,
  getLogsByTaskId,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";

const TEST_DB_PATH = "./test-task-completion-idempotency.sqlite";

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(() => {
  closeDb();
  try {
    unlinkSync(TEST_DB_PATH);
    unlinkSync(`${TEST_DB_PATH}-wal`);
    unlinkSync(`${TEST_DB_PATH}-shm`);
  } catch {
    // ignore
  }
});

describe("completeTask idempotency", () => {
  test("first call wins; second call on already-completed task returns null", () => {
    const agent = createAgent({
      name: "idempotency-worker-1",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = createTaskExtended("Task A", { agentId: agent.id });
    startTask(task.id, agent.id);

    const first = completeTask(task.id, "first output");
    expect(first).not.toBeNull();
    expect(first!.status).toBe("completed");
    expect(first!.output).toBe("first output");
    const firstFinishedAt = first!.finishedAt;
    expect(firstFinishedAt).toBeTruthy();

    // Second call should be a no-op and return null
    const second = completeTask(task.id, "second output");
    expect(second).toBeNull();

    // First-call-wins: original output and finishedAt preserved
    const fresh = getTaskById(task.id);
    expect(fresh!.status).toBe("completed");
    expect(fresh!.output).toBe("first output");
    expect(fresh!.finishedAt).toBe(firstFinishedAt);
  });

  test("does not re-emit task_status_change log on duplicate completion", () => {
    const agent = createAgent({
      name: "idempotency-worker-2",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = createTaskExtended("Task B", { agentId: agent.id });
    startTask(task.id, agent.id);

    completeTask(task.id, "done");
    const logsAfterFirst = getLogsByTaskId(task.id);
    const completedLogsAfterFirst = logsAfterFirst.filter(
      (l) => l.eventType === "task_status_change" && l.newValue === "completed",
    );
    expect(completedLogsAfterFirst.length).toBe(1);

    // Second completion should not log another status-change row
    completeTask(task.id, "done again");
    const logsAfterSecond = getLogsByTaskId(task.id);
    const completedLogsAfterSecond = logsAfterSecond.filter(
      (l) => l.eventType === "task_status_change" && l.newValue === "completed",
    );
    expect(completedLogsAfterSecond.length).toBe(1);
  });

  test("returns null when called on a failed task (cross-terminal)", () => {
    const agent = createAgent({
      name: "idempotency-worker-3",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = createTaskExtended("Task C", { agentId: agent.id });
    startTask(task.id, agent.id);
    failTask(task.id, "boom");

    const result = completeTask(task.id, "trying to complete a failed task");
    expect(result).toBeNull();

    // Original failed status preserved
    const fresh = getTaskById(task.id);
    expect(fresh!.status).toBe("failed");
    expect(fresh!.failureReason).toBe("boom");
  });

  test("returns null when called on a cancelled task", () => {
    const agent = createAgent({
      name: "idempotency-worker-4",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = createTaskExtended("Task D", { agentId: agent.id });
    startTask(task.id, agent.id);
    cancelTask(task.id, "user cancelled");

    const result = completeTask(task.id, "trying to complete a cancelled task");
    expect(result).toBeNull();

    const fresh = getTaskById(task.id);
    expect(fresh!.status).toBe("cancelled");
  });

  test("returns null for non-existent task", () => {
    const result = completeTask("00000000-0000-0000-0000-000000000000", "x");
    expect(result).toBeNull();
  });
});

describe("failTask idempotency", () => {
  test("first call wins; second call on already-failed task returns null", () => {
    const agent = createAgent({
      name: "fail-idempotency-1",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = createTaskExtended("Fail Task A", { agentId: agent.id });
    startTask(task.id, agent.id);

    const first = failTask(task.id, "original reason");
    expect(first).not.toBeNull();
    expect(first!.status).toBe("failed");
    expect(first!.failureReason).toBe("original reason");
    const firstFinishedAt = first!.finishedAt;
    expect(firstFinishedAt).toBeTruthy();

    const second = failTask(task.id, "second reason");
    expect(second).toBeNull();

    const fresh = getTaskById(task.id);
    expect(fresh!.status).toBe("failed");
    expect(fresh!.failureReason).toBe("original reason");
    expect(fresh!.finishedAt).toBe(firstFinishedAt);
  });

  test("does not re-emit task_status_change log on duplicate failure", () => {
    const agent = createAgent({
      name: "fail-idempotency-2",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = createTaskExtended("Fail Task B", { agentId: agent.id });
    startTask(task.id, agent.id);

    failTask(task.id, "boom");
    const logsAfterFirst = getLogsByTaskId(task.id);
    const failedLogsAfterFirst = logsAfterFirst.filter(
      (l) => l.eventType === "task_status_change" && l.newValue === "failed",
    );
    expect(failedLogsAfterFirst.length).toBe(1);

    failTask(task.id, "boom again");
    const logsAfterSecond = getLogsByTaskId(task.id);
    const failedLogsAfterSecond = logsAfterSecond.filter(
      (l) => l.eventType === "task_status_change" && l.newValue === "failed",
    );
    expect(failedLogsAfterSecond.length).toBe(1);
  });

  test("returns null when called on a completed task", () => {
    const agent = createAgent({
      name: "fail-idempotency-3",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = createTaskExtended("Fail Task C", { agentId: agent.id });
    startTask(task.id, agent.id);
    completeTask(task.id, "all good");

    const result = failTask(task.id, "now fail it");
    expect(result).toBeNull();

    const fresh = getTaskById(task.id);
    expect(fresh!.status).toBe("completed");
    expect(fresh!.output).toBe("all good");
  });

  test("returns null when called on a cancelled task", () => {
    const agent = createAgent({
      name: "fail-idempotency-4",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = createTaskExtended("Fail Task D", { agentId: agent.id });
    startTask(task.id, agent.id);
    cancelTask(task.id, "user cancelled");

    const result = failTask(task.id, "now fail it");
    expect(result).toBeNull();

    const fresh = getTaskById(task.id);
    expect(fresh!.status).toBe("cancelled");
  });

  test("returns null for non-existent task", () => {
    const result = failTask("00000000-0000-0000-0000-000000000000", "x");
    expect(result).toBeNull();
  });
});

describe("store-progress idempotency on terminal status (integration via DB layer)", () => {
  // The store-progress MCP tool short-circuits on terminal status before any
  // side-effects (event emission, memory write, follow-up task, BU ensure).
  // The implementation reuses the same DB-layer guards (completeTask/failTask
  // returning null on terminal state), so these tests verify the underlying
  // contract that store-progress relies on.

  test("completing an already-completed task is a no-op at the DB layer", () => {
    const agent = createAgent({
      name: "sp-idempotency-1",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = createTaskExtended("SP Task A", { agentId: agent.id });
    startTask(task.id, agent.id);
    completeTask(task.id, "first output");

    // Snapshot the row state
    const snapshot = getTaskById(task.id);
    const snapshotLogs = getLogsByTaskId(task.id).length;

    // Simulate store-progress(status="completed") on a terminal task.
    // The store-progress tool's short-circuit returns wasNoOp=true and
    // skips completeTask entirely. Even if we were to call completeTask
    // directly (defense in depth), the row stays unchanged.
    const result = completeTask(task.id, "second output");
    expect(result).toBeNull();

    const after = getTaskById(task.id);
    expect(after!.output).toBe(snapshot!.output);
    expect(after!.finishedAt).toBe(snapshot!.finishedAt);
    expect(after!.status).toBe(snapshot!.status);
    expect(getLogsByTaskId(task.id).length).toBe(snapshotLogs);
  });

  test("failing an already-failed task is a no-op at the DB layer", () => {
    const agent = createAgent({
      name: "sp-idempotency-2",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = createTaskExtended("SP Task B", { agentId: agent.id });
    startTask(task.id, agent.id);
    failTask(task.id, "first reason");

    const snapshot = getTaskById(task.id);
    const snapshotLogs = getLogsByTaskId(task.id).length;

    const result = failTask(task.id, "second reason");
    expect(result).toBeNull();

    const after = getTaskById(task.id);
    expect(after!.failureReason).toBe(snapshot!.failureReason);
    expect(after!.finishedAt).toBe(snapshot!.finishedAt);
    expect(after!.status).toBe(snapshot!.status);
    expect(getLogsByTaskId(task.id).length).toBe(snapshotLogs);
  });

  test("completing a task manually marked terminal returns null", () => {
    // Belt-and-suspenders: even if the row was written outside the normal
    // code path (e.g. direct UPDATE), the guard catches it.
    const agent = createAgent({
      name: "sp-idempotency-3",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = createTaskExtended("SP Task C", { agentId: agent.id });
    getDb().run(
      "UPDATE agent_tasks SET status = 'completed', output = 'manually written', finishedAt = ? WHERE id = ?",
      [new Date().toISOString(), task.id],
    );

    const result = completeTask(task.id, "tried to overwrite");
    expect(result).toBeNull();

    const after = getTaskById(task.id);
    expect(after!.output).toBe("manually written");
  });
});
