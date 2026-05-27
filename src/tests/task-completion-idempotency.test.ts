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
import { createWorkerTaskFollowUp } from "../tasks/worker-follow-up";

const TEST_DB_PATH = "./test-task-completion-idempotency.sqlite";

beforeAll(async () => {
  await initDb(TEST_DB_PATH);
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
  test("first call wins; second call on already-completed task returns null", async () => {
    const agent = await createAgent({
      name: "idempotency-worker-1",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = await createTaskExtended("Task A", { agentId: agent.id });
    await startTask(task.id, agent.id);

    const first = await completeTask(task.id, "first output");
    expect(first).not.toBeNull();
    expect(first!.status).toBe("completed");
    expect(first!.output).toBe("first output");
    const firstFinishedAt = first!.finishedAt;
    expect(firstFinishedAt).toBeTruthy();

    // Second call should be a no-op and return null
    const second = await completeTask(task.id, "second output");
    expect(second).toBeNull();

    // First-call-wins: original output and finishedAt preserved
    const fresh = await getTaskById(task.id);
    expect(fresh!.status).toBe("completed");
    expect(fresh!.output).toBe("first output");
    expect(fresh!.finishedAt).toBe(firstFinishedAt);
  });

  test("does not re-emit task_status_change log on duplicate completion", async () => {
    const agent = await createAgent({
      name: "idempotency-worker-2",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = await createTaskExtended("Task B", { agentId: agent.id });
    await startTask(task.id, agent.id);

    await completeTask(task.id, "done");
    const logsAfterFirst = await getLogsByTaskId(task.id);
    const completedLogsAfterFirst = logsAfterFirst.filter(
      (l) => l.eventType === "task_status_change" && l.newValue === "completed",
    );
    expect(completedLogsAfterFirst.length).toBe(1);

    // Second completion should not log another status-change row
    await completeTask(task.id, "done again");
    const logsAfterSecond = await getLogsByTaskId(task.id);
    const completedLogsAfterSecond = logsAfterSecond.filter(
      (l) => l.eventType === "task_status_change" && l.newValue === "completed",
    );
    expect(completedLogsAfterSecond.length).toBe(1);
  });

  test("returns null when called on a failed task (cross-terminal)", async () => {
    const agent = await createAgent({
      name: "idempotency-worker-3",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = await createTaskExtended("Task C", { agentId: agent.id });
    await startTask(task.id, agent.id);
    await failTask(task.id, "boom");

    const result = await completeTask(task.id, "trying to complete a failed task");
    expect(result).toBeNull();

    // Original failed status preserved
    const fresh = await getTaskById(task.id);
    expect(fresh!.status).toBe("failed");
    expect(fresh!.failureReason).toBe("boom");
  });

  test("returns null when called on a cancelled task", async () => {
    const agent = await createAgent({
      name: "idempotency-worker-4",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = await createTaskExtended("Task D", { agentId: agent.id });
    await startTask(task.id, agent.id);
    await cancelTask(task.id, "user cancelled");

    const result = await completeTask(task.id, "trying to complete a cancelled task");
    expect(result).toBeNull();

    const fresh = await getTaskById(task.id);
    expect(fresh!.status).toBe("cancelled");
  });

  test("returns null for non-existent task", async () => {
    const result = await completeTask("00000000-0000-0000-0000-000000000000", "x");
    expect(result).toBeNull();
  });
});

describe("failTask idempotency", () => {
  test("first call wins; second call on already-failed task returns null", async () => {
    const agent = await createAgent({
      name: "fail-idempotency-1",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = await createTaskExtended("Fail Task A", { agentId: agent.id });
    await startTask(task.id, agent.id);

    const first = await failTask(task.id, "original reason");
    expect(first).not.toBeNull();
    expect(first!.status).toBe("failed");
    expect(first!.failureReason).toBe("original reason");
    const firstFinishedAt = first!.finishedAt;
    expect(firstFinishedAt).toBeTruthy();

    const second = await failTask(task.id, "second reason");
    expect(second).toBeNull();

    const fresh = await getTaskById(task.id);
    expect(fresh!.status).toBe("failed");
    expect(fresh!.failureReason).toBe("original reason");
    expect(fresh!.finishedAt).toBe(firstFinishedAt);
  });

  test("does not re-emit task_status_change log on duplicate failure", async () => {
    const agent = await createAgent({
      name: "fail-idempotency-2",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = await createTaskExtended("Fail Task B", { agentId: agent.id });
    await startTask(task.id, agent.id);

    await failTask(task.id, "boom");
    const logsAfterFirst = await getLogsByTaskId(task.id);
    const failedLogsAfterFirst = logsAfterFirst.filter(
      (l) => l.eventType === "task_status_change" && l.newValue === "failed",
    );
    expect(failedLogsAfterFirst.length).toBe(1);

    await failTask(task.id, "boom again");
    const logsAfterSecond = await getLogsByTaskId(task.id);
    const failedLogsAfterSecond = logsAfterSecond.filter(
      (l) => l.eventType === "task_status_change" && l.newValue === "failed",
    );
    expect(failedLogsAfterSecond.length).toBe(1);
  });

  test("returns null when called on a completed task", async () => {
    const agent = await createAgent({
      name: "fail-idempotency-3",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = await createTaskExtended("Fail Task C", { agentId: agent.id });
    await startTask(task.id, agent.id);
    await completeTask(task.id, "all good");

    const result = await failTask(task.id, "now fail it");
    expect(result).toBeNull();

    const fresh = await getTaskById(task.id);
    expect(fresh!.status).toBe("completed");
    expect(fresh!.output).toBe("all good");
  });

  test("returns null when called on a cancelled task", async () => {
    const agent = await createAgent({
      name: "fail-idempotency-4",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = await createTaskExtended("Fail Task D", { agentId: agent.id });
    await startTask(task.id, agent.id);
    await cancelTask(task.id, "user cancelled");

    const result = await failTask(task.id, "now fail it");
    expect(result).toBeNull();

    const fresh = await getTaskById(task.id);
    expect(fresh!.status).toBe("cancelled");
  });

  test("returns null for non-existent task", async () => {
    const result = await failTask("00000000-0000-0000-0000-000000000000", "x");
    expect(result).toBeNull();
  });
});

describe("store-progress idempotency on terminal status (integration via DB layer)", () => {
  // The store-progress MCP tool short-circuits on terminal status before any
  // side-effects (event emission, memory write, follow-up task, BU ensure).
  // The implementation reuses the same DB-layer guards (completeTask/failTask
  // returning null on terminal state), so these tests verify the underlying
  // contract that store-progress relies on.

  test("completing an already-completed task is a no-op at the DB layer", async () => {
    const agent = await createAgent({
      name: "sp-idempotency-1",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = await createTaskExtended("SP Task A", { agentId: agent.id });
    await startTask(task.id, agent.id);
    await completeTask(task.id, "first output");

    // Snapshot the row state
    const snapshot = await getTaskById(task.id);
    const snapshotLogs = (await getLogsByTaskId(task.id)).length;

    // Simulate store-progress(status="completed") on a terminal task.
    // The store-progress tool's short-circuit returns wasNoOp=true and
    // skips completeTask entirely. Even if we were to call completeTask
    // directly (defense in depth), the row stays unchanged.
    const result = await completeTask(task.id, "second output");
    expect(result).toBeNull();

    const after = await getTaskById(task.id);
    expect(after!.output).toBe(snapshot!.output);
    expect(after!.finishedAt).toBe(snapshot!.finishedAt);
    expect(after!.status).toBe(snapshot!.status);
    expect((await getLogsByTaskId(task.id)).length).toBe(snapshotLogs);
  });

  test("failing an already-failed task is a no-op at the DB layer", async () => {
    const agent = await createAgent({
      name: "sp-idempotency-2",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = await createTaskExtended("SP Task B", { agentId: agent.id });
    await startTask(task.id, agent.id);
    await failTask(task.id, "first reason");

    const snapshot = await getTaskById(task.id);
    const snapshotLogs = (await getLogsByTaskId(task.id)).length;

    const result = await failTask(task.id, "second reason");
    expect(result).toBeNull();

    const after = await getTaskById(task.id);
    expect(after!.failureReason).toBe(snapshot!.failureReason);
    expect(after!.finishedAt).toBe(snapshot!.finishedAt);
    expect(after!.status).toBe(snapshot!.status);
    expect((await getLogsByTaskId(task.id)).length).toBe(snapshotLogs);
  });

  test("completing a task manually marked terminal returns null", async () => {
    // Belt-and-suspenders: even if the row was written outside the normal
    // code path (e.g. direct UPDATE), the guard catches it.
    const agent = await createAgent({
      name: "sp-idempotency-3",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = await createTaskExtended("SP Task C", { agentId: agent.id });
    (await getDb()).run(
      "UPDATE agent_tasks SET status = 'completed', output = 'manually written', finishedAt = ? WHERE id = ?",
      [new Date().toISOString(), task.id],
    );

    const result = await completeTask(task.id, "tried to overwrite");
    expect(result).toBeNull();

    const after = await getTaskById(task.id);
    expect(after!.output).toBe("manually written");
  });
});

interface FollowUpRow {
  id: string;
  agentId: string | null;
  parentTaskId: string | null;
  taskType: string | null;
  task: string;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  slackUserId: string | null;
}

async function listFollowUpTasks(parentTaskId: string): Promise<FollowUpRow[]> {
  return (await getDb())
    .prepare<FollowUpRow, [string]>(
      `SELECT id, agentId, parentTaskId, taskType, task, slackChannelId, slackThreadTs, slackUserId
       FROM agent_tasks
       WHERE parentTaskId = ? AND taskType = 'follow-up'
       ORDER BY createdAt ASC`,
    )
    .all(parentTaskId);
}

describe("worker task follow-up creation", () => {
  test("creates lead follow-up for completed worker task", async () => {
    const lead = await createAgent({
      name: "follow-up-lead-1",
      isLead: true,
      status: "idle",
      capabilities: [],
    });
    const worker = await createAgent({
      name: "follow-up-worker-1",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const task = await createTaskExtended("Worker task", {
      agentId: worker.id,
      slackChannelId: "C123",
      slackThreadTs: "1700000000.000001",
      slackUserId: "U123",
    });
    await startTask(task.id, worker.id);

    const completed = await completeTask(task.id, "Worker output");
    expect(completed).not.toBeNull();

    const followUp = await createWorkerTaskFollowUp({
      task: completed!,
      status: "completed",
      output: "Worker output",
    });

    expect(followUp).not.toBeNull();
    const rows = await listFollowUpTasks(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agentId).toBe(lead.id);
    expect(rows[0]!.parentTaskId).toBe(task.id);
    expect(rows[0]!.slackChannelId).toBe("C123");
    expect(rows[0]!.slackThreadTs).toBe("1700000000.000001");
    expect(rows[0]!.slackUserId).toBe("U123");
    expect(rows[0]!.task).toContain("Worker output");
  });

  test("does not create follow-up for lead-owned task", async () => {
    const lead = await createAgent({
      name: "follow-up-lead-2",
      isLead: true,
      status: "idle",
      capabilities: [],
    });
    const task = await createTaskExtended("Lead task", { agentId: lead.id });
    await startTask(task.id, lead.id);

    const completed = await completeTask(task.id, "Lead output");
    expect(completed).not.toBeNull();

    const followUp = await createWorkerTaskFollowUp({
      task: completed!,
      status: "completed",
      output: "Lead output",
    });

    expect(followUp).toBeNull();
    expect(await listFollowUpTasks(task.id)).toHaveLength(0);
  });
});
