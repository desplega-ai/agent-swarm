import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, deleteWorkflow, getWorkflow, initDb } from "../be/db";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { handleWorkflows } from "../http/workflows";
import { registerCreateWorkflowTool } from "../tools/workflows/create-workflow";
import { registerPatchWorkflowTool } from "../tools/workflows/patch-workflow";
import { registerTriggerWorkflowTool } from "../tools/workflows/trigger-workflow";
import { registerUpdateWorkflowTool } from "../tools/workflows/update-workflow";
import type { Workflow, WorkflowDefinition } from "../types";
import { initWorkflows, stopRetryPoller } from "../workflows";

const TEST_DB_PATH = "./test-workflow-mcp-trigger-schema.sqlite";
const TEST_PORT = 13031;

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
    runId?: string;
    skipped?: boolean;
    validationErrors?: string[];
    triggerSchema?: Record<string, unknown>;
  };
};

function buildServerWithTools() {
  const server = new McpServer({
    name: "test-workflow-mcp-trigger-schema",
    version: "1.0.0",
  });
  registerCreateWorkflowTool(server);
  registerUpdateWorkflowTool(server);
  registerPatchWorkflowTool(server);
  registerTriggerWorkflowTool(server);

  const registeredTools = (server as unknown as Record<string, unknown>)._registeredTools as Record<
    string,
    { handler: RegisteredHandler }
  >;

  const callTool =
    (name: string) =>
    async (args: Record<string, unknown>, agentId = "agent-test") => {
      const tool = registeredTools[name];
      expect(tool).toBeDefined();
      const extra = {
        sessionId: "session-test",
        requestInfo: { headers: { "x-agent-id": agentId } },
      };
      return (await tool.handler(args, extra)) as ToolResult;
    };

  return {
    callCreate: callTool("create-workflow"),
    callUpdate: callTool("update-workflow"),
    callPatch: callTool("patch-workflow"),
    callTrigger: callTool("trigger-workflow"),
  };
}

// ─── HTTP Test Server ────────────────────────────────────────

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    const handled = await handleWorkflows(req, res, pathSegments, queryParams, myAgentId);
    if (!handled) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });
}

const httpHeaders = {
  "Content-Type": "application/json",
  "X-Agent-ID": crypto.randomUUID(),
};

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

describe("MCP create-workflow / update-workflow / patch-workflow accept triggerSchema", () => {
  let tools: ReturnType<typeof buildServerWithTools>;
  let server: Server;

  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist
    }
    initDb(TEST_DB_PATH);
    initWorkflows();
    tools = buildServerWithTools();
    server = createTestServer();
    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT, () => resolve());
    });
  });

  afterAll(async () => {
    stopRetryPoller();
    await new Promise<void>((resolve) => server.close(() => resolve()));
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

  // ─── patch-workflow with triggerSchema only (no DAG ops) ────

  test("patch-workflow with triggerSchema only → schema persisted, definition unchanged", async () => {
    const created = await tools.callCreate({
      name: uniqueName("mcp-trigger-schema-patch-only"),
      definition: minimalDefinition,
    });
    const workflowId = created.structuredContent?.workflow?.id as string;
    expect(workflowId).toBeTruthy();
    createdWorkflowIds.push(workflowId);
    const originalDefinition = getWorkflow(workflowId)?.definition;
    expect(originalDefinition).toBeDefined();

    const newSchema: Record<string, unknown> = {
      type: "object",
      required: ["pr"],
      properties: { pr: { type: "object" } },
    };

    const patched = await tools.callPatch({ id: workflowId, triggerSchema: newSchema });
    expect(patched.structuredContent?.success).toBe(true);
    expect(patched.structuredContent?.workflow?.triggerSchema).toEqual(newSchema);

    // Definition unchanged by a metadata-only patch
    const loaded = getWorkflow(workflowId);
    expect(loaded?.definition).toEqual(originalDefinition!);
    expect(loaded?.triggerSchema).toEqual(newSchema);
  });

  // ─── patch-workflow with both DAG ops AND triggerSchema ─────

  test("patch-workflow with DAG create AND triggerSchema → both applied", async () => {
    const created = await tools.callCreate({
      name: uniqueName("mcp-trigger-schema-patch-both"),
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

    // Single PATCH applies both a DAG op (create new node, chain it after step1)
    // and a metadata change (triggerSchema)
    const patched = await tools.callPatch({
      id: workflowId,
      create: [{ id: "extra", type: "agent-task", config: { template: "extra-step" } }],
      update: [{ nodeId: "step1", node: { next: "extra" } }],
      triggerSchema: newSchema,
    });
    expect(patched.structuredContent?.success).toBe(true);

    const loaded = getWorkflow(workflowId);
    expect(loaded?.triggerSchema).toEqual(newSchema);
    expect(loaded?.definition.nodes).toHaveLength(2);
    const nodeIds = loaded?.definition.nodes.map((n) => n.id).sort();
    expect(nodeIds).toEqual(["extra", "step1"]);
  });

  // ─── patch-workflow with triggerSchema: null clears ─────────

  test("patch-workflow with triggerSchema: null → cleared", async () => {
    const initialSchema: Record<string, unknown> = {
      type: "object",
      required: ["a"],
      properties: { a: { type: "string" } },
    };

    const created = await tools.callCreate({
      name: uniqueName("mcp-trigger-schema-patch-clear"),
      definition: minimalDefinition,
      triggerSchema: initialSchema,
    });
    const workflowId = created.structuredContent?.workflow?.id as string;
    expect(workflowId).toBeTruthy();
    createdWorkflowIds.push(workflowId);
    expect(getWorkflow(workflowId)?.triggerSchema).toEqual(initialSchema);

    const cleared = await tools.callPatch({ id: workflowId, triggerSchema: null });
    expect(cleared.structuredContent?.success).toBe(true);
    expect(cleared.structuredContent?.workflow?.triggerSchema).toBeUndefined();

    const loaded = getWorkflow(workflowId);
    expect(loaded?.triggerSchema).toBeUndefined();
  });

  // ─── HTTP PATCH /api/workflows/{id} with triggerSchema ──────

  test("HTTP PATCH /api/workflows/{id} with { triggerSchema } → 200, persisted", async () => {
    // Seed via HTTP POST so this test exercises the HTTP layer end-to-end
    const createRes = await fetch(`http://localhost:${TEST_PORT}/api/workflows`, {
      method: "POST",
      headers: httpHeaders,
      body: JSON.stringify({
        name: uniqueName("http-patch-trigger-schema"),
        definition: minimalDefinition,
      }),
    });
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as Workflow;
    createdWorkflowIds.push(createBody.id);

    const newSchema: Record<string, unknown> = {
      type: "object",
      required: ["pr"],
      properties: { pr: { type: "object" } },
    };

    const patchRes = await fetch(`http://localhost:${TEST_PORT}/api/workflows/${createBody.id}`, {
      method: "PATCH",
      headers: httpHeaders,
      body: JSON.stringify({ triggerSchema: newSchema }),
    });

    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as Workflow;
    expect(patchBody.triggerSchema).toEqual(newSchema);

    // Verify persistence at the DB layer
    const loaded = getWorkflow(createBody.id);
    expect(loaded?.triggerSchema).toEqual(newSchema);
  });

  // ─── Phase 3: trigger-workflow surfaces TriggerSchemaError ──

  test("trigger-workflow with missing required field → structured TriggerSchemaError", async () => {
    const triggerSchema: Record<string, unknown> = {
      type: "object",
      required: ["foo"],
      properties: { foo: { type: "string" } },
    };

    const created = await tools.callCreate({
      name: uniqueName("mcp-trigger-error-missing"),
      definition: minimalDefinition,
      triggerSchema,
    });
    const workflowId = created.structuredContent?.workflow?.id as string;
    expect(workflowId).toBeTruthy();
    createdWorkflowIds.push(workflowId);

    const triggered = await tools.callTrigger({ id: workflowId, triggerData: {} });

    // Structured signal: not success, validationErrors carries the validator output verbatim,
    // triggerSchema is echoed for self-correction.
    expect(triggered.structuredContent?.success).toBe(false);
    expect(triggered.structuredContent?.runId).toBeUndefined();
    expect(triggered.structuredContent?.validationErrors).toEqual([
      'root: missing required property "foo"',
    ]);
    expect(triggered.structuredContent?.triggerSchema).toEqual(triggerSchema);

    // Human-facing text contains the exact validator phrase from json-schema-validator.ts:39
    const text = triggered.content[0]?.text ?? "";
    expect(text).toContain('root: missing required property "foo"');
    // Failing field name appears
    expect(text).toContain("foo");
    // No leaked stack trace or generic Failed: prefix
    expect(text).not.toContain("Failed:");
    expect(text).not.toMatch(/^Error:/);
    expect(text).not.toContain("at ");
    // Schema is echoed for the agent to self-correct
    expect(text).toContain('"required"');
    expect(text).toContain('"foo"');
  });

  test("trigger-workflow with type-mismatched payload → structured TriggerSchemaError", async () => {
    const triggerSchema: Record<string, unknown> = {
      type: "object",
      required: ["foo"],
      properties: { foo: { type: "string" } },
    };

    const created = await tools.callCreate({
      name: uniqueName("mcp-trigger-error-type"),
      definition: minimalDefinition,
      triggerSchema,
    });
    const workflowId = created.structuredContent?.workflow?.id as string;
    expect(workflowId).toBeTruthy();
    createdWorkflowIds.push(workflowId);

    const triggered = await tools.callTrigger({ id: workflowId, triggerData: { foo: 42 } });

    expect(triggered.structuredContent?.success).toBe(false);
    expect(triggered.structuredContent?.runId).toBeUndefined();
    expect(triggered.structuredContent?.validationErrors).toEqual([
      'foo: expected type "string", got number',
    ]);
    expect(triggered.structuredContent?.triggerSchema).toEqual(triggerSchema);

    const text = triggered.content[0]?.text ?? "";
    // Exact validator phrase from json-schema-validator.ts:29
    expect(text).toContain('foo: expected type "string", got number');
    // Failing field name appears
    expect(text).toContain("foo");
    // No leaked stack trace or generic Failed: prefix
    expect(text).not.toContain("Failed:");
    expect(text).not.toMatch(/^Error:/);
    expect(text).not.toContain("at ");
  });

  // ─── Phase 3.5: HTTP 400 contract for TriggerSchemaError ────

  test("HTTP POST /api/workflows/{id}/trigger with bad payload → 400 { error, message, details[] }", async () => {
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

    // Seed via MCP create-workflow so we don't reimplement validation hoops here
    const created = await tools.callCreate({
      name: uniqueName("http-trigger-400-contract"),
      definition: minimalDefinition,
      triggerSchema,
    });
    const workflowId = created.structuredContent?.workflow?.id as string;
    expect(workflowId).toBeTruthy();
    createdWorkflowIds.push(workflowId);

    const res = await fetch(`http://localhost:${TEST_PORT}/api/workflows/${workflowId}/trigger`, {
      method: "POST",
      headers: httpHeaders,
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      message: string;
      details: string[];
    };
    // Frozen contract — tester (FE) reads these field names verbatim
    expect(body.error).toBe("TriggerSchemaError");
    expect(typeof body.message).toBe("string");
    expect(body.message).toContain("Trigger schema validation failed");
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details).toEqual(['root: missing required property "pr"']);
  });

  // ─── /trigger/validate dry-run ──────────────────────────────

  test("HTTP POST /trigger/validate with passing payload → 200 { valid: true }", async () => {
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
    const created = await tools.callCreate({
      name: uniqueName("http-trigger-validate-pass"),
      definition: minimalDefinition,
      triggerSchema,
    });
    const workflowId = created.structuredContent?.workflow?.id as string;
    expect(workflowId).toBeTruthy();
    createdWorkflowIds.push(workflowId);

    const res = await fetch(
      `http://localhost:${TEST_PORT}/api/workflows/${workflowId}/trigger/validate`,
      {
        method: "POST",
        headers: httpHeaders,
        body: JSON.stringify({ pr: { number: 42 } }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid: boolean };
    expect(body.valid).toBe(true);
  });

  test("HTTP POST /trigger/validate with failing payload → 400 + frozen contract", async () => {
    const triggerSchema: Record<string, unknown> = {
      type: "object",
      required: ["pr"],
      properties: { pr: { type: "object" } },
    };
    const created = await tools.callCreate({
      name: uniqueName("http-trigger-validate-fail"),
      definition: minimalDefinition,
      triggerSchema,
    });
    const workflowId = created.structuredContent?.workflow?.id as string;
    expect(workflowId).toBeTruthy();
    createdWorkflowIds.push(workflowId);

    const res = await fetch(
      `http://localhost:${TEST_PORT}/api/workflows/${workflowId}/trigger/validate`,
      {
        method: "POST",
        headers: httpHeaders,
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string; details: string[] };
    expect(body.error).toBe("TriggerSchemaError");
    expect(body.details).toEqual(['root: missing required property "pr"']);
  });

  test("HTTP POST /trigger/validate on workflow without schema → 200 { valid: true, schema: null }", async () => {
    const created = await tools.callCreate({
      name: uniqueName("http-trigger-validate-noschema"),
      definition: minimalDefinition,
    });
    const workflowId = created.structuredContent?.workflow?.id as string;
    expect(workflowId).toBeTruthy();
    createdWorkflowIds.push(workflowId);

    const res = await fetch(
      `http://localhost:${TEST_PORT}/api/workflows/${workflowId}/trigger/validate`,
      {
        method: "POST",
        headers: httpHeaders,
        body: JSON.stringify({ anything: "goes" }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid: boolean; schema: null };
    expect(body.valid).toBe(true);
    expect(body.schema).toBe(null);
  });
});
