import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, deleteWorkflow, getWorkflow, initDb } from "../be/db";
import { registerCreateWorkflowTool } from "../tools/workflows/create-workflow";
import { registerUpdateWorkflowTool } from "../tools/workflows/update-workflow";
import type { WorkflowDefinition } from "../types";

const TEST_DB_PATH = "./test-workflow-mcp-trigger-schema.sqlite";

// ─── Test Harness ────────────────────────────────────────────
//
// Registers the create-workflow and update-workflow MCP tools on a fresh
// McpServer instance and exposes their internal handlers so we can call
// them directly the same way the MCP SDK does at runtime
// (handler(args, extra) when inputSchema is defined).

type RegisteredHandler = (args: unknown, extra: unknown) => Promise<unknown>;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: {
    success: boolean;
    message: string;
    workflow?: { id: string; triggerSchema?: Record<string, unknown> } & Record<string, unknown>;
    versionCreated?: number;
  };
};

function buildServerWithTools() {
  const server = new McpServer({
    name: "test-workflow-mcp-trigger-schema",
    version: "1.0.0",
  });
  registerCreateWorkflowTool(server);
  registerUpdateWorkflowTool(server);

  const registeredTools = (server as unknown as Record<string, unknown>)._registeredTools as Record<
    string,
    { handler: RegisteredHandler }
  >;

  return {
    callCreate: async (args: Record<string, unknown>, agentId = "agent-test") => {
      const tool = registeredTools["create-workflow"];
      expect(tool).toBeDefined();
      const extra = {
        sessionId: "session-test",
        requestInfo: { headers: { "x-agent-id": agentId } },
      };
      return (await tool.handler(args, extra)) as ToolResult;
    },
    callUpdate: async (args: Record<string, unknown>, agentId = "agent-test") => {
      const tool = registeredTools["update-workflow"];
      expect(tool).toBeDefined();
      const extra = {
        sessionId: "session-test",
        requestInfo: { headers: { "x-agent-id": agentId } },
      };
      return (await tool.handler(args, extra)) as ToolResult;
    },
  };
}

const minimalDefinition: WorkflowDefinition = {
  nodes: [
    {
      id: "step1",
      type: "agent-task",
      config: { template: "Hello" },
    },
  ],
};

const createdWorkflowIds: string[] = [];
let nameCounter = 0;
const uniqueName = (prefix: string) =>
  `${prefix}-${++nameCounter}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// ─── Tests ───────────────────────────────────────────────────

describe("MCP create-workflow / update-workflow accept triggerSchema", () => {
  let tools: ReturnType<typeof buildServerWithTools>;

  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist
    }
    initDb(TEST_DB_PATH);
    tools = buildServerWithTools();
  });

  afterAll(async () => {
    for (const id of createdWorkflowIds) {
      try {
        deleteWorkflow(id);
      } catch {
        // Already deleted
      }
    }
    closeDb();
    try {
      await unlink(TEST_DB_PATH);
      await unlink(`${TEST_DB_PATH}-wal`);
      await unlink(`${TEST_DB_PATH}-shm`);
    } catch {
      // Files may not exist
    }
  });

  // ─── create-workflow with triggerSchema ─────────────────────

  test("create-workflow with triggerSchema persists schema; getWorkflow returns identical object", async () => {
    const triggerSchema: Record<string, unknown> = {
      type: "object",
      required: ["pr"],
      properties: {
        pr: {
          type: "object",
          required: ["number"],
          properties: { number: { type: "number" } },
        },
      },
    };

    const result = await tools.callCreate({
      name: uniqueName("mcp-trigger-schema-create-with"),
      definition: minimalDefinition,
      triggerSchema,
    });

    expect(result.structuredContent?.success).toBe(true);
    const workflow = result.structuredContent?.workflow;
    expect(workflow).toBeDefined();
    expect(workflow!.id).toBeTruthy();
    createdWorkflowIds.push(workflow!.id);

    // Returned workflow contains the schema
    expect(workflow!.triggerSchema).toEqual(triggerSchema);

    // Persisted in DB and returned identically by getWorkflow
    const loaded = getWorkflow(workflow!.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.triggerSchema).toEqual(triggerSchema);
  });

  // ─── create-workflow without triggerSchema ──────────────────

  test("create-workflow without triggerSchema → returned triggerSchema is undefined", async () => {
    const result = await tools.callCreate({
      name: uniqueName("mcp-trigger-schema-create-without"),
      definition: minimalDefinition,
    });

    expect(result.structuredContent?.success).toBe(true);
    const workflow = result.structuredContent?.workflow;
    expect(workflow).toBeDefined();
    createdWorkflowIds.push(workflow!.id);

    expect(workflow!.triggerSchema).toBeUndefined();

    const loaded = getWorkflow(workflow!.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.triggerSchema).toBeUndefined();
  });

  // ─── update-workflow sets new triggerSchema ─────────────────

  test("update-workflow with new triggerSchema → persisted", async () => {
    const created = await tools.callCreate({
      name: uniqueName("mcp-trigger-schema-update-set"),
      definition: minimalDefinition,
    });
    const workflowId = created.structuredContent?.workflow?.id as string;
    expect(workflowId).toBeTruthy();
    createdWorkflowIds.push(workflowId);

    const newSchema: Record<string, unknown> = {
      type: "object",
      required: ["foo"],
      properties: { foo: { type: "string" } },
    };

    const updated = await tools.callUpdate({
      id: workflowId,
      triggerSchema: newSchema,
    });

    expect(updated.structuredContent?.success).toBe(true);
    expect(updated.structuredContent?.workflow?.triggerSchema).toEqual(newSchema);

    const loaded = getWorkflow(workflowId);
    expect(loaded).not.toBeNull();
    expect(loaded!.triggerSchema).toEqual(newSchema);
  });

  // ─── update-workflow with triggerSchema: null clears ────────

  test("update-workflow with triggerSchema: null → DB column NULL, returned as undefined", async () => {
    const initialSchema: Record<string, unknown> = {
      type: "object",
      required: ["a"],
      properties: { a: { type: "string" } },
    };

    const created = await tools.callCreate({
      name: uniqueName("mcp-trigger-schema-update-clear"),
      definition: minimalDefinition,
      triggerSchema: initialSchema,
    });
    const workflowId = created.structuredContent?.workflow?.id as string;
    expect(workflowId).toBeTruthy();
    createdWorkflowIds.push(workflowId);

    // Sanity: schema was set on create
    expect(created.structuredContent?.workflow?.triggerSchema).toEqual(initialSchema);

    const cleared = await tools.callUpdate({
      id: workflowId,
      triggerSchema: null,
    });

    expect(cleared.structuredContent?.success).toBe(true);
    expect(cleared.structuredContent?.workflow?.triggerSchema).toBeUndefined();

    const loaded = getWorkflow(workflowId);
    expect(loaded).not.toBeNull();
    expect(loaded!.triggerSchema).toBeUndefined();
  });
});
