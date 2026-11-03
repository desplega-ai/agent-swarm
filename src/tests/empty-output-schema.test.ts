import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDbClient,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";
import { buildPromptForTrigger } from "../commands/runner";
import { getTaskOutputValidationError } from "../tasks/terminal-result-guard";
import { registerSendTaskTool } from "../tools/send-task";

// An explicit empty `outputSchema: {}` means "no output schema". Rendering it
// as a contract made workers complete with the literal output "{}".

type Tool = { handler: (args: unknown, extra: unknown) => Promise<CallToolResult> };

const SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
};
const TASK_ID = "00000000-0000-4000-8000-0000000000aa";

let leadId: string;
let workerId: string;
let sendTask: Tool;

async function storedSchema(taskId: string): Promise<string | null> {
  const row = await getDbClient().get<{ outputSchema: string | null }>(
    "SELECT outputSchema FROM agent_tasks WHERE id = ?",
    [taskId],
  );
  return row?.outputSchema ?? null;
}

async function leadTaskWithSchema() {
  const task = await createTaskExtended("lead work with a contract", {
    agentId: leadId,
    outputSchema: SCHEMA,
  });
  await startTask(task.id);
  return task;
}

async function send(args: Record<string, unknown>, sourceTaskId?: string) {
  const headers: Record<string, string> = { "x-agent-id": leadId };
  if (sourceTaskId) headers["x-source-task-id"] = sourceTaskId;
  const result = await sendTask.handler(
    {
      task: "delegated work",
      agentId: workerId,
      routingReason: "skill",
      routingNote: "worker owns this area",
      ...args,
    },
    { sessionId: crypto.randomUUID(), requestInfo: { headers } },
  );
  const structured = result.structuredContent as { success: boolean; task?: { id: string } };
  expect(structured.success).toBe(true);
  return structured.task!.id;
}

beforeAll(() => {
  initDb(":memory:");
  const server = new McpServer({ name: "empty-output-schema", version: "1.0.0" });
  registerSendTaskTool(server);
  const tools = (server as unknown as { _registeredTools: Record<string, Tool> })._registeredTools;
  sendTask = tools["send-task"]!;
});

beforeEach(async () => {
  const db = getDbClient();
  await db.run("DELETE FROM agent_tasks");
  await db.run("DELETE FROM agents");
  const base = { status: "idle" as const, capabilities: [], maxTasks: 50 };
  leadId = (await createAgent({ ...base, name: "Lead", isLead: true })).id;
  workerId = (await createAgent({ ...base, name: "Worker", isLead: false })).id;
});

afterAll(() => closeDb());

describe("create: outputSchema {} stores NULL and inherits nothing", () => {
  test("send-task with {} and an explicit schema-carrying parent", async () => {
    const parent = await leadTaskWithSchema();
    const childId = await send({ parentTaskId: parent.id, outputSchema: {} });
    expect(await storedSchema(childId)).toBeNull();
    expect((await getTaskById(childId))?.outputSchema).toBeUndefined();
  });

  test("send-task with {} from a caller whose current task has a schema", async () => {
    const caller = await leadTaskWithSchema();
    const childId = await send({ outputSchema: {} }, caller.id);
    expect((await getTaskById(childId))?.parentTaskId).toBe(caller.id);
    expect(await storedSchema(childId)).toBeNull();
  });

  test("createTaskExtended with {} and no parent stores NULL", async () => {
    const task = await createTaskExtended("no parent", { agentId: workerId, outputSchema: {} });
    expect(await storedSchema(task.id)).toBeNull();
  });
});

describe("unchanged: omitted inherits, non-empty is kept", () => {
  test("omitted outputSchema inherits the caller's schema", async () => {
    const caller = await leadTaskWithSchema();
    const childId = await send({}, caller.id);
    expect((await getTaskById(childId))?.outputSchema).toEqual(SCHEMA);
  });

  test("a non-empty outputSchema is stored as given", async () => {
    const own = { type: "object", properties: { ok: { type: "boolean" } } };
    const childId = await send({ outputSchema: own });
    expect(JSON.parse((await storedSchema(childId))!)).toEqual(own);
    expect((await getTaskById(childId))?.outputSchema).toEqual(own);
  });
});

describe("legacy rows holding '{}' run as if they had no schema", () => {
  async function legacyTask() {
    const task = await createTaskExtended("legacy task", { agentId: workerId });
    await getDbClient().run("UPDATE agent_tasks SET outputSchema = '{}' WHERE id = ?", [task.id]);
    expect(await storedSchema(task.id)).toBe("{}");
    return task;
  }

  test("the task reads back with no outputSchema", async () => {
    const task = await legacyTask();
    expect((await getTaskById(task.id))?.outputSchema).toBeUndefined();
  });

  test("a resume child of a '{}' task stores NULL", async () => {
    const task = await legacyTask();
    const child = await createTaskExtended("Resume task: check CI", {
      agentId: workerId,
      parentTaskId: task.id,
    });
    expect(await storedSchema(child.id)).toBeNull();
  });

  test("completion accepts free text", () => {
    expect(getTaskOutputValidationError({}, "Approved the PR.")).toBeUndefined();
    expect(getTaskOutputValidationError({}, undefined)).toBeUndefined();
    expect(getTaskOutputValidationError(SCHEMA, "Approved the PR.")).toContain("valid JSON");
  });

  test("the harness prompt carries no Required Output Format", async () => {
    const prompt = (outputSchema: unknown) =>
      buildPromptForTrigger(
        { type: "task_assigned", taskId: TASK_ID, task: { id: TASK_ID, task: "x", outputSchema } },
        "",
      );
    expect(await prompt({})).not.toContain("Required Output Format");
    expect(await prompt(SCHEMA)).toContain("Required Output Format");
  });
});
