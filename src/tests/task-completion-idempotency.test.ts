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
  getLeadAgent,
  getLogsByTaskId,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";
import { createWorkerTaskFollowUp } from "../tasks/worker-follow-up";

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

function listFollowUpTasks(parentTaskId: string): FollowUpRow[] {
  return getDb()
    .prepare<FollowUpRow, [string]>(
      `SELECT id, agentId, parentTaskId, taskType, task, slackChannelId, slackThreadTs, slackUserId
       FROM agent_tasks
       WHERE parentTaskId = ? AND taskType = 'follow-up'
       ORDER BY createdAt ASC`,
    )
    .all(parentTaskId);
}

describe("worker task follow-up creation", () => {
  test("creates lead follow-up for completed worker task", () => {
    const lead = createAgent({
      name: "follow-up-lead-1",
      isLead: true,
      status: "idle",
      capabilities: [],
    });
    const worker = createAgent({
      name: "follow-up-worker-1",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const task = createTaskExtended("Worker task", {
      agentId: worker.id,
      slackChannelId: "C123",
      slackThreadTs: "1700000000.000001",
      slackUserId: "U123",
    });
    startTask(task.id);

    const completed = completeTask(task.id, "Worker output");
    expect(completed).not.toBeNull();

    const followUp = createWorkerTaskFollowUp({
      task: completed!,
      status: "completed",
      output: "Worker output",
    });

    expect(followUp).not.toBeNull();
    const rows = listFollowUpTasks(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agentId).toBe(lead.id);
    expect(rows[0]!.parentTaskId).toBe(task.id);
    expect(rows[0]!.slackChannelId).toBe("C123");
    expect(rows[0]!.slackThreadTs).toBe("1700000000.000001");
    expect(rows[0]!.slackUserId).toBe("U123");
    expect(rows[0]!.task).toContain("Worker output");
    expect(rows[0]!.task).not.toContain("{{follow_up_instructions}}");
  });

  test("skips lead follow-up when followUpConfig disables it", () => {
    createAgent({
      name: "follow-up-lead-disabled",
      isLead: true,
      status: "idle",
      capabilities: [],
    });
    const worker = createAgent({
      name: "follow-up-worker-disabled",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const task = createTaskExtended("Silent worker task", {
      agentId: worker.id,
      followUpConfig: { disabled: true },
    });
    startTask(task.id);

    const completed = completeTask(task.id, "Worker output");
    expect(completed).not.toBeNull();

    const followUp = createWorkerTaskFollowUp({
      task: completed!,
      status: "completed",
      output: "Worker output",
    });

    expect(followUp).toBeNull();
    expect(listFollowUpTasks(task.id)).toHaveLength(0);
  });

  test("injects onCompleted instructions into completed follow-up", () => {
    createAgent({
      name: "follow-up-lead-completed-instructions",
      isLead: true,
      status: "idle",
      capabilities: [],
    });
    const worker = createAgent({
      name: "follow-up-worker-completed-instructions",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const task = createTaskExtended("Worker task with completed instructions", {
      agentId: worker.id,
      creatorAgentId: worker.id,
      followUpConfig: { onCompleted: "post the URL" },
    });
    startTask(task.id);

    const completed = completeTask(task.id, "Worker output");
    expect(completed).not.toBeNull();

    const followUp = createWorkerTaskFollowUp({
      task: completed!,
      status: "completed",
      output: "Worker output",
    });

    expect(followUp).not.toBeNull();
    const rows = listFollowUpTasks(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.task).toContain(`Original task created by agent ${worker.id}`);
    expect(rows[0]!.task).toContain("Additional instructions from the task creator:");
    expect(rows[0]!.task).toContain("post the URL");
  });

  test("injects only onFailed instructions into failed follow-up", () => {
    createAgent({
      name: "follow-up-lead-failed-instructions",
      isLead: true,
      status: "idle",
      capabilities: [],
    });
    const worker = createAgent({
      name: "follow-up-worker-failed-instructions",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const task = createTaskExtended("Worker task with failed instructions", {
      agentId: worker.id,
      creatorAgentId: worker.id,
      followUpConfig: { onCompleted: "post the URL", onFailed: "page Taras" },
    });
    startTask(task.id);

    const failed = failTask(task.id, "boom");
    expect(failed).not.toBeNull();

    const followUp = createWorkerTaskFollowUp({
      task: failed!,
      status: "failed",
      failureReason: "boom",
    });

    expect(followUp).not.toBeNull();
    const rows = listFollowUpTasks(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.task).toContain(`Original task created by agent ${worker.id}`);
    expect(rows[0]!.task).toContain("page Taras");
    expect(rows[0]!.task).not.toContain("post the URL");
  });

  test("inherits followUpConfig from parent task when child has no override", () => {
    createAgent({
      name: "follow-up-lead-inheritance",
      isLead: true,
      status: "idle",
      capabilities: [],
    });
    const worker = createAgent({
      name: "follow-up-worker-inheritance",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const parent = createTaskExtended("Parent task", {
      agentId: worker.id,
      followUpConfig: { disabled: true },
    });
    const child = createTaskExtended("Child task", {
      agentId: worker.id,
      parentTaskId: parent.id,
    });
    startTask(child.id);

    const fetchedChild = getTaskById(child.id);
    expect(fetchedChild!.followUpConfig).toEqual({ disabled: true });

    const completed = completeTask(child.id, "Child output");
    expect(completed).not.toBeNull();

    const followUp = createWorkerTaskFollowUp({
      task: completed!,
      status: "completed",
      output: "Child output",
    });

    expect(followUp).toBeNull();
    expect(listFollowUpTasks(child.id)).toHaveLength(0);
  });

  test("does not create follow-up for lead-owned task", () => {
    const lead = createAgent({
      name: "follow-up-lead-2",
      isLead: true,
      status: "idle",
      capabilities: [],
    });
    const task = createTaskExtended("Lead task", { agentId: lead.id });
    startTask(task.id);

    const completed = completeTask(task.id, "Lead output");
    expect(completed).not.toBeNull();

    const followUp = createWorkerTaskFollowUp({
      task: completed!,
      status: "completed",
      output: "Lead output",
    });

    expect(followUp).toBeNull();
    expect(listFollowUpTasks(task.id)).toHaveLength(0);
  });

  test("marks original creator as you when lead created the worker task", () => {
    const lead =
      getLeadAgent() ??
      createAgent({
        name: "follow-up-lead-creator-you",
        isLead: true,
        status: "idle",
        capabilities: [],
      });
    const worker = createAgent({
      name: "follow-up-worker-creator-you",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const task = createTaskExtended("Worker task created by lead", {
      agentId: worker.id,
      creatorAgentId: lead.id,
    });
    startTask(task.id);

    const completed = completeTask(task.id, "Worker output");
    expect(completed).not.toBeNull();

    const followUp = createWorkerTaskFollowUp({
      task: completed!,
      status: "completed",
      output: "Worker output",
    });

    expect(followUp).not.toBeNull();
    const rows = listFollowUpTasks(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.task).toContain(`Original task created by agent ${lead.id} (you)`);
  });
});
