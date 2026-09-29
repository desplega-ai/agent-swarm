import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, getDbClient, getWorkflow, initDb, upsertSwarmConfig } from "../be/db";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { handleWorkflows } from "../http/workflows";
import { registerCreateWorkflowTool } from "../tools/workflows/create-workflow";
import { registerPatchWorkflowTool } from "../tools/workflows/patch-workflow";
import { registerPatchWorkflowNodeTool } from "../tools/workflows/patch-workflow-node";
import { registerUpdateWorkflowTool } from "../tools/workflows/update-workflow";
import type { Workflow, WorkflowDefinition } from "../types";
import { initWorkflows, stopRetryPoller } from "../workflows";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-workflow-system-one-decision-save-warnings.sqlite";
const KEY_VALUE = "tsk_example-save-warning-key.0123456789";

// ─── MCP harness (same shape as workflow-mcp-trigger-schema.test.ts) ─────────

type ToolResult = {
  structuredContent?: {
    success: boolean;
    message: string;
    details?: string;
    warnings?: string[];
    workflow?: { id: string; definition: WorkflowDefinition } & Record<string, unknown>;
  };
};

function buildTools() {
  const server = new McpServer({
    name: "test-workflow-system-one-decision-save-warnings",
    version: "1.0.0",
  });
  registerCreateWorkflowTool(server);
  registerUpdateWorkflowTool(server);
  registerPatchWorkflowTool(server);
  registerPatchWorkflowNodeTool(server);
  const registered = (server as unknown as Record<string, unknown>)._registeredTools as Record<
    string,
    { handler: (args: unknown, extra: unknown) => Promise<unknown> }
  >;
  const call = (name: string) => async (args: Record<string, unknown>) => {
    const tool = registered[name];
    expect(tool).toBeDefined();
    const extra = {
      sessionId: "session-test",
      requestInfo: { headers: { "x-agent-id": "agent-test" } },
    };
    return (await tool?.handler(args, extra)) as ToolResult;
  };
  return {
    create: call("create-workflow"),
    update: call("update-workflow"),
    patch: call("patch-workflow"),
    patchNode: call("patch-workflow-node"),
  };
}

// ─── HTTP harness ────────────────────────────────────────────────────────────

let baseUrl = "";
const headers = { "Content-Type": "application/json", "X-Agent-ID": crypto.randomUUID() };

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    const handled = await handleWorkflows(
      req,
      res,
      getPathSegments(req.url || ""),
      parseQueryParams(req.url || ""),
      req.headers["x-agent-id"] as string | undefined,
    );
    if (!handled) {
      res.writeHead(404);
      res.end("{}");
    }
  });
}

async function http(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Workflow & { warnings?: string[] } };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const systemOneConfig = (overrides: Record<string, unknown> = {}) => ({
  state: "{{lead}}",
  questions: { fit: { type: "noul", instructions: "Is this a real lead?" } },
  returns: { fit: { type: "noul" } },
  ...overrides,
});

const plainDefinition = (): WorkflowDefinition => ({
  nodes: [{ id: "step", type: "agent-task", config: { template: "Hello" } }],
});

const systemOneDefinition = (config: Record<string, unknown> = {}): WorkflowDefinition => ({
  nodes: [
    {
      id: "qualify",
      type: "system-one-decision",
      inputs: { lead: "trigger.lead" },
      config: systemOneConfig(config),
    },
  ],
});

let nameCounter = 0;
const uniqueName = () => `system-one-save-${++nameCounter}-${Date.now()}`;

const setTypeSafeKey = () =>
  upsertSwarmConfig({
    scope: "global",
    key: "TYPESAFE_API_KEY",
    value: KEY_VALUE,
    isSecret: true,
  });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("saving a workflow whose system-one-decision node has no working key", () => {
  let tools: ReturnType<typeof buildTools>;
  let server: Server;
  let savedOpenRouterKey: string | undefined;

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) await unlink(TEST_DB_PATH + suffix).catch(() => {});
    initDb(TEST_DB_PATH);
    await initWorkflows();
    tools = buildTools();
    server = createTestServer();
    baseUrl = `http://localhost:${await listenOnFreePort(server)}`;
  });

  afterAll(async () => {
    stopRetryPoller();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) await unlink(TEST_DB_PATH + suffix).catch(() => {});
  });

  beforeEach(async () => {
    savedOpenRouterKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    await getDbClient().run(
      "DELETE FROM swarm_config WHERE key IN ('TYPESAFE_API_KEY', 'LAYA_URL', 'LAYA_API_KEY')",
    );
  });

  afterEach(() => {
    if (savedOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
  });

  // The save is never blocked. The run-start check is the guarantee, so a
  // definition can be saved before a human has supplied the key.

  test("create-workflow saves and warns: names the key, where to set it, the node", async () => {
    const result = await tools.create({ name: uniqueName(), definition: systemOneDefinition() });
    const out = result.structuredContent;

    expect(out?.success).toBe(true);
    expect(out?.workflow?.id).toBeTruthy();
    expect(await getWorkflow(out?.workflow?.id as string)).not.toBeNull();
    expect(out?.warnings).toHaveLength(1);
    for (const text of [out?.message, out?.details, out?.warnings?.[0]]) {
      expect(text).toContain("TYPESAFE_API_KEY");
      expect(text).toContain("Secrets page");
    }
    expect(out?.message).toContain("Warning:");
    expect(out?.warnings?.[0]).toContain('system-one-decision node "qualify"');
    expect(JSON.stringify(result)).not.toContain(KEY_VALUE);
  });

  test("the warning names the key of the node's provider", async () => {
    const result = await tools.create({
      name: uniqueName(),
      definition: systemOneDefinition({ provider: "openrouter" }),
    });
    expect(result.structuredContent?.warnings?.[0]).toContain(
      "OPENROUTER_API_KEY is not configured",
    );
    expect(result.structuredContent?.warnings?.[0]).not.toContain("TYPESAFE_API_KEY");
  });

  test("a laya node warns for LAYA_URL and LAYA_API_KEY, never for a TypeSafe key", async () => {
    await setTypeSafeKey();
    const result = await tools.create({
      name: uniqueName(),
      definition: systemOneDefinition({ provider: "laya" }),
    });
    const out = result.structuredContent;

    expect(out?.success).toBe(true);
    expect(out?.warnings).toHaveLength(1);
    const warning = out?.warnings?.[0] ?? "";
    expect(warning).toContain("LAYA_URL is not configured");
    expect(warning).toContain("LAYA_API_KEY is not configured");
    expect(warning).toContain('system-one-decision node "qualify"');
    expect(warning).not.toMatch(/TypeSafe|TYPESAFE/);

    // Only the URL is set: the warning shrinks to the key.
    await upsertSwarmConfig({
      scope: "global",
      key: "LAYA_URL",
      value: "https://laya.example.test",
    });
    const half = await tools.create({
      name: uniqueName(),
      definition: systemOneDefinition({ provider: "laya" }),
    });
    expect(half.structuredContent?.warnings?.[0]).toContain("LAYA_API_KEY is not configured");
    expect(half.structuredContent?.warnings?.[0]).not.toContain("LAYA_URL");

    await upsertSwarmConfig({
      scope: "global",
      key: "LAYA_API_KEY",
      value: "laya-example-save-warning-key-0123456789",
      isSecret: true,
    });
    const ready = await tools.create({
      name: uniqueName(),
      definition: systemOneDefinition({ provider: "laya" }),
    });
    expect(ready.structuredContent?.warnings).toBeUndefined();
    expect(JSON.stringify(ready)).not.toContain("laya-example-save-warning-key");
  });

  test("HTTP create of a laya node carries the same warning", async () => {
    const created = await http("POST", "/api/workflows", {
      name: uniqueName(),
      definition: systemOneDefinition({ provider: "laya" }),
    });
    expect(created.status).toBe(201);
    expect(created.body.warnings).toHaveLength(1);
    expect(created.body.warnings?.[0]).toContain("LAYA_URL is not configured");
    expect(created.body.warnings?.[0]).toContain("LAYA_API_KEY is not configured");
  });

  test("no warning once the key is configured, or when there is no system-one-decision node", async () => {
    const plain = await tools.create({ name: uniqueName(), definition: plainDefinition() });
    expect(plain.structuredContent?.success).toBe(true);
    expect(plain.structuredContent?.warnings).toBeUndefined();
    expect(plain.structuredContent?.message).not.toContain("Warning");

    await setTypeSafeKey();
    const keyed = await tools.create({ name: uniqueName(), definition: systemOneDefinition() });
    expect(keyed.structuredContent?.success).toBe(true);
    expect(keyed.structuredContent?.warnings).toBeUndefined();

    process.env.OPENROUTER_API_KEY = "sk-or-example-save-warning-key-0123456789";
    const openrouter = await tools.create({
      name: uniqueName(),
      definition: systemOneDefinition({ provider: "openrouter" }),
    });
    expect(openrouter.structuredContent?.warnings).toBeUndefined();
  });

  test("update-workflow warns when the new definition adds a system-one-decision node, and on a rename", async () => {
    const created = await tools.create({ name: uniqueName(), definition: plainDefinition() });
    const id = created.structuredContent?.workflow?.id as string;

    const withSystemOne = await tools.update({ id, definition: systemOneDefinition() });
    expect(withSystemOne.structuredContent?.success).toBe(true);
    expect(withSystemOne.structuredContent?.warnings?.[0]).toContain("TYPESAFE_API_KEY");

    // A change that does not touch the definition still tells the author what is still true.
    const renamed = await tools.update({ id, name: uniqueName() });
    expect(renamed.structuredContent?.success).toBe(true);
    expect(renamed.structuredContent?.warnings?.[0]).toContain("TYPESAFE_API_KEY");

    await setTypeSafeKey();
    const fixed = await tools.update({ id, name: uniqueName() });
    expect(fixed.structuredContent?.warnings).toBeUndefined();
  });

  test("patch-workflow warns when a system-one-decision node is created", async () => {
    const created = await tools.create({ name: uniqueName(), definition: plainDefinition() });
    const id = created.structuredContent?.workflow?.id as string;

    const patched = await tools.patch({
      id,
      update: [{ nodeId: "step", node: { next: "qualify" } }],
      create: [
        { id: "qualify", type: "system-one-decision", config: systemOneConfig(), inputs: {} },
      ],
    });
    expect(patched.structuredContent?.success).toBe(true);
    expect(patched.structuredContent?.warnings?.[0]).toContain("TYPESAFE_API_KEY");
    expect(patched.structuredContent?.message).toContain("Warning:");
  });

  test("patch-workflow-node warns when a node is switched to another provider", async () => {
    await setTypeSafeKey();
    const created = await tools.create({ name: uniqueName(), definition: systemOneDefinition() });
    const id = created.structuredContent?.workflow?.id as string;
    expect(created.structuredContent?.warnings).toBeUndefined();

    const patched = await tools.patchNode({
      id,
      nodeId: "qualify",
      config: systemOneConfig({ provider: "openrouter" }),
    });
    expect(patched.structuredContent?.success).toBe(true);
    expect(patched.structuredContent?.warnings?.[0]).toContain("OPENROUTER_API_KEY");
    expect(patched.structuredContent?.warnings?.[0]).not.toContain("TYPESAFE_API_KEY");
  });

  test("HTTP create, update, patch, and node patch carry the same warning", async () => {
    const created = await http("POST", "/api/workflows", {
      name: uniqueName(),
      definition: systemOneDefinition(),
    });
    expect(created.status).toBe(201);
    expect(created.body.warnings).toHaveLength(1);
    expect(created.body.warnings?.[0]).toContain("TYPESAFE_API_KEY");
    expect(created.body.warnings?.[0]).toContain("Secrets page");
    expect(JSON.stringify(created.body)).not.toContain(KEY_VALUE);
    const id = created.body.id;

    const updated = await http("PUT", `/api/workflows/${id}`, { description: "edited" });
    expect(updated.status).toBe(200);
    expect(updated.body.warnings?.[0]).toContain("TYPESAFE_API_KEY");

    const nodePatched = await http("PATCH", `/api/workflows/${id}/nodes/qualify`, {
      config: systemOneConfig({ provider: "openrouter" }),
    });
    expect(nodePatched.status).toBe(200);
    expect(nodePatched.body.warnings?.[0]).toContain("OPENROUTER_API_KEY");

    const patched = await http("PATCH", `/api/workflows/${id}`, {
      update: [{ nodeId: "qualify", node: { config: systemOneConfig() } }],
    });
    expect(patched.status).toBe(200);
    expect(patched.body.warnings?.[0]).toContain("TYPESAFE_API_KEY");

    await setTypeSafeKey();
    const clean = await http("PUT", `/api/workflows/${id}`, { description: "edited again" });
    expect(clean.status).toBe(200);
    expect(clean.body.warnings).toBeUndefined();
  });

  test("HTTP create without a system-one-decision node has no warnings field", async () => {
    const created = await http("POST", "/api/workflows", {
      name: uniqueName(),
      definition: plainDefinition(),
    });
    expect(created.status).toBe(201);
    expect(Object.hasOwn(created.body, "warnings")).toBe(false);
  });
});
