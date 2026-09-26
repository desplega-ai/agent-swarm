import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  failTask,
  getDbClient,
  getLogsByTaskIdAndEventType,
  initDb,
  startTask,
} from "../be/db";
import {
  DEFERRED_WAIT_WOKE_EVENT,
  dispatchDeferredTaskWait,
  initDeferredTaskWaits,
  reconcileDeferredTaskWaits,
  stopDeferredTaskWaits,
} from "../scheduler/deferred-task-waits";
import { createWorkerTaskFollowUp } from "../tasks/worker-follow-up";
import { registerDeferTaskTool } from "../tools/defer-task";
import type { AgentTask } from "../types";

type Result = { structuredContent: { success: boolean; message: string; scheduleId?: string } };
type Tool = { handler: (args: unknown, extra: unknown) => Promise<Result> };

let leadId: string;
let workerId: string;
let tool: Tool;

beforeAll(async () => {
  initDb(":memory:");
  leadId = (
    await createAgent({
      name: "Lead",
      isLead: true,
      status: "busy",
      capabilities: [],
      maxTasks: 50,
    })
  ).id;
  workerId = (
    await createAgent({
      name: "Worker",
      isLead: false,
      status: "busy",
      capabilities: [],
      maxTasks: 50,
    })
  ).id;
  const server = new McpServer({ name: "wake-follow-up-test", version: "1.0.0" });
  registerDeferTaskTool(server);
  tool = (server as unknown as { _registeredTools: Record<string, Tool> })._registeredTools[
    "defer-task"
  ]!;
});
afterEach(() => stopDeferredTaskWaits());
afterAll(() => closeDb());

async function activeTask(agentId: string, options: Parameters<typeof createTaskExtended>[1] = {}) {
  const task = await createTaskExtended("work in progress", { agentId, ...options });
  await startTask(task.id);
  return task;
}

/** `waiterAgentId` defers a fresh task until `producers` settle. */
async function deferOn(producers: AgentTask[], mode: "all" | "any", waiterAgentId = leadId) {
  const waiter = await activeTask(waiterAgentId);
  const result = await tool.handler(
    {
      taskId: waiter.id,
      wakeOn: { taskIds: producers.map((producer) => producer.id), event: "settled", mode },
      delayMs: 3600000,
      summary: "Delegated",
      note: "Review the worker result",
    },
    { sessionId: crypto.randomUUID(), requestInfo: { headers: { "x-agent-id": waiterAgentId } } },
  );
  expect(result.structuredContent.success).toBe(true);
  return { waiter, scheduleId: result.structuredContent.scheduleId! };
}

async function settle(task: AgentTask, status: "completed" | "failed" = "completed") {
  const settled =
    status === "completed"
      ? await completeTask(task.id, "the result")
      : await failTask(task.id, "boom");
  return createWorkerTaskFollowUp({
    task: settled!,
    status,
    output: status === "completed" ? "the result" : undefined,
    failureReason: status === "failed" ? "boom" : undefined,
  });
}

async function wakeChildren(scheduleId: string) {
  return getDbClient().query<{ id: string; agentId: string }>(
    "SELECT id, agentId FROM agent_tasks WHERE scheduleId = ?",
    [scheduleId],
  );
}

async function suppressions(taskId: string) {
  return (await getLogsByTaskIdAndEventType(taskId, "task_follow_up_suppressed")).map(
    (log) => JSON.parse(log.metadata ?? "{}") as Record<string, unknown>,
  );
}

describe("worker follow-up vs. deferred wake", () => {
  test("any-mode wake suppresses the follow-up and records the waiter", async () => {
    await initDeferredTaskWaits();
    const first = await activeTask(workerId);
    const second = await activeTask(workerId);
    const { waiter, scheduleId } = await deferOn([first, second], "any");

    expect(await settle(first)).toBeNull();

    const [wake] = await wakeChildren(scheduleId);
    expect(wake?.agentId).toBe(leadId);
    expect(await suppressions(first.id)).toEqual([
      {
        reason: "deferred_wait_woke",
        status: "completed",
        waiterTaskId: waiter.id,
        wakeTaskId: wake!.id,
        scheduleId,
      },
    ]);
    // The second member no longer wakes anyone, so it keeps its follow-up.
    expect((await settle(second))?.taskType).toBe("follow-up");
  });

  test("all-mode keeps the follow-up while siblings are pending, suppresses on the last", async () => {
    await initDeferredTaskWaits();
    const first = await activeTask(workerId);
    const second = await activeTask(workerId);
    const { scheduleId } = await deferOn([first, second], "all");

    const early = await settle(first);
    expect(early?.taskType).toBe("follow-up");
    expect(await wakeChildren(scheduleId)).toHaveLength(0);

    expect(await settle(second)).toBeNull();
    expect(await wakeChildren(scheduleId)).toHaveLength(1);
    expect(await suppressions(second.id)).toHaveLength(1);
  });

  test("a failed settlement that wakes the waiter suppresses", async () => {
    const producer = await activeTask(workerId);
    const { waiter } = await deferOn([producer], "all");

    // No event-bus listener: the follow-up path itself runs the wake.
    expect(await settle(producer, "failed")).toBeNull();
    expect((await suppressions(producer.id))[0]?.waiterTaskId).toBe(waiter.id);
  });

  test("no waiter keeps the follow-up", async () => {
    const producer = await activeTask(workerId);
    expect((await settle(producer))?.taskType).toBe("follow-up");
    expect(await suppressions(producer.id)).toHaveLength(0);
  });

  test("a waiter already woken by its ceiling keeps the follow-up", async () => {
    const producer = await activeTask(workerId);
    const { scheduleId } = await deferOn([producer], "any");
    expect((await dispatchDeferredTaskWait(scheduleId, "ceiling"))?.task).toBeDefined();

    expect((await settle(producer))?.taskType).toBe("follow-up");
    expect(await getLogsByTaskIdAndEventType(producer.id, DEFERRED_WAIT_WOKE_EVENT)).toHaveLength(
      0,
    );
  });

  test("a waiter on a different agent keeps the lead follow-up", async () => {
    const producer = await activeTask(workerId);
    const { scheduleId } = await deferOn([producer], "any", workerId);

    expect((await settle(producer))?.taskType).toBe("follow-up");
    const [wake] = await wakeChildren(scheduleId);
    expect(wake?.agentId).toBe(workerId);
    expect(await getLogsByTaskIdAndEventType(producer.id, DEFERRED_WAIT_WOKE_EVENT)).toHaveLength(
      1,
    );
  });

  test("explicit followUpConfig instructions keep the follow-up", async () => {
    const producer = await activeTask(workerId, {
      followUpConfig: { onCompleted: "Post the summary to the channel." },
    });
    const { scheduleId } = await deferOn([producer], "any");

    const followUp = await settle(producer);
    expect(followUp?.task).toContain("Post the summary to the channel.");
    // The waiter still wakes; both run.
    await reconcileDeferredTaskWaits(producer.id);
    expect(await wakeChildren(scheduleId)).toHaveLength(1);
  });
});
