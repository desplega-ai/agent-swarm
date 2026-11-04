import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  cancelTask,
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  getDbClient,
  getLogsByTaskIdAndEventType,
  initDb,
  pauseTask,
  startTask,
} from "../be/db";
import { registerStoreProgressTool } from "../tools/store-progress";
import type { CreateTaskOptions } from "../types";

type StoreProgressResult = { structuredContent: { success: boolean; message: string } };
type RegisteredTool = { handler: (args: unknown, extra: unknown) => Promise<unknown> };

let leadId: string;
let workerId: string;
let otherWorkerId: string;
let storeProgress: RegisteredTool;

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
    await createAgent({ name: "Reviewer", status: "busy", capabilities: [], maxTasks: 50 })
  ).id;
  otherWorkerId = (
    await createAgent({ name: "Coder", status: "busy", capabilities: [], maxTasks: 50 })
  ).id;
  const server = new McpServer({ name: "chained-follow-up-test", version: "1.0.0" });
  registerStoreProgressTool(server);
  storeProgress = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools["store-progress"]!;
});
afterAll(() => closeDb());

type FollowUpRow = { id: string; task: string; slackChannelId: string | null };

function followUps(parentTaskId: string): Promise<FollowUpRow[]> {
  return getDbClient().query<FollowUpRow>(
    "SELECT id, task, slackChannelId FROM agent_tasks WHERE parentTaskId = ? AND taskType = 'follow-up'",
    [parentTaskId],
  );
}

/** A started worker task, as the Reviewer holds it mid-review. */
async function reviewTask(options: CreateTaskOptions = {}) {
  const task = await createTaskExtended("Review PR #1", {
    agentId: workerId,
    creatorAgentId: leadId,
    ...options,
  });
  await startTask(task.id);
  return task;
}

/** The fix task the Reviewer chains from its review. */
function chainChild(parentTaskId: string, options: CreateTaskOptions = {}) {
  return createTaskExtended("Fix the review blockers", {
    agentId: otherWorkerId,
    creatorAgentId: workerId,
    parentTaskId,
    followUpConfig: { disabled: true },
    ...options,
  });
}

async function finish(
  taskId: string,
  args: { status?: "completed" | "failed" | "skipped"; chainedTaskId?: string },
) {
  const status = args.status ?? "completed";
  const result = (await storeProgress.handler(
    {
      taskId,
      status,
      ...(status === "completed" ? { output: "CHAINED: fix task" } : { failureReason: "boom" }),
      ...(args.chainedTaskId ? { chainedTaskId: args.chainedTaskId } : {}),
    },
    {
      sessionId: `session-${crypto.randomUUID()}`,
      requestInfo: { headers: { "x-agent-id": workerId } },
    },
  )) as StoreProgressResult;
  // The completion itself never fails because of chainedTaskId.
  expect(result.structuredContent.success).toBe(true);
}

async function suppressions(taskId: string) {
  return (await getLogsByTaskIdAndEventType(taskId, "task_follow_up_suppressed")).map(
    (log) => JSON.parse(log.metadata ?? "{}") as Record<string, unknown>,
  );
}

describe("store-progress chainedTaskId", () => {
  test("a live chained child suppresses the follow-up and logs the handoff", async () => {
    const task = await reviewTask({ followUpConfig: { onCompleted: "CHAINED => no action" } });
    const child = await chainChild(task.id);

    await finish(task.id, { chainedTaskId: child.id });

    expect(await followUps(task.id)).toHaveLength(0);
    expect(await suppressions(task.id)).toEqual([
      {
        reason: "chained_task_live",
        status: "completed",
        chainedTaskId: child.id,
        chainedTaskStatus: "pending",
        droppedOnCompleted: true,
      },
    ]);
  });

  test("in_progress and paused children count as live", async () => {
    for (const settle of [startTask, async (id: string) => pauseTask((await startTask(id))!.id)]) {
      const task = await reviewTask();
      const child = await chainChild(task.id);
      await settle(child.id);

      await finish(task.id, { chainedTaskId: child.id });

      expect(await followUps(task.id)).toHaveLength(0);
    }
  });

  test.each([
    ["completed", (id: string) => completeTask(id, "done"), "it is completed, not live"],
    ["cancelled", (id: string) => cancelTask(id, "stop"), "it is cancelled, not live"],
  ] as const)("a %s child creates the follow-up naming the reason", async (_, settle, reason) => {
    const task = await reviewTask();
    const child = await chainChild(task.id);
    await settle(child.id);

    await finish(task.id, { chainedTaskId: child.id });

    const [followUp, ...rest] = await followUps(task.id);
    expect(rest).toHaveLength(0);
    expect(followUp!.task).toContain(`chainedTaskId ${child.id}`);
    expect(followUp!.task).toContain(reason);
    expect(await suppressions(task.id)).toHaveLength(0);
  });

  test("a child with another parent creates the follow-up", async () => {
    const task = await reviewTask();
    const otherParent = await reviewTask();
    const child = await chainChild(otherParent.id);

    await finish(task.id, { chainedTaskId: child.id });

    const [followUp] = await followUps(task.id);
    expect(followUp!.task).toContain(`its parentTaskId is ${otherParent.id}, not this task`);
  });

  test("a child created by another agent creates the follow-up", async () => {
    const task = await reviewTask();
    const child = await chainChild(task.id, { creatorAgentId: leadId });

    await finish(task.id, { chainedTaskId: child.id });

    const [followUp] = await followUps(task.id);
    expect(followUp!.task).toContain("not created by the agent that completed this task");
  });

  test("an unknown id creates the follow-up", async () => {
    const task = await reviewTask();
    const missing = crypto.randomUUID();

    await finish(task.id, { chainedTaskId: missing });

    const [followUp] = await followUps(task.id);
    expect(followUp!.task).toContain(`chainedTaskId ${missing}`);
    expect(followUp!.task).toContain("no task has this id");
  });

  test("a failed completion ignores chainedTaskId and wakes the lead", async () => {
    const task = await reviewTask();
    const child = await chainChild(task.id);

    await finish(task.id, { status: "failed", chainedTaskId: child.id });

    const [followUp, ...rest] = await followUps(task.id);
    expect(rest).toHaveLength(0);
    expect(followUp!.task).not.toContain("chainedTaskId");
    expect(await suppressions(task.id)).toHaveLength(0);
  });

  test("a skipped completion ignores chainedTaskId", async () => {
    const task = await reviewTask();
    const child = await chainChild(task.id);

    await finish(task.id, { status: "skipped", chainedTaskId: child.id });

    expect(await followUps(task.id)).toHaveLength(0);
    expect(await suppressions(task.id)).toHaveLength(0);
  });

  test("followUpConfig.disabled still disables, with or without a valid chain", async () => {
    for (const chained of [false, true]) {
      const task = await reviewTask({ followUpConfig: { disabled: true } });
      const child = await chainChild(task.id);

      await finish(task.id, chained ? { chainedTaskId: child.id } : {});

      expect(await followUps(task.id)).toHaveLength(0);
      expect(await suppressions(task.id)).toHaveLength(0);
    }
  });

  test("without chainedTaskId the follow-up is unchanged", async () => {
    const task = await reviewTask();
    await chainChild(task.id);

    await finish(task.id, {});

    const [followUp] = await followUps(task.id);
    expect(followUp!.task).not.toContain("chainedTaskId");
  });

  test("a Slack-sourced task with a suppressed follow-up creates nothing in the thread", async () => {
    const slack = { slackChannelId: "C_TEST", slackThreadTs: "1700000000.000100" };
    const task = await reviewTask({ source: "slack", ...slack });
    const child = await chainChild(task.id);

    await finish(task.id, { chainedTaskId: child.id });

    expect(await followUps(task.id)).toHaveLength(0);
    // Only the review and its chained child live in the thread: no Lead
    // follow-up exists to reply there or post an outcome card.
    const inThread = await getDbClient().query<{ id: string }>(
      "SELECT id FROM agent_tasks WHERE slackChannelId = ? AND slackThreadTs = ?",
      [slack.slackChannelId, slack.slackThreadTs],
    );
    expect(inThread.map((row) => row.id).sort()).toEqual([task.id, child.id].sort());
  });
});
