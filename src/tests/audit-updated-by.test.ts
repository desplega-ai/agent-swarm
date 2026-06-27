/**
 * Regression tests for `updated_by` population on schedule and workflow UPDATE paths.
 *
 * Verifies:
 * - `updated_by` is stamped when a source task with a human requester is present.
 * - A pure-automation update (no source task / no human requester) does NOT clobber
 *   an existing `updated_by` value or cause a crash.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveHttpAuditUserId, resolveTaskAuditUserId } from "../be/audit-user";
import {
  closeDb,
  createAgent,
  createScheduledTask,
  createTaskExtended,
  createUser,
  createWorkflow,
  getScheduledTaskById,
  getWorkflow,
  initDb,
  updateScheduledTask,
  updateWorkflow,
} from "../be/db";
import { handleSchedules } from "../http/schedules";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { handleWorkflows } from "../http/workflows";
import { registerUpdateScheduleTool } from "../tools/schedules/update-schedule";
import { registerPatchWorkflowTool } from "../tools/workflows/patch-workflow";
import { registerPatchWorkflowNodeTool } from "../tools/workflows/patch-workflow-node";
import { registerUpdateWorkflowTool } from "../tools/workflows/update-workflow";
import { setRequestAuth } from "../utils/request-auth-context";

const TEST_DB_PATH = "./test-audit-updated-by.sqlite";

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
};

function callTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
  agentId: string,
  sourceTaskId?: string,
): Promise<CallToolResult> {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = tools[toolName];
  if (!tool) throw new Error(`${toolName} not registered`);
  const headers: Record<string, string> = { "x-agent-id": agentId };
  if (sourceTaskId) headers["x-source-task-id"] = sourceTaskId;
  return tool.handler(args, {
    sessionId: "test-session",
    requestInfo: { headers },
  });
}

let agentId: string;
let humanUserId: string;
let sourceTaskId: string;

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
  initDb(TEST_DB_PATH);
  const agent = createAgent({ name: "audit-test-agent", isLead: false, status: "idle" });
  agentId = agent.id;

  // Create a real user in the users table (requestedByUserId is a FK)
  const user = createUser({ name: "Audit Test Human", email: "human@example.com" });
  humanUserId = user.id;

  // Create a task with a human requester
  const task = createTaskExtended("test task for audit", {
    agentId,
    requestedByUserId: humanUserId,
  });
  sourceTaskId = task.id;
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
});

// ─── Schedule tests ────────────────────────────────────────────────────────────

describe("updateScheduledTask — updated_by column", () => {
  test("direct db call: sets updated_by when provided", () => {
    const schedule = createScheduledTask({
      name: `audit-sched-direct-${Date.now()}`,
      cronExpression: "0 * * * *",
      taskTemplate: "test",
      createdByAgentId: agentId,
      timezone: "UTC",
    });
    expect(schedule.updatedBy).toBeUndefined();

    const updated = updateScheduledTask(schedule.id, {
      description: "patched",
      updatedBy: humanUserId,
    });
    expect(updated?.updatedBy).toBe(humanUserId);
  });

  test("direct db call: automation update (no updatedBy) does not clobber existing updated_by", () => {
    const schedule = createScheduledTask({
      name: `audit-sched-noclobber-${Date.now()}`,
      cronExpression: "0 * * * *",
      taskTemplate: "test",
      createdByAgentId: agentId,
      timezone: "UTC",
    });

    // Set an initial updated_by
    updateScheduledTask(schedule.id, { description: "first edit", updatedBy: humanUserId });

    // Automation update without updatedBy — must NOT clear existing value
    const after = updateScheduledTask(schedule.id, { description: "automation edit" });
    expect(after?.updatedBy).toBe(humanUserId);
  });
});

describe("update-schedule MCP tool — updated_by column", () => {
  test("stamps updated_by when source task has human requester", async () => {
    const server = new McpServer({ name: "audit-test", version: "1.0.0" });
    registerUpdateScheduleTool(server);

    const schedule = createScheduledTask({
      name: `audit-sched-mcp-${Date.now()}`,
      intervalMs: 60_000,
      taskTemplate: "test",
      createdByAgentId: agentId,
      timezone: "UTC",
    });

    const result = await callTool(
      server,
      "update-schedule",
      { scheduleId: schedule.id, intervalMs: 120_000 },
      agentId,
      sourceTaskId,
    );
    expect((result.structuredContent as { success: boolean }).success).toBe(true);

    const updated = getScheduledTaskById(schedule.id);
    expect(updated?.updatedBy).toBe(humanUserId);
  });

  test("does not crash or clear updated_by when source task has no human requester", async () => {
    const server = new McpServer({ name: "audit-test-2", version: "1.0.0" });
    registerUpdateScheduleTool(server);

    const schedule = createScheduledTask({
      name: `audit-sched-nouser-${Date.now()}`,
      intervalMs: 60_000,
      taskTemplate: "test",
      createdByAgentId: agentId,
      timezone: "UTC",
    });
    // Pre-stamp
    updateScheduledTask(schedule.id, { updatedBy: humanUserId });

    // Task with no human requester
    const automationTask = createTaskExtended("automation task", { agentId });

    const result = await callTool(
      server,
      "update-schedule",
      { scheduleId: schedule.id, intervalMs: 30_000 },
      agentId,
      automationTask.id,
    );
    expect((result.structuredContent as { success: boolean }).success).toBe(true);

    const after = getScheduledTaskById(schedule.id);
    expect(after?.updatedBy).toBe(humanUserId); // must not be cleared
  });
});

// ─── Workflow tests ────────────────────────────────────────────────────────────

const MINIMAL_DEFINITION = {
  nodes: [{ id: "start", type: "agent-task", config: { task: "hello" }, next: null }],
  onNodeFailure: "fail" as const,
};

describe("updateWorkflow — updated_by column", () => {
  test("direct db call: sets updated_by when provided", () => {
    const wf = createWorkflow({
      name: `audit-wf-direct-${Date.now()}`,
      definition: MINIMAL_DEFINITION,
    });
    expect(wf.updatedBy).toBeUndefined();

    const updated = updateWorkflow(wf.id, { description: "patched", updatedBy: humanUserId });
    expect(updated?.updatedBy).toBe(humanUserId);
  });

  test("direct db call: automation update (no updatedBy) does not clobber existing updated_by", () => {
    const wf = createWorkflow({
      name: `audit-wf-noclobber-${Date.now()}`,
      definition: MINIMAL_DEFINITION,
    });

    updateWorkflow(wf.id, { description: "first edit", updatedBy: humanUserId });
    const after = updateWorkflow(wf.id, { description: "automation edit" });
    expect(after?.updatedBy).toBe(humanUserId);
  });
});

describe("update-workflow MCP tool — updated_by column", () => {
  test("stamps updated_by when source task has human requester", async () => {
    const server = new McpServer({ name: "audit-wf-test", version: "1.0.0" });
    registerUpdateWorkflowTool(server);

    const wf = createWorkflow({
      name: `audit-wf-mcp-${Date.now()}`,
      definition: MINIMAL_DEFINITION,
    });

    const result = await callTool(
      server,
      "update-workflow",
      { id: wf.id, description: "updated via MCP" },
      agentId,
      sourceTaskId,
    );
    expect((result.structuredContent as { success: boolean }).success).toBe(true);

    const updated = getWorkflow(wf.id);
    expect(updated?.updatedBy).toBe(humanUserId);
  });

  test("does not clobber updated_by when source task has no human requester", async () => {
    const server = new McpServer({ name: "audit-wf-test-2", version: "1.0.0" });
    registerUpdateWorkflowTool(server);

    const wf = createWorkflow({
      name: `audit-wf-nouser-${Date.now()}`,
      definition: MINIMAL_DEFINITION,
    });
    updateWorkflow(wf.id, { updatedBy: humanUserId });

    const automationTask = createTaskExtended("automation wf task", { agentId });

    const result = await callTool(
      server,
      "update-workflow",
      { id: wf.id, description: "automation update" },
      agentId,
      automationTask.id,
    );
    expect((result.structuredContent as { success: boolean }).success).toBe(true);

    const after = getWorkflow(wf.id);
    expect(after?.updatedBy).toBe(humanUserId);
  });
});

describe("patch-workflow MCP tool — updated_by column", () => {
  test("stamps updated_by when source task has human requester", async () => {
    const server = new McpServer({ name: "audit-patch-test", version: "1.0.0" });
    registerPatchWorkflowTool(server);

    const wf = createWorkflow({
      name: `audit-patch-mcp-${Date.now()}`,
      definition: MINIMAL_DEFINITION,
    });

    const result = await callTool(
      server,
      "patch-workflow",
      {
        id: wf.id,
        update: [{ nodeId: "start", node: { config: { task: "updated hello" } } }],
      },
      agentId,
      sourceTaskId,
    );
    expect((result.structuredContent as { success: boolean }).success).toBe(true);

    const updated = getWorkflow(wf.id);
    expect(updated?.updatedBy).toBe(humanUserId);
  });

  test("does not clobber updated_by on automation patch", async () => {
    const server = new McpServer({ name: "audit-patch-test-2", version: "1.0.0" });
    registerPatchWorkflowTool(server);

    const wf = createWorkflow({
      name: `audit-patch-nouser-${Date.now()}`,
      definition: MINIMAL_DEFINITION,
    });
    updateWorkflow(wf.id, { updatedBy: humanUserId });

    const automationTask = createTaskExtended("automation patch task", { agentId });

    const result = await callTool(
      server,
      "patch-workflow",
      {
        id: wf.id,
        update: [{ nodeId: "start", node: { config: { task: "auto-patched" } } }],
      },
      agentId,
      automationTask.id,
    );
    expect((result.structuredContent as { success: boolean }).success).toBe(true);

    const after = getWorkflow(wf.id);
    expect(after?.updatedBy).toBe(humanUserId);
  });
});

// ─── Trusted audit-actor resolution (anti-spoofing) ──────────────────────────

describe("resolveTaskAuditUserId — source-task ownership gate", () => {
  test("returns the task requester when the source task is owned by the caller", () => {
    expect(resolveTaskAuditUserId(sourceTaskId, agentId)).toBe(humanUserId);
  });

  test("returns null when the source task belongs to a different agent (no spoofing)", () => {
    const otherAgent = createAgent({
      name: `audit-other-${Date.now()}`,
      isLead: false,
      status: "idle",
    });
    // A task owned by another agent but with a human requester — a caller must
    // NOT be able to attribute a write to this task's requester.
    const foreignTask = createTaskExtended("foreign task", {
      agentId: otherAgent.id,
      requestedByUserId: humanUserId,
    });
    expect(resolveTaskAuditUserId(foreignTask.id, agentId)).toBeNull();
  });

  test("returns null when no source task id is present", () => {
    expect(resolveTaskAuditUserId(undefined, agentId)).toBeNull();
  });

  test("returns null when the caller agent id is missing", () => {
    expect(resolveTaskAuditUserId(sourceTaskId, undefined)).toBeNull();
  });

  test("returns null when the owned source task has no human requester", () => {
    const autoTask = createTaskExtended("automation only", { agentId });
    expect(resolveTaskAuditUserId(autoTask.id, agentId)).toBeNull();
  });
});

describe("resolveHttpAuditUserId — trusted request context", () => {
  function makeReq(srcTaskId?: string): IncomingMessage {
    const req = Readable.from([]) as IncomingMessage;
    req.method = "POST";
    req.url = "/api/workflows";
    const headers: Record<string, string> = { "x-agent-id": agentId };
    if (srcTaskId) headers["x-source-task-id"] = srcTaskId;
    req.headers = headers;
    return req;
  }

  test("prefers the authenticated request user over the source-task header", () => {
    const user = createUser({ name: "Auth User", email: `auth-${Date.now()}@example.com` });
    const req = makeReq(sourceTaskId);
    setRequestAuth(req, { kind: "user", userId: user.id, user });
    expect(resolveHttpAuditUserId(req, agentId)).toBe(user.id);
  });

  test("falls back to the ownership-validated source task when not user-authenticated", () => {
    const req = makeReq(sourceTaskId);
    setRequestAuth(req, null);
    expect(resolveHttpAuditUserId(req, agentId)).toBe(humanUserId);
  });

  test("ignores a source task the caller does not own", () => {
    const otherAgent = createAgent({
      name: `audit-other-http-${Date.now()}`,
      isLead: false,
      status: "idle",
    });
    const foreignTask = createTaskExtended("foreign http task", {
      agentId: otherAgent.id,
      requestedByUserId: humanUserId,
    });
    const req = makeReq(foreignTask.id);
    setRequestAuth(req, null);
    expect(resolveHttpAuditUserId(req, agentId)).toBeNull();
  });
});

// ─── HTTP create paths — created_by population ───────────────────────────────

// The HTTP create route runs full definition validation (unlike the direct DB
// `createWorkflow` used by the MCP-tool tests above, which accepts the more
// permissive MINIMAL_DEFINITION). Use a route-valid definition here.
const HTTP_WF_DEFINITION = {
  nodes: [{ id: "n1", type: "notify", config: { channel: "swarm", template: "test" } }],
};

function makeHttpReq(
  method: string,
  path: string,
  body: unknown,
  callerAgentId: string,
  srcTaskId?: string,
): IncomingMessage {
  const req = Readable.from(
    body !== undefined ? [Buffer.from(JSON.stringify(body))] : [],
  ) as IncomingMessage;
  req.method = method;
  req.url = path;
  const headers: Record<string, string> = {
    "x-agent-id": callerAgentId,
    "content-type": "application/json",
  };
  if (srcTaskId) headers["x-source-task-id"] = srcTaskId;
  req.headers = headers;
  return req;
}

function makeHttpRes(): { res: ServerResponse; status: () => number; body: () => string } {
  let status = 200;
  let text = "";
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) text += String(chunk);
      this.writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => text };
}

async function dispatchSchedules(
  body: unknown,
  callerAgentId: string,
  srcTaskId?: string,
): Promise<{ status: number; json: { id?: string } }> {
  const path = "/api/schedules";
  const req = makeHttpReq("POST", path, body, callerAgentId, srcTaskId);
  const { res, status, body: text } = makeHttpRes();
  await handleSchedules(req, res, getPathSegments(path), parseQueryParams(path), callerAgentId);
  return { status: status(), json: JSON.parse(text() || "{}") };
}

async function dispatchWorkflows(
  body: unknown,
  callerAgentId: string,
  srcTaskId?: string,
): Promise<{ status: number; json: { id?: string } }> {
  const path = "/api/workflows";
  const req = makeHttpReq("POST", path, body, callerAgentId, srcTaskId);
  const { res, status, body: text } = makeHttpRes();
  await handleWorkflows(req, res, getPathSegments(path), parseQueryParams(path), callerAgentId);
  return { status: status(), json: JSON.parse(text() || "{}") };
}

describe("HTTP create paths — created_by column", () => {
  test("POST /api/schedules stamps created_by from an owned source task", async () => {
    const { status, json } = await dispatchSchedules(
      {
        name: `http-sched-create-${Date.now()}`,
        cronExpression: "0 * * * *",
        taskTemplate: "do the thing",
      },
      agentId,
      sourceTaskId,
    );
    expect(status).toBe(201);
    expect(json.id).toBeDefined();
    const created = getScheduledTaskById(json.id as string);
    expect(created?.createdBy).toBe(humanUserId);
  });

  test("POST /api/schedules does not stamp created_by for a foreign source task", async () => {
    const otherAgent = createAgent({
      name: `audit-sched-foreign-${Date.now()}`,
      isLead: false,
      status: "idle",
    });
    const foreignTask = createTaskExtended("foreign sched task", {
      agentId: otherAgent.id,
      requestedByUserId: humanUserId,
    });
    const { status, json } = await dispatchSchedules(
      {
        name: `http-sched-foreign-${Date.now()}`,
        cronExpression: "0 * * * *",
        taskTemplate: "do the thing",
      },
      agentId,
      foreignTask.id,
    );
    expect(status).toBe(201);
    const created = getScheduledTaskById(json.id as string);
    expect(created?.createdBy).toBeUndefined();
  });

  test("POST /api/workflows stamps created_by from an owned source task", async () => {
    const { status, json } = await dispatchWorkflows(
      { name: `http-wf-create-${Date.now()}`, definition: HTTP_WF_DEFINITION },
      agentId,
      sourceTaskId,
    );
    expect(status).toBe(201);
    expect(json.id).toBeDefined();
    const created = getWorkflow(json.id as string);
    expect(created?.createdBy).toBe(humanUserId);
  });

  test("POST /api/workflows does not stamp created_by for a foreign source task", async () => {
    const otherAgent = createAgent({
      name: `audit-wf-foreign-${Date.now()}`,
      isLead: false,
      status: "idle",
    });
    const foreignTask = createTaskExtended("foreign wf task", {
      agentId: otherAgent.id,
      requestedByUserId: humanUserId,
    });
    const { status, json } = await dispatchWorkflows(
      { name: `http-wf-foreign-${Date.now()}`, definition: HTTP_WF_DEFINITION },
      agentId,
      foreignTask.id,
    );
    expect(status).toBe(201);
    const created = getWorkflow(json.id as string);
    expect(created?.createdBy).toBeUndefined();
  });
});

// ─── patch-workflow-node MCP tool — updated_by column ────────────────────────

describe("patch-workflow-node MCP tool — updated_by column", () => {
  test("stamps updated_by when source task has human requester", async () => {
    const server = new McpServer({ name: "audit-patchnode-test", version: "1.0.0" });
    registerPatchWorkflowNodeTool(server);

    const wf = createWorkflow({
      name: `audit-patchnode-mcp-${Date.now()}`,
      definition: MINIMAL_DEFINITION,
    });

    const result = await callTool(
      server,
      "patch-workflow-node",
      { id: wf.id, nodeId: "start", config: { task: "node updated" } },
      agentId,
      sourceTaskId,
    );
    expect((result.structuredContent as { success: boolean }).success).toBe(true);

    const updated = getWorkflow(wf.id);
    expect(updated?.updatedBy).toBe(humanUserId);
  });

  test("does not clobber updated_by on automation patch", async () => {
    const server = new McpServer({ name: "audit-patchnode-test-2", version: "1.0.0" });
    registerPatchWorkflowNodeTool(server);

    const wf = createWorkflow({
      name: `audit-patchnode-nouser-${Date.now()}`,
      definition: MINIMAL_DEFINITION,
    });
    updateWorkflow(wf.id, { updatedBy: humanUserId });

    const automationTask = createTaskExtended("automation patchnode task", { agentId });

    const result = await callTool(
      server,
      "patch-workflow-node",
      { id: wf.id, nodeId: "start", config: { task: "auto node patch" } },
      agentId,
      automationTask.id,
    );
    expect((result.structuredContent as { success: boolean }).success).toBe(true);

    const after = getWorkflow(wf.id);
    expect(after?.updatedBy).toBe(humanUserId);
  });

  test("does not trust a foreign source task", async () => {
    const server = new McpServer({ name: "audit-patchnode-test-3", version: "1.0.0" });
    registerPatchWorkflowNodeTool(server);

    const wf = createWorkflow({
      name: `audit-patchnode-foreign-${Date.now()}`,
      definition: MINIMAL_DEFINITION,
    });
    updateWorkflow(wf.id, { updatedBy: humanUserId });

    const otherAgent = createAgent({
      name: `audit-patchnode-other-${Date.now()}`,
      isLead: false,
      status: "idle",
    });
    const foreignTask = createTaskExtended("foreign patchnode task", {
      agentId: otherAgent.id,
      requestedByUserId: humanUserId,
    });

    const result = await callTool(
      server,
      "patch-workflow-node",
      { id: wf.id, nodeId: "start", config: { task: "spoof attempt" } },
      agentId,
      foreignTask.id,
    );
    expect((result.structuredContent as { success: boolean }).success).toBe(true);

    // updated_by must be unchanged — the foreign task's requester is not trusted.
    const after = getWorkflow(wf.id);
    expect(after?.updatedBy).toBe(humanUserId);
  });
});
