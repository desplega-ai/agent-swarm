import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getDbClient,
  getSteeringMessagesForTask,
  initDb,
  startTask,
} from "../be/db";
import { createUserServer } from "../server-user";
import { steerTaskHandler } from "../tools/steer-task";
import { ownerCtx, type ToolCtx } from "../tools/task-tool-ctx";
import { finalizeSwarmToolResult } from "../tools/utils";

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

async function runningClaudeTask(creatorAgentId?: string, requestedByUserId?: string) {
  const worker = await createAgent({
    name: "Claude steering worker",
    isLead: false,
    status: "busy",
    maxTasks: 10,
    harnessProvider: "claude",
  });
  const task = await createTaskExtended("steer this task", {
    agentId: worker.id,
    creatorAgentId,
    requestedByUserId,
  });
  expect((await startTask(task.id))?.status).toBe("in_progress");
  return task;
}

// steerTaskHandler returns the bare SwarmToolResult; the registrar's
// finalizeSwarmToolResult composes the actual wire CallToolResult
// (content/structuredContent/isError). Route through it here so these
// direct-handler tests assert the same contract the real MCP surface sends.
async function callSteer(ctx: ToolCtx, args: Parameters<typeof steerTaskHandler>[1]) {
  return finalizeSwarmToolResult("steer-task", await steerTaskHandler(ctx, args));
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

beforeEach(async () => {
  const db = getDbClient();
  await db.run("DELETE FROM task_steering_messages");
  await db.run("DELETE FROM agent_tasks");
  await db.run("DELETE FROM agents");
  await db.run("DELETE FROM users");
  delete process.env.RBAC_ENABLED;
});

describe("steer-task MCP tool", () => {
  test("defaults mode to queue and permits a lead or task creator but not an unrelated agent", async () => {
    const lead = await createAgent({
      name: "Steering lead",
      isLead: true,
      status: "busy",
      maxTasks: 10,
    });
    const creator = await createAgent({
      name: "Task creator",
      isLead: false,
      status: "busy",
      maxTasks: 10,
    });
    const unrelated = await createAgent({
      name: "Unrelated worker",
      isLead: false,
      status: "busy",
      maxTasks: 10,
    });
    const task = await runningClaudeTask(creator.id);

    const leadResult = await callSteer(ownerCtx({ agentId: lead.id }), {
      taskId: task.id,
      message: "finish the current turn safely",
    });
    // Registrar always emits exactly one text block ([message, details, nudge]
    // joined) — not the old multi-block content array.
    expect(leadResult.content).toHaveLength(1);
    expect(leadResult.isError).toBe(false);
    // message + details (JSON-rendered data) must both land in the text
    // channel — the payload keys spread at the TOP LEVEL of structuredContent.
    expect(leadResult.content[0]?.text).toContain("Queued for delivery.");
    expect(leadResult.content[0]?.text).toContain('"outcome":"queued"');
    expect(structured(leadResult)).toMatchObject({
      success: true,
      outcome: "queued",
      effectiveMode: "queue",
    });
    expect((await getSteeringMessagesForTask(task.id))[0]).toMatchObject({
      mode: "queue",
      source: "mcp",
      createdByKind: "agent",
      createdByAgentId: lead.id,
    });

    const denied = await callSteer(ownerCtx({ agentId: unrelated.id }), {
      taskId: task.id,
      message: "this must not be delivered",
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain("Only the lead or task creator");
    expect(structured(denied)).toMatchObject({ success: false });

    const creatorResult = await callSteer(ownerCtx({ agentId: creator.id }), {
      taskId: task.id,
      message: "creator follow-up",
    });
    expect(creatorResult.isError).toBe(false);
    expect(structured(creatorResult).success).toBe(true);
  });

  test("reports degraded output by default and returns an error when fail is requested", async () => {
    const lead = await createAgent({
      name: "Degrade lead",
      isLead: true,
      status: "busy",
      maxTasks: 10,
    });
    const task = await runningClaudeTask();

    const degraded = await callSteer(ownerCtx({ agentId: lead.id }), {
      taskId: task.id,
      message: "interrupt if possible",
      mode: "steer",
    });
    // Degraded-with-default is honest ok:true with the degradation surfaced
    // via degradedFrom, not a buried/dishonest failure.
    expect(degraded.isError).toBe(false);
    expect(structured(degraded)).toMatchObject({
      success: true,
      outcome: "queued",
      effectiveMode: "queue",
      degradedFrom: "steer",
      message: "Queued for delivery (requested steer; claude supports queue only).",
    });
    // content.text = [message, details, nudge].join("\n\n"); details carries
    // the JSON-rendered data payload appended after the human summary.
    expect(degraded.content).toHaveLength(1);
    expect(degraded.content[0]?.text).toStartWith(
      "Queued for delivery (requested steer; claude supports queue only).",
    );
    expect(degraded.content[0]?.text).toContain('"degradedFrom":"steer"');

    const failed = await callSteer(ownerCtx({ agentId: lead.id }), {
      taskId: task.id,
      message: "must interrupt now",
      mode: "steer",
      onUnsupported: "fail",
    });
    // fail-requested is a real toolErr: isError true, honest error text, and
    // structuredContent.success false — no more "typecheck_failed"-style
    // dishonest-ok reporting.
    expect(failed.isError).toBe(true);
    expect(structured(failed)).toMatchObject({ success: false });
    expect(failed.content[0]?.text).toContain("does not support steering mode 'steer'");
  });

  test("user surface admits the creator and denies a user without the steering grant", async () => {
    const owner = await createUser({ name: "Steering owner" });
    const task = await runningClaudeTask(undefined, owner.id);
    const handler = userToolHandler(createUserServer(owner));

    const allowed = (await handler(
      { taskId: task.id, message: "owner message", mode: "queue" },
      { sessionId: "steer-task-user-test", requestInfo: { headers: {} } },
    )) as { structuredContent?: unknown };
    expect(structured(allowed)).toMatchObject({ success: true, outcome: "queued" });

    await getDbClient().run(
      "DELETE FROM principal_roles WHERE principalType = 'user' AND principalId = ?",
      [owner.id],
    );
    process.env.RBAC_ENABLED = "true";
    const denied = (await handler(
      { taskId: task.id, message: "this must be denied", mode: "queue" },
      { sessionId: "steer-task-user-test", requestInfo: { headers: {} } },
    )) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(denied.isError).toBe(true);
    expect(denied.content?.[0]?.text).toContain("task.steer.own");
  });
});
