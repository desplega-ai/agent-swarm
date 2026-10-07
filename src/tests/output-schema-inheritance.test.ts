import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  failTask,
  getDbClient,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";
import { createWorkerTaskFollowUp } from "../tasks/worker-follow-up";
import { registerSendTaskTool } from "../tools/send-task";

// A worker's outputSchema is the contract for that worker's own result. Lead
// tasks that review the result must not inherit it; delegated children of the
// same work still do.

type Tool = { handler: (args: unknown, extra: unknown) => Promise<CallToolResult> };

const WORKER_SCHEMA = {
  type: "object",
  properties: { prs: { type: "array", items: { type: "string" } } },
  required: ["prs"],
};

let leadId: string;
let workerId: string;
let sendTask: Tool;

async function workerTaskWithSchema(description: string) {
  const task = await createTaskExtended(description, {
    agentId: workerId,
    outputSchema: WORKER_SCHEMA,
  });
  await startTask(task.id);
  return task;
}

beforeAll(() => {
  initDb(":memory:");
  const server = new McpServer({ name: "output-schema-inheritance", version: "1.0.0" });
  registerSendTaskTool(server);
  const tools = (server as unknown as { _registeredTools: Record<string, Tool> })._registeredTools;
  sendTask = tools["send-task"]!;
});

beforeEach(async () => {
  const db = getDbClient();
  await db.run("DELETE FROM agent_tasks");
  await db.run("DELETE FROM agents");
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

describe("Lead follow-up of a schema-carrying worker task", () => {
  test("completed: the follow-up carries no outputSchema", async () => {
    const task = await workerTaskWithSchema("worker task with a contract");
    const completed = await completeTask(task.id, JSON.stringify({ prs: ["#1"] }));
    const followUp = await createWorkerTaskFollowUp({
      task: completed!,
      status: "completed",
      output: JSON.stringify({ prs: ["#1"] }),
    });
    expect(followUp).not.toBeNull();
    expect(followUp!.parentTaskId).toBe(task.id);
    expect(followUp!.agentId).toBe(leadId);
    expect((await getTaskById(followUp!.id))?.outputSchema).toBeUndefined();
  });

  test("failed: the follow-up carries no outputSchema", async () => {
    const task = await workerTaskWithSchema("worker task that fails");
    const failed = await failTask(task.id, "checks ran and failed");
    const followUp = await createWorkerTaskFollowUp({
      task: failed!,
      status: "failed",
      failureReason: "checks ran and failed",
    });
    expect(followUp).not.toBeNull();
    expect((await getTaskById(followUp!.id))?.outputSchema).toBeUndefined();
  });
});

describe("kept: children of the same work still inherit outputSchema", () => {
  test("send-task child of a schema-carrying parent", async () => {
    const parent = await workerTaskWithSchema("parent work with a contract");
    const result = await sendTask.handler(
      {
        task: "a delegated slice of the same work",
        agentId: workerId,
        routingReason: "skill",
        routingNote: "worker owns this area of the codebase",
        parentTaskId: parent.id,
      },
      { sessionId: crypto.randomUUID(), requestInfo: { headers: { "x-agent-id": leadId } } },
    );
    const structured = result.structuredContent as { success: boolean; task?: { id: string } };
    expect(structured.success).toBe(true);
    expect((await getTaskById(structured.task!.id))?.outputSchema).toEqual(WORKER_SCHEMA);
  });

  test("an explicit outputSchema still wins over the opt-out", async () => {
    const parent = await workerTaskWithSchema("parent work");
    const own = { type: "object", properties: { ok: { type: "boolean" } } };
    const child = await createTaskExtended("child with its own contract", {
      parentTaskId: parent.id,
      outputSchema: own,
      inheritParentOutputSchema: false,
    });
    expect((await getTaskById(child.id))?.outputSchema).toEqual(own);
  });
});
