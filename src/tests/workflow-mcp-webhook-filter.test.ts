import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { closeDb, deleteWorkflow, getWorkflow, initDb } from "../be/db";
import { registerCreateWorkflowTool } from "../tools/workflows/create-workflow";
import { registerPatchWorkflowTool } from "../tools/workflows/patch-workflow";
import { registerUpdateWorkflowTool } from "../tools/workflows/update-workflow";
import type { WorkflowDefinition } from "../types";
import { initWorkflows, stopRetryPoller } from "../workflows";

const TEST_DB_PATH = "./test-workflow-mcp-webhook-filter.sqlite";

const definition: WorkflowDefinition = {
  nodes: [{ id: "step1", type: "agent-task", config: { template: "Hello" } }],
};

const githubFilter = {
  headers: { "x-github-event": ["pull_request"] },
  body: { action: ["opened", "reopened", "ready_for_review", "synchronize"] },
};

type RegisteredTool = {
  inputSchema: z.ZodType;
  handler: (
    args: unknown,
    extra: unknown,
  ) => Promise<{
    structuredContent?: { success?: boolean; workflow?: { id?: string } };
  }>;
};

function registeredTools() {
  const server = new McpServer({ name: "webhook-filter-tools", version: "1" });
  registerCreateWorkflowTool(server);
  registerUpdateWorkflowTool(server);
  registerPatchWorkflowTool(server);
  return (
    server as unknown as {
      _registeredTools: Record<string, RegisteredTool>;
    }
  )._registeredTools;
}

const extra = {
  sessionId: "session-test",
  requestInfo: { headers: { "x-agent-id": "agent-test" } },
};

function webhookProperties(schema: unknown): Record<string, unknown> | undefined {
  const seen = new Set<unknown>();
  const visit = (node: unknown): Record<string, unknown> | undefined => {
    if (!node || typeof node !== "object" || seen.has(node)) return undefined;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = visit(item);
        if (found) return found;
      }
      return undefined;
    }
    const record = node as Record<string, unknown>;
    const properties = record.properties;
    if (properties && typeof properties === "object") {
      const props = properties as Record<string, unknown>;
      if (props.filter && props.preset && props.events && props.eventHeader) return props;
    }
    for (const value of Object.values(record)) {
      const found = visit(value);
      if (found) return found;
    }
    return undefined;
  };
  return visit(schema);
}

describe("MCP workflow tools accept webhook filter and preset", () => {
  const tools = registeredTools();
  const createdIds: string[] = [];

  beforeAll(async () => {
    await unlink(TEST_DB_PATH).catch(() => {});
    initDb(TEST_DB_PATH);
    await initWorkflows();
  });

  afterAll(async () => {
    stopRetryPoller();
    for (const id of createdIds) {
      await deleteWorkflow(id).catch(() => {});
    }
    closeDb();
    await unlink(TEST_DB_PATH).catch(() => {});
    await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
    await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
  });

  test("published create and update schemas include filter and preset", () => {
    for (const name of ["create-workflow", "update-workflow"]) {
      const json = z.toJSONSchema(tools[name]!.inputSchema);
      const webhook = webhookProperties(json);
      expect(webhook, name).toBeDefined();
      expect(webhook).toHaveProperty("filter");
      expect(webhook).toHaveProperty("preset");
      expect(webhook).toHaveProperty("events");
      expect(webhook).toHaveProperty("eventHeader");
    }

    const patch = z.toJSONSchema(tools["patch-workflow"]!.inputSchema) as {
      properties?: Record<string, unknown>;
    };
    expect(patch.properties).not.toHaveProperty("triggers");
    expect(patch.properties).not.toHaveProperty("filter");
    expect(patch.properties).not.toHaveProperty("preset");
  });

  test("create-workflow and update-workflow persist filter and preset", async () => {
    const createArgs = {
      name: `mcp-webhook-filter-${crypto.randomUUID().slice(0, 8)}`,
      definition,
      triggers: [
        {
          type: "webhook",
          preset: "github",
          events: ["pull_request"],
          filter: githubFilter,
        },
      ],
    };
    const createdInput = tools["create-workflow"]!.inputSchema.safeParse(createArgs);
    expect(createdInput.success).toBe(true);
    if (!createdInput.success) return;

    const created = await tools["create-workflow"]!.handler(createdInput.data, extra);
    expect(created.structuredContent?.success).toBe(true);
    const id = created.structuredContent?.workflow?.id;
    expect(id).toBeTruthy();
    createdIds.push(id!);

    const stored = await getWorkflow(id!);
    expect(stored?.triggers[0]).toMatchObject({
      type: "webhook",
      preset: "github",
      events: ["pull_request"],
      filter: githubFilter,
    });

    const updateArgs = {
      id,
      triggers: [
        {
          type: "webhook",
          preset: "standard-webhooks",
          events: ["contact.created"],
          filter: { body: { type: ["contact.created"] } },
        },
      ],
    };
    const updatedInput = tools["update-workflow"]!.inputSchema.safeParse(updateArgs);
    expect(updatedInput.success).toBe(true);
    if (!updatedInput.success) return;

    const updated = await tools["update-workflow"]!.handler(updatedInput.data, extra);
    expect(updated.structuredContent?.success).toBe(true);
    const reloaded = await getWorkflow(id!);
    expect(reloaded?.triggers[0]).toMatchObject({
      type: "webhook",
      preset: "standard-webhooks",
      events: ["contact.created"],
      filter: { body: { type: ["contact.created"] } },
    });
  });

  test("create-workflow rejects an empty webhook filter", () => {
    const parsed = tools["create-workflow"]!.inputSchema.safeParse({
      name: "empty-filter",
      definition,
      triggers: [{ type: "webhook", filter: {} }],
    });
    expect(parsed.success).toBe(false);
  });

  test("patch-workflow does not take triggers and leaves a stored filter in place", async () => {
    const createArgs = {
      name: `mcp-webhook-filter-patch-${crypto.randomUUID().slice(0, 8)}`,
      definition,
      triggers: [{ type: "webhook", preset: "gitlab", filter: githubFilter }],
    };
    const createdInput = tools["create-workflow"]!.inputSchema.safeParse(createArgs);
    expect(createdInput.success).toBe(true);
    if (!createdInput.success) return;
    const created = await tools["create-workflow"]!.handler(createdInput.data, extra);
    const id = created.structuredContent?.workflow?.id;
    expect(id).toBeTruthy();
    createdIds.push(id!);
    const before = await getWorkflow(id!);

    const ignored = tools["patch-workflow"]!.inputSchema.safeParse({
      id,
      triggers: [{ type: "webhook", filter: { body: { action: ["closed"] } } }],
      update: [{ nodeId: "step1", node: { label: "renamed" } }],
    });
    expect(ignored.success).toBe(true);
    if (!ignored.success) return;
    expect(ignored.data).not.toHaveProperty("triggers");

    const patched = await tools["patch-workflow"]!.handler(ignored.data, extra);
    expect(patched.structuredContent?.success).toBe(true);
    const after = await getWorkflow(id!);
    expect(after?.triggers).toEqual(before?.triggers);
    expect(after?.definition.nodes[0]).toMatchObject({ id: "step1", label: "renamed" });
  });
});
