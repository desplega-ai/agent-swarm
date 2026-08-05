import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlinkSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  cancelTask,
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  failTask,
  getAgentById,
  getDb,
  getLeadAgent,
  getLogsByTaskId,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";
import { createWorkerTaskFollowUp } from "../tasks/worker-follow-up";
import { registerStoreProgressTool } from "../tools/store-progress";
import { workflowEventBus } from "../workflows/event-bus";

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
    startTask(task.id);

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
    startTask(task.id);

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
    startTask(task.id);
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
    startTask(task.id);
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
    startTask(task.id);

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
    startTask(task.id);

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
    startTask(task.id);
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
    startTask(task.id);
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
    startTask(task.id);
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
    startTask(task.id);
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

type StoreProgressResult = {
  structuredContent: {
    success: boolean;
    message: string;
    task?: { id: string; status: string; finishedAt?: string };
    wasNoOp?: boolean;
    wasForcedOverwrite?: boolean;
  };
};

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
};

function buildStoreProgressHandler(): RegisteredTool {
  const server = new McpServer({ name: "store-progress-idempotency-test", version: "1.0.0" });
  registerStoreProgressTool(server);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = registered["store-progress"];
  if (!tool) throw new Error("store-progress tool not registered");
  return tool;
}

function storeProgressMeta(agentId: string) {
  return {
    sessionId: `session-${crypto.randomUUID()}`,
    requestInfo: { headers: { "x-agent-id": agentId } },
  };
}

function countTaskCompletionMemories(taskId: string): number {
  return getDb()
    .prepare<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM agent_memory WHERE sourceTaskId = ?",
    )
    .get(taskId)!.count;
}

describe("store-progress terminal result reporting", () => {
  test("identical and content-free retries remain benign no-ops", async () => {
    const agent = createAgent({
      name: "terminal-handler-identical",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const task = createTaskExtended("terminal identical retry", { agentId: agent.id });
    startTask(task.id);
    const completed = completeTask(task.id, "stable output");
    const handler = buildStoreProgressHandler();

    for (const args of [
      { taskId: task.id, status: "completed", output: "stable output" },
      { taskId: task.id, status: "completed" },
    ]) {
      const result = (await handler.handler(
        args,
        storeProgressMeta(agent.id),
      )) as StoreProgressResult;
      expect(result.structuredContent.success).toBe(true);
      expect(result.structuredContent.wasNoOp).toBe(true);
      expect(result.structuredContent.wasForcedOverwrite).toBeUndefined();
    }

    const fresh = getTaskById(task.id);
    expect(fresh!.output).toBe("stable output");
    expect(fresh!.finishedAt).toBe(completed!.finishedAt);
  });

  test("differing terminal text is refused honestly without force", async () => {
    const agent = createAgent({
      name: "terminal-handler-refusal",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const task = createTaskExtended("terminal differing retry", { agentId: agent.id });
    startTask(task.id);
    const completed = completeTask(task.id, "first output")!;
    const before = getTaskById(task.id)!;

    const result = (await buildStoreProgressHandler().handler(
      { taskId: task.id, status: "completed", output: "discard me" },
      storeProgressMeta(agent.id),
    )) as StoreProgressResult;

    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toContain("Discarded write");
    expect(result.structuredContent.message).toContain("force: true");
    expect(result.structuredContent.wasNoOp).toBeUndefined();
    const fresh = getTaskById(task.id)!;
    expect(fresh.output).toBe("first output");
    expect(fresh.status).toBe("completed");
    expect(fresh.finishedAt).toBe(completed.finishedAt);
    expect(fresh.lastUpdatedAt).toBe(before.lastUpdatedAt);
  });

  test("force overwrites only explicit terminal text and replays no side effects", async () => {
    getLeadAgent() ??
      createAgent({
        name: "terminal-force-lead",
        isLead: true,
        status: "idle",
        capabilities: [],
      });
    const agent = createAgent({
      name: "terminal-handler-force",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const task = createTaskExtended("terminal forced overwrite", { agentId: agent.id });
    startTask(task.id);
    completeTask(task.id, "first output");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const before = getTaskById(task.id)!;
    const logsBefore = getLogsByTaskId(task.id).length;
    const memoriesBefore = countTaskCompletionMemories(task.id);
    const followUpsBefore = listFollowUpTasks(task.id).length;
    const agentStatusBefore = getAgentById(agent.id)!.status;
    let terminalEvents = 0;
    const onTerminalEvent = () => {
      terminalEvents += 1;
    };
    workflowEventBus.on("task.completed", onTerminalEvent);
    workflowEventBus.on("task.failed", onTerminalEvent);

    try {
      const result = (await buildStoreProgressHandler().handler(
        {
          taskId: task.id,
          status: "completed",
          output: "corrected output",
          failureReason: "corrected reason",
          force: true,
        },
        storeProgressMeta(agent.id),
      )) as StoreProgressResult;
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(result.structuredContent.success).toBe(true);
      expect(result.structuredContent.wasForcedOverwrite).toBe(true);
      expect(result.structuredContent.wasNoOp).toBeUndefined();
      const fresh = getTaskById(task.id)!;
      expect(fresh.output).toBe("corrected output");
      expect(fresh.failureReason).toBe("corrected reason");
      expect(fresh.status).toBe(before.status);
      expect(fresh.finishedAt).toBe(before.finishedAt);
      expect(fresh.lastUpdatedAt).toBe(before.lastUpdatedAt);
      expect(getLogsByTaskId(task.id)).toHaveLength(logsBefore);
      expect(countTaskCompletionMemories(task.id)).toBe(memoriesBefore);
      expect(listFollowUpTasks(task.id)).toHaveLength(followUpsBefore);
      expect(getAgentById(agent.id)!.status).toBe(agentStatusBefore);
      expect(terminalEvents).toBe(0);

      const forceWithoutStatus = (await buildStoreProgressHandler().handler(
        { taskId: task.id, failureReason: "second correction", force: true },
        storeProgressMeta(agent.id),
      )) as StoreProgressResult;
      expect(forceWithoutStatus.structuredContent.success).toBe(true);
      expect(forceWithoutStatus.structuredContent.wasForcedOverwrite).toBe(true);
      expect(getTaskById(task.id)!.failureReason).toBe("second correction");
      expect(getTaskById(task.id)!.finishedAt).toBe(before.finishedAt);
      expect(getLogsByTaskId(task.id)).toHaveLength(logsBefore);
      expect(countTaskCompletionMemories(task.id)).toBe(memoriesBefore);
      expect(listFollowUpTasks(task.id)).toHaveLength(followUpsBefore);
      expect(terminalEvents).toBe(0);
    } finally {
      workflowEventBus.off("task.completed", onTerminalEvent);
      workflowEventBus.off("task.failed", onTerminalEvent);
    }
  });

  test("force preserves outputSchema validation before overwriting terminal output", async () => {
    const agent = createAgent({
      name: "terminal-handler-output-schema",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const task = createTaskExtended("terminal structured output", {
      agentId: agent.id,
      outputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    });
    startTask(task.id);
    const originalOutput = JSON.stringify({ value: "first" });
    const completed = completeTask(task.id, originalOutput)!;
    const handler = buildStoreProgressHandler();

    const invalid = (await handler.handler(
      { taskId: task.id, output: "not json", force: true },
      storeProgressMeta(agent.id),
    )) as StoreProgressResult;
    expect(invalid.structuredContent.success).toBe(false);
    expect(invalid.structuredContent.message).toContain("must be valid JSON");
    expect(getTaskById(task.id)!.output).toBe(originalOutput);
    expect(getTaskById(task.id)!.finishedAt).toBe(completed.finishedAt);

    const correctedOutput = JSON.stringify({ value: "corrected" });
    const valid = (await handler.handler(
      { taskId: task.id, output: correctedOutput, force: true },
      storeProgressMeta(agent.id),
    )) as StoreProgressResult;
    expect(valid.structuredContent.success).toBe(true);
    expect(valid.structuredContent.wasForcedOverwrite).toBe(true);
    expect(getTaskById(task.id)!.output).toBe(correctedOutput);
    expect(getTaskById(task.id)!.finishedAt).toBe(completed.finishedAt);
  });

  test("an identical retry still blocks duplicate events, memory, and follow-ups", async () => {
    getLeadAgent() ??
      createAgent({
        name: "terminal-race-lead",
        isLead: true,
        status: "idle",
        capabilities: [],
      });
    const agent = createAgent({
      name: "terminal-handler-race",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const task = createTaskExtended("terminal race guard", {
      agentId: agent.id,
      taskType: "heartbeat",
    });
    startTask(task.id);
    let completedEvents = 0;
    const onCompleted = () => {
      completedEvents += 1;
    };
    workflowEventBus.on("task.completed", onCompleted);

    try {
      const handler = buildStoreProgressHandler();
      const args = { taskId: task.id, status: "completed", output: "one result" };
      const first = (await handler.handler(
        args,
        storeProgressMeta(agent.id),
      )) as StoreProgressResult;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(first.structuredContent.success).toBe(true);
      const logsAfterFirst = getLogsByTaskId(task.id).length;
      const memoriesAfterFirst = countTaskCompletionMemories(task.id);
      const followUpsAfterFirst = listFollowUpTasks(task.id).length;
      const eventsAfterFirst = completedEvents;

      const second = (await handler.handler(
        args,
        storeProgressMeta(agent.id),
      )) as StoreProgressResult;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(second.structuredContent.success).toBe(true);
      expect(second.structuredContent.wasNoOp).toBe(true);
      expect(getLogsByTaskId(task.id)).toHaveLength(logsAfterFirst);
      expect(countTaskCompletionMemories(task.id)).toBe(memoriesAfterFirst);
      expect(listFollowUpTasks(task.id)).toHaveLength(followUpsAfterFirst);
      expect(completedEvents).toBe(eventsAfterFirst);
      expect(followUpsAfterFirst).toBe(1);
      expect(eventsAfterFirst).toBe(1);
    } finally {
      workflowEventBus.off("task.completed", onCompleted);
    }
  });
});

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
