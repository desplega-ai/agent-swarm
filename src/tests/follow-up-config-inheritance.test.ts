import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  getDbClient,
  getScheduledTaskById,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";
import { getRebootAffectedTasks, runRebootSweep } from "../heartbeat/heartbeat";
import { createStandaloneScheduleTask } from "../scheduler/schedule-task";
import { createResumeFollowUp, createWorkerTaskFollowUp } from "../tasks/worker-follow-up";
import { registerDeferTaskTool } from "../tools/defer-task";
import { registerSendTaskTool } from "../tools/send-task";
import type { FollowUpConfig } from "../types";

// followUpConfig follows one piece of work, not the thread: continuations of
// the same work inherit it, new work created with a parentTaskId does not.

type Tool = { handler: (args: unknown, extra: unknown) => Promise<CallToolResult> };

const ON_COMPLETED: FollowUpConfig = { onCompleted: "Switch the cron and DM the requester." };

let leadId: string;
let workerId: string;
let sendTask: Tool;
let deferTask: Tool;

function callTool(tool: Tool, args: Record<string, unknown>, agentId: string) {
  return tool.handler(args, {
    sessionId: crypto.randomUUID(),
    requestInfo: { headers: { "x-agent-id": agentId } },
  });
}

function sentTaskId(result: CallToolResult): string {
  const structured = result.structuredContent as { success: boolean; task?: { id: string } };
  expect(structured.success).toBe(true);
  return structured.task!.id;
}

async function followUpConfigOf(taskId: string) {
  return (await getTaskById(taskId))?.followUpConfig;
}

async function workerTaskWithOnCompleted(description: string) {
  const task = await createTaskExtended(description, {
    agentId: workerId,
    followUpConfig: ON_COMPLETED,
  });
  await startTask(task.id);
  return task;
}

beforeAll(async () => {
  initDb(":memory:");
  const server = new McpServer({ name: "follow-up-config-inheritance", version: "1.0.0" });
  registerSendTaskTool(server);
  registerDeferTaskTool(server);
  const tools = (server as unknown as { _registeredTools: Record<string, Tool> })._registeredTools;
  sendTask = tools["send-task"]!;
  deferTask = tools["defer-task"]!;
});

beforeEach(async () => {
  const db = getDbClient();
  await db.run("DELETE FROM agent_tasks");
  await db.run("DELETE FROM agents");
  await db.run("DELETE FROM active_sessions");
  leadId = (
    await createAgent({
      name: "Lead",
      isLead: true,
      status: "idle",
      capabilities: [],
      maxTasks: 50,
    })
  ).id;
  workerId = (
    await createAgent({
      name: "Worker",
      isLead: false,
      status: "idle",
      capabilities: [],
      maxTasks: 50,
    })
  ).id;
});

afterAll(() => closeDb());

describe("createTaskExtended followUpConfig inheritance", () => {
  test("a plain child with parentTaskId does not inherit", async () => {
    const parent = await workerTaskWithOnCompleted("parent work");
    const child = await createTaskExtended("unrelated child", { parentTaskId: parent.id });
    expect(child.followUpConfig).toBeUndefined();
  });

  test("an explicit followUpConfig wins over the parent's", async () => {
    const parent = await workerTaskWithOnCompleted("parent work");
    const own: FollowUpConfig = { onFailed: "Retry once." };
    const child = await createTaskExtended("continuation", {
      parentTaskId: parent.id,
      inheritParentFollowUpConfig: true,
      followUpConfig: own,
    });
    expect(child.followUpConfig).toEqual(own);
  });
});

describe("kept: continuations of the same work inherit followUpConfig", () => {
  test("interrupted-task resume (createResumeFollowUp)", async () => {
    const parent = await workerTaskWithOnCompleted("interrupted work");
    const resume = await createResumeFollowUp({ parentId: parent.id, reason: "crash_recovery" });
    expect(resume.kind).toBe("created");
    if (resume.kind !== "created") return;
    expect(resume.task.followUpConfig).toEqual(ON_COMPLETED);
  });

  test("reboot-sweep retry", async () => {
    const parent = await workerTaskWithOnCompleted("work cut by a reboot");
    await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
      new Date(Date.now() - 1000).toISOString(),
      parent.id,
    ]);

    await runRebootSweep();

    const retryTaskId = getRebootAffectedTasks().find(
      (a) => a.original.id === parent.id,
    )?.retryTaskId;
    expect(retryTaskId).toBeTruthy();
    expect(await followUpConfigOf(retryTaskId!)).toEqual(ON_COMPLETED);
  });

  test("defer-task wake-up continuation", async () => {
    const parent = await workerTaskWithOnCompleted("work that waits");
    const result = await callTool(
      deferTask,
      { taskId: parent.id, delayMs: 3_600_000, summary: "Waiting", note: "Check back" },
      workerId,
    );
    const { success, scheduleId } = result.structuredContent as {
      success: boolean;
      scheduleId?: string;
    };
    expect(success).toBe(true);
    const schedule = await getScheduledTaskById(scheduleId!);

    const wake = await createStandaloneScheduleTask(schedule!);
    expect(wake.parentTaskId).toBe(parent.id);
    expect(wake.followUpConfig).toEqual(ON_COMPLETED);
  });

  test("send-task resume re-delegation (reroute-decision template)", async () => {
    const parent = await workerTaskWithOnCompleted("crashed work");
    const childId = sentTaskId(
      await callTool(
        sendTask,
        {
          task: "resume the crashed work",
          agentId: workerId,
          routingReason: "reroute_fault",
          routingNote: "same specialization as the crashed worker",
          taskType: "resume",
          parentTaskId: parent.id,
        },
        leadId,
      ),
    );
    expect(await followUpConfigOf(childId)).toEqual(ON_COMPLETED);
  });
});

describe("stopped: new work does not inherit followUpConfig", () => {
  test("Lead follow-up from createWorkerTaskFollowUp", async () => {
    const task = await workerTaskWithOnCompleted("worker build task");
    const completed = await completeTask(task.id, "done");
    const followUp = await createWorkerTaskFollowUp({
      task: completed!,
      status: "completed",
      output: "done",
    });
    expect(followUp).not.toBeNull();
    // The instruction is delivered in the follow-up's text, once.
    expect(followUp!.task).toContain(ON_COMPLETED.onCompleted!);
    expect(followUp!.followUpConfig).toBeUndefined();
  });

  test("send-task child with parentTaskId", async () => {
    const parent = await workerTaskWithOnCompleted("original request");
    const childId = sentTaskId(
      await callTool(
        sendTask,
        {
          task: "a new delegation in the same thread",
          agentId: workerId,
          routingReason: "skill",
          routingNote: "worker owns this area of the codebase",
          parentTaskId: parent.id,
        },
        leadId,
      ),
    );
    expect(await followUpConfigOf(childId)).toBeUndefined();
  });

  test("send-task child keeps an explicit followUpConfig", async () => {
    const parent = await workerTaskWithOnCompleted("original request 2");
    const own: FollowUpConfig = { disabled: true };
    const childId = sentTaskId(
      await callTool(
        sendTask,
        {
          task: "delegation that is awaited inline",
          agentId: workerId,
          routingReason: "skill",
          routingNote: "worker owns this area of the codebase",
          parentTaskId: parent.id,
          followUpConfig: own,
        },
        leadId,
      ),
    );
    expect(await followUpConfigOf(childId)).toEqual(own);
  });

  test("chain regression: worker task -> Lead follow-up -> send-task child", async () => {
    const task = await workerTaskWithOnCompleted("tla-spec-sync build");
    const completed = await completeTask(task.id, "built");
    const followUp = await createWorkerTaskFollowUp({
      task: completed!,
      status: "completed",
      output: "built",
    });
    expect(followUp).not.toBeNull();

    const childId = sentTaskId(
      await callTool(
        sendTask,
        {
          task: "render the launch video",
          agentId: workerId,
          routingReason: "skill",
          routingNote: "worker owns the video pipeline",
          parentTaskId: followUp!.id,
        },
        leadId,
      ),
    );

    expect(await followUpConfigOf(followUp!.id)).toBeUndefined();
    expect(await followUpConfigOf(childId)).toBeUndefined();
  });
});
