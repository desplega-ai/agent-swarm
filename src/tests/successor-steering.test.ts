import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  closeDb,
  createAgent,
  createSteeringMessage,
  createTaskExtended,
  getDbClient,
  getScheduledTaskById,
  getTaskById,
  initDb,
  markSteeringDelivered,
  markSteeringHandled,
  startTask,
} from "../be/db";
import { getRebootAffectedTasks, runRebootSweep } from "../heartbeat/heartbeat";
import { createStandaloneScheduleTask } from "../scheduler/schedule-task";
import { createResumeFollowUp } from "../tasks/worker-follow-up";
import { registerDeferTaskTool } from "../tools/defer-task";

// A steer delivered to a task but never accepted must reach the task that
// carries the work forward once the original ends.

type Tool = { handler: (args: unknown, extra: unknown) => Promise<CallToolResult> };

let workerId: string;
let deferTask: Tool;

async function successorText(
  path: "defer-task wake-up" | "reboot-sweep retry" | "supersede resume",
  parentId: string,
): Promise<string> {
  if (path === "defer-task wake-up") {
    const result = await deferTask.handler(
      { taskId: parentId, delayMs: 3_600_000, summary: "Waiting", note: "Check back" },
      { sessionId: crypto.randomUUID(), requestInfo: { headers: { "x-agent-id": workerId } } },
    );
    const { success, scheduleId } = result.structuredContent as {
      success: boolean;
      scheduleId?: string;
    };
    expect(success).toBe(true);
    const wake = await createStandaloneScheduleTask((await getScheduledTaskById(scheduleId!))!);
    expect(wake.parentTaskId).toBe(parentId);
    return wake.task;
  }
  if (path === "reboot-sweep retry") {
    await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
      new Date(Date.now() - 1000).toISOString(),
      parentId,
    ]);
    await runRebootSweep();
    const retryTaskId = getRebootAffectedTasks().find(
      (a) => a.original.id === parentId,
    )?.retryTaskId;
    expect(retryTaskId).toBeTruthy();
    return (await getTaskById(retryTaskId!))!.task;
  }
  const resume = await createResumeFollowUp({ parentId, reason: "manual_supersede" });
  expect(resume.kind).toBe("created");
  if (resume.kind !== "created") throw new Error("resume not created");
  return resume.task.task;
}

async function steer(taskId: string, body: string, state: "delivered" | "handled") {
  const message = await createSteeringMessage({
    taskId,
    body,
    mode: "queue",
    source: "api",
    createdByKind: "agent",
    createdByAgentId: workerId,
  });
  expect((await markSteeringDelivered(message.id, "queue"))?.status).toBe("delivered");
  if (state === "handled") {
    expect((await markSteeringHandled(message.id))?.status).toBe("handled");
  }
  return message;
}

async function inProgressTask() {
  const task = await createTaskExtended("work that gets a successor", { agentId: workerId });
  await startTask(task.id);
  return task;
}

beforeAll(async () => {
  initDb(":memory:");
  const server = new McpServer({ name: "successor-steering", version: "1.0.0" });
  registerDeferTaskTool(server);
  const tools = (server as unknown as { _registeredTools: Record<string, Tool> })._registeredTools;
  deferTask = tools["defer-task"]!;
});

beforeEach(async () => {
  const db = getDbClient();
  await db.run("DELETE FROM task_steering_messages");
  await db.run("DELETE FROM agent_tasks");
  await db.run("DELETE FROM agents");
  await db.run("DELETE FROM active_sessions");
  workerId = (
    await createAgent({
      name: "Steered Worker",
      isLead: false,
      status: "idle",
      capabilities: [],
      maxTasks: 50,
    })
  ).id;
});

afterAll(() => closeDb());

const PATHS = ["defer-task wake-up", "reboot-sweep retry", "supersede resume"] as const;

describe("successor tasks carry unhandled steering", () => {
  test.each(
    PATHS,
  )("%s: a delivered, unaccepted steer appears in the successor text", async (path) => {
    const parent = await inProgressTask();
    const body = "Also relay the v12 result.\nKeep the second line verbatim.";
    const message = await steer(parent.id, body, "delivered");

    const text = await successorText(path, parent.id);

    expect(text).toContain(`## Unhandled steering from ${parent.id}`);
    expect(text).toContain(`[steering ${message.id}] From Steered Worker (agent):`);
    expect(text).toContain(body);
    expect(text).toContain("accept-steer");
  });

  test.each(PATHS)("%s: an accepted steer stays out of the successor text", async (path) => {
    const parent = await inProgressTask();
    const handled = await steer(parent.id, "Already acted on this one.", "handled");
    // An unaccepted sibling proves the section renders, so the exclusion
    // comes from the handled filter rather than from no section at all.
    const open = await steer(parent.id, "Still owed.", "delivered");

    const text = await successorText(path, parent.id);

    expect(text).toContain(`[steering ${open.id}]`);
    expect(text).not.toContain(handled.id);
    expect(text).not.toContain("Already acted on this one.");
  });

  test("a parent with only accepted steers gets no section", async () => {
    const parent = await inProgressTask();
    await steer(parent.id, "Already acted on this one.", "handled");

    const text = await successorText("supersede resume", parent.id);

    expect(text).not.toContain("Unhandled steering");
  });
});
