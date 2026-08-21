import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { closeDb, createAgent, createTaskExtended, createUser, initDb } from "../be/db";
import { registerCreatePageTool } from "../tools/create-page";
import { registerCreateScheduleTool } from "../tools/schedules/create-schedule";
import { registerSendTaskTool } from "../tools/send-task";
import { registerTaskActionTool } from "../tools/task-action";
import { registerCreateWorkflowTool } from "../tools/workflows/create-workflow";

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
};

function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
  agentId: string,
  sourceTaskId?: string,
): Promise<CallToolResult> {
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = registered[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  const headers: Record<string, string> = { "x-agent-id": agentId };
  if (sourceTaskId) headers["x-source-task-id"] = sourceTaskId;
  return tool.handler(args, { sessionId: "asset-key-test", requestInfo: { headers } });
}

let agentId: string;
let targetAgentId: string;
let userId: string;
let otherUserId: string;
let sourceTaskId: string;

beforeAll(async () => {
  initDb("./test-asset-key-mcp.sqlite");
  agentId = (
    await createAgent({
      name: "asset-key-caller",
      isLead: false,
      status: "busy",
      maxTasks: 10,
    })
  ).id;
  targetAgentId = (
    await createAgent({
      name: "asset-key-target",
      isLead: false,
      status: "idle",
      maxTasks: 10,
    })
  ).id;
  userId = (await createUser({ name: "MCP Namespace User", email: "mcp-namespace@example.com" }))
    .id;
  otherUserId = (await createUser({ name: "Other MCP User", email: "mcp-other@example.com" })).id;
  sourceTaskId = (
    await createTaskExtended("trusted MCP source", {
      agentId,
      requestedByUserId: userId,
      key: `personal/${userId}/work/`,
    })
  ).id;
});

afterAll(() => closeDb());

describe("asset namespace MCP exposure", () => {
  test("send-task inherits the source namespace and rejects a mismatched personal user", async () => {
    const server = new McpServer({ name: "asset-key-send", version: "1.0.0" });
    registerSendTaskTool(server);

    const inherited = await callTool(
      server,
      "send-task",
      {
        agentId: targetAgentId,
        task: `inherited namespace ${Date.now()}`,
        allowDuplicate: true,
      },
      agentId,
      sourceTaskId,
    );
    const inheritedTask = (inherited.structuredContent as { task?: { key: string } }).task;
    expect(inheritedTask?.key).toBe(`personal/${userId}/work/`);

    const denied = await callTool(
      server,
      "send-task",
      {
        agentId: targetAgentId,
        task: `wrong namespace ${Date.now()}`,
        key: `personal/${otherUserId}/drafts/`,
        allowDuplicate: true,
      },
      agentId,
      sourceTaskId,
    );
    expect((denied.structuredContent as { success: boolean }).success).toBe(false);
    expect((denied.structuredContent as { message: string }).message).toContain("trusted user");
  });

  test("task-action create accepts a trusted personal namespace", async () => {
    const server = new McpServer({ name: "asset-key-action", version: "1.0.0" });
    registerTaskActionTool(server);
    const result = await callTool(
      server,
      "task-action",
      {
        action: "create",
        task: `pool namespace ${Date.now()}`,
        key: `personal/${userId}/queue/`,
      },
      agentId,
      sourceTaskId,
    );
    expect((result.structuredContent as { success: boolean }).success).toBe(true);
    expect((result.structuredContent as { task?: { key: string } }).task?.key).toBe(
      `personal/${userId}/queue/`,
    );
  });

  test("workflow, schedule, and page create tools expose their namespace", async () => {
    const server = new McpServer({ name: "asset-key-assets", version: "1.0.0" });
    registerCreateWorkflowTool(server);
    registerCreateScheduleTool(server);
    registerCreatePageTool(server);
    const key = `personal/${userId}/automation/`;

    const workflow = await callTool(
      server,
      "create-workflow",
      {
        name: `mcp-workflow-${Date.now()}`,
        key,
        definition: {
          nodes: [{ id: "task", type: "agent-task", config: { template: "work" } }],
        },
      },
      agentId,
      sourceTaskId,
    );
    expect((workflow.structuredContent as { workflow?: { key: string } }).workflow?.key).toBe(key);

    const schedule = await callTool(
      server,
      "create-schedule",
      {
        name: `mcp-schedule-${Date.now()}`,
        key,
        intervalMs: 60_000,
        taskTemplate: "scheduled work",
      },
      agentId,
      sourceTaskId,
    );
    expect((schedule.structuredContent as { schedule?: { key: string } }).schedule?.key).toBe(key);

    const page = await callTool(
      server,
      "create_page",
      {
        title: `MCP Page ${Date.now()}`,
        key,
        body: "<p>ok</p>",
        contentType: "text/html",
        authMode: "authed",
      },
      agentId,
      sourceTaskId,
    );
    expect((page.structuredContent as { key?: string }).key).toBe(key);
  });
});
