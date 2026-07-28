import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getDb,
  getSteeringMessagesForTask,
  initDb,
  startTask,
} from "../be/db";
import { createUserServer } from "../server-user";
import { steerTaskHandler } from "../tools/steer-task";
import { ownerCtx } from "../tools/task-tool-ctx";

const TEST_DB_PATH = `/tmp/agent-swarm-steer-task-tool-${process.pid}.sqlite`;
const originalRbacEnabled = process.env.RBAC_ENABLED;

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
};

async function removeDbFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

function structured(result: { structuredContent?: unknown }) {
  return result.structuredContent as {
    success: boolean;
    outcome?: string;
    effectiveMode?: string;
    degradedFrom?: string;
    message: string;
  };
}

function runningClaudeTask(creatorAgentId?: string, requestedByUserId?: string) {
  const worker = createAgent({
    name: "Claude steering worker",
    isLead: false,
    status: "busy",
    maxTasks: 10,
    harnessProvider: "claude",
  });
  const task = createTaskExtended("steer this task", {
    agentId: worker.id,
    creatorAgentId,
    requestedByUserId,
  });
  expect(startTask(task.id)?.status).toBe("in_progress");
  return task;
}

function userToolHandler(server: McpServer) {
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = registered["steer-task"];
  if (!tool) throw new Error("steer-task was not registered on the user surface");
  return tool.handler;
}

const originalSteeringEnabled = process.env.STEERING_ENABLED;

beforeAll(async () => {
  process.env.STEERING_ENABLED = "true";
  await removeDbFiles();
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  if (originalSteeringEnabled === undefined) {
    delete process.env.STEERING_ENABLED;
  } else {
    process.env.STEERING_ENABLED = originalSteeringEnabled;
  }
  if (originalRbacEnabled === undefined) {
    delete process.env.RBAC_ENABLED;
  } else {
    process.env.RBAC_ENABLED = originalRbacEnabled;
  }
  await removeDbFiles();
});

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM task_steering_messages").run();
  db.prepare("DELETE FROM agent_tasks").run();
  db.prepare("DELETE FROM agents").run();
  db.prepare("DELETE FROM users").run();
  delete process.env.RBAC_ENABLED;
});

describe("steer-task MCP tool", () => {
  test("defaults mode to queue and permits a lead or task creator but not an unrelated agent", async () => {
    const lead = createAgent({ name: "Steering lead", isLead: true, status: "busy", maxTasks: 10 });
    const creator = createAgent({
      name: "Task creator",
      isLead: false,
      status: "busy",
      maxTasks: 10,
    });
    const unrelated = createAgent({
      name: "Unrelated worker",
      isLead: false,
      status: "busy",
      maxTasks: 10,
    });
    const task = runningClaudeTask(creator.id);

    const leadResult = await steerTaskHandler(ownerCtx({ agentId: lead.id }), {
      taskId: task.id,
      message: "finish the current turn safely",
    });
    expect(leadResult.content).toHaveLength(2);
    expect(structured(leadResult)).toMatchObject({
      success: true,
      outcome: "queued",
      effectiveMode: "queue",
    });
    expect(getSteeringMessagesForTask(task.id)[0]).toMatchObject({
      mode: "queue",
      source: "mcp",
      createdByKind: "agent",
      createdByAgentId: lead.id,
    });

    const denied = await steerTaskHandler(ownerCtx({ agentId: unrelated.id }), {
      taskId: task.id,
      message: "this must not be delivered",
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain("Only the lead or task creator");

    const creatorResult = await steerTaskHandler(ownerCtx({ agentId: creator.id }), {
      taskId: task.id,
      message: "creator follow-up",
    });
    expect(structured(creatorResult).success).toBe(true);
  });

  test("reports degraded output by default and returns an error when fail is requested", async () => {
    const lead = createAgent({ name: "Degrade lead", isLead: true, status: "busy", maxTasks: 10 });
    const task = runningClaudeTask();

    const degraded = await steerTaskHandler(ownerCtx({ agentId: lead.id }), {
      taskId: task.id,
      message: "interrupt if possible",
      mode: "steer",
    });
    expect(structured(degraded)).toMatchObject({
      success: true,
      outcome: "queued",
      effectiveMode: "queue",
      degradedFrom: "steer",
    });
    expect(degraded.content[0]?.text).toBe(
      "Queued for delivery (requested steer; claude supports queue only).",
    );

    const failed = await steerTaskHandler(ownerCtx({ agentId: lead.id }), {
      taskId: task.id,
      message: "must interrupt now",
      mode: "steer",
      onUnsupported: "fail",
    });
    expect(failed.isError).toBe(true);
    expect(structured(failed)).toMatchObject({ success: false });
    expect(failed.content[0]?.text).toContain("does not support steering mode 'steer'");
  });

  test("user surface admits the creator and denies a user without the steering grant", async () => {
    const owner = createUser({ name: "Steering owner" });
    const task = runningClaudeTask(undefined, owner.id);
    const handler = userToolHandler(createUserServer(owner));

    const allowed = (await handler(
      { taskId: task.id, message: "owner message", mode: "queue" },
      { sessionId: "steer-task-user-test", requestInfo: { headers: {} } },
    )) as { structuredContent?: unknown };
    expect(structured(allowed)).toMatchObject({ success: true, outcome: "queued" });

    getDb()
      .prepare("DELETE FROM principal_roles WHERE principalType = 'user' AND principalId = ?")
      .run(owner.id);
    process.env.RBAC_ENABLED = "true";
    const denied = (await handler(
      { taskId: task.id, message: "this must be denied", mode: "queue" },
      { sessionId: "steer-task-user-test", requestInfo: { headers: {} } },
    )) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(denied.isError).toBe(true);
    expect(denied.content?.[0]?.text).toContain("task.steer.own");
  });
});
