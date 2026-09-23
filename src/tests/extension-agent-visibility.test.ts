// Extension identities (`ext:<name>`, role "extension") are API principals, not
// workers: hidden from every agent listing and never assigned, offered,
// scheduled, or handed pool work. The rows themselves stay.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as db from "../be/db";
import {
  acceptTask,
  claimOfferedTask,
  claimTask,
  closeDb,
  createAgent,
  createScheduledTask,
  createTaskExtended,
  getAgentById,
  getAllAgents,
  getAllAgentsWithTasks,
  getDbClient,
  getSwarmMetrics,
  initDb,
  isAgentEligibleForTask,
  updateAgentProfile,
} from "../be/db";
import { assignUnassignedTaskPending } from "../be/db/tasks/write";
import { ensureExtensionAgent } from "../extensions/identity";
import { handleAgentRegister, handleAgentsRest } from "../http/agents";
import { handlePoll } from "../http/poll";
import { handleSchedules } from "../http/schedules";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { createStandaloneScheduleTask } from "../scheduler/schedule-task";
import { registerGetSwarmTool } from "../tools/get-swarm";
import { registerJoinSwarmTool } from "../tools/join-swarm";
import { registerCreateScheduleTool } from "../tools/schedules/create-schedule";
import { registerPatchScheduleTool } from "../tools/schedules/patch-schedule";
import { registerUpdateScheduleTool } from "../tools/schedules/update-schedule";
import { registerSendTaskTool } from "../tools/send-task";
import { registerUpdateProfileTool } from "../tools/update-profile";
import { setRequestAuth } from "../utils/request-auth-context";
import { workflowEventBus } from "../workflows/event-bus";
import { AgentTaskExecutor } from "../workflows/executors/agent-task";
import { interpolate } from "../workflows/template";

const TEST_DB_PATH = "./test-extension-agent-visibility.sqlite";
const EXTENSION_ERROR = /is an extension identity and cannot be assigned/;
const RESERVED_ERROR = /reserved for extension identities/;
const LOCKED_ERROR = /Extension identities keep the "extension" role/;

let server: Server;
let baseUrl = "";
let leadId = "";
let workerId = "";
let extId = "";

type RegisteredTool = { handler: (args: unknown, extra: unknown) => Promise<CallToolResult> };

function buildMcp(): McpServer {
  const mcp = new McpServer({ name: "extension-agent-visibility", version: "1.0.0" });
  registerGetSwarmTool(mcp);
  registerSendTaskTool(mcp);
  registerCreateScheduleTool(mcp);
  registerUpdateScheduleTool(mcp);
  registerPatchScheduleTool(mcp);
  registerJoinSwarmTool(mcp);
  registerUpdateProfileTool(mcp);
  return mcp;
}

function callTool(
  mcp: McpServer,
  name: string,
  args: Record<string, unknown>,
  callerAgentId: string,
): Promise<CallToolResult> {
  const tools = (mcp as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`${name} not registered`);
  return tool.handler(args, {
    sessionId: "test-session",
    requestInfo: { headers: { "x-agent-id": callerAgentId } },
  });
}

function structured(result: CallToolResult) {
  return result.structuredContent as {
    success: boolean;
    message: string;
    agents?: Array<{ id: string; name: string }>;
  };
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  agentId?: string,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (agentId) headers["X-Agent-ID"] = agentId;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
  initDb(TEST_DB_PATH);
  leadId = (await createAgent({ name: "vis-lead", isLead: true, status: "idle", maxTasks: 5 })).id;
  workerId = (await createAgent({ name: "vis-worker", isLead: false, status: "idle", maxTasks: 5 }))
    .id;
  extId = await ensureExtensionAgent("tool-call-tracker");

  server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    setRequestAuth(req, { kind: "operator", fingerprint: "extension-visibility-test" });
    res.setHeader("Content-Type", "application/json");
    const pathSegments = getPathSegments(req.url ?? "");
    const query = parseQueryParams(req.url ?? "");
    const callerAgentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleAgentRegister(req, res, pathSegments, callerAgentId)) return;
    for (const handler of [handleAgentsRest, handleTasks, handleSchedules, handlePoll]) {
      if (await handler(req, res, pathSegments, query, callerAgentId)) return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not listen");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
});

describe("extension identity row", () => {
  test("is kept and re-enabling reuses it", async () => {
    const ext = await getAgentById(extId);
    expect(ext?.name).toBe("ext:tool-call-tracker");
    expect(ext?.role).toBe("extension");
    expect(await ensureExtensionAgent("tool-call-tracker")).toBe(extId);
  });
});

describe("listings exclude extension identities", () => {
  test("getAllAgents excludes by default and includes on opt-in", async () => {
    const ids = (await getAllAgents()).map((a) => a.id);
    expect(ids).toContain(workerId);
    expect(ids).not.toContain(extId);
    expect((await getAllAgents({ includeExtensions: true })).map((a) => a.id)).toContain(extId);
    expect((await getAllAgentsWithTasks()).map((a) => a.id)).not.toContain(extId);
  });

  test("GET /api/agents omits them, with and without tasks", async () => {
    for (const path of ["/api/agents", "/api/agents?include=tasks"]) {
      const res = await api("GET", path);
      expect(res.status).toBe(200);
      const ids = res.body.agents.map((a: { id: string }) => a.id);
      expect(ids).toContain(workerId);
      expect(ids).not.toContain(extId);
    }
  });

  test("MCP get-swarm omits them from data and text", async () => {
    const result = await callTool(buildMcp(), "get-swarm", {}, workerId);
    const agents = structured(result).agents ?? [];
    expect(agents.map((a) => a.id)).toContain(workerId);
    expect(agents.map((a) => a.id)).not.toContain(extId);
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
    expect(text).not.toContain("ext:tool-call-tracker");
  });

  test("swarm metrics do not count them", async () => {
    const metrics = await getSwarmMetrics();
    expect(metrics.agents.total).toBe(2);
  });
});

describe("task creation rejects extension targets", () => {
  test("createTaskExtended rejects agentId and offeredTo", async () => {
    await expect(createTaskExtended("direct", { agentId: extId })).rejects.toThrow(EXTENSION_ERROR);
    await expect(createTaskExtended("offer", { offeredTo: extId })).rejects.toThrow(
      EXTENSION_ERROR,
    );
  });

  test("send-task rejects direct assignment and offers", async () => {
    const mcp = buildMcp();
    for (const offerMode of [false, true]) {
      const result = structured(
        await callTool(
          mcp,
          "send-task",
          {
            agentId: extId,
            task: "do work",
            offerMode,
            routingReason: "human_pinned",
            routingNote: "pinned to the extension identity on purpose",
          },
          leadId,
        ),
      );
      expect(result.success).toBe(false);
      expect(result.message).toMatch(EXTENSION_ERROR);
    }
  });

  test("POST /api/tasks answers 400 for agentId and offeredTo", async () => {
    for (const body of [
      { task: "direct", agentId: extId, routingReason: "human_pinned" },
      { task: "offer", agentId: workerId, offeredTo: extId, routingReason: "human_pinned" },
    ]) {
      const res = await api("POST", "/api/tasks", body, leadId);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(EXTENSION_ERROR);
    }
  });

  test("workflow agent-task node fails instead of assigning", async () => {
    const executor = new AgentTaskExecutor({
      db: db as typeof import("../be/db"),
      eventBus: workflowEventBus,
      interpolate: (template, ctx) => interpolate(template, ctx).result,
    });
    for (const offerMode of [false, true]) {
      const result = await executor.run({
        config: { template: "workflow work", agentId: extId, offerMode },
        context: {},
        meta: {
          runId: crypto.randomUUID(),
          stepId: crypto.randomUUID(),
          nodeId: "task1",
          workflowId: "",
          dryRun: false,
        },
      });
      expect(result.status).toBe("failed");
      expect((result as { error?: string }).error).toMatch(EXTENSION_ERROR);
    }
  });
});

describe("schedules reject extension targets", () => {
  test("create/update/patch-schedule tools reject targetAgentId", async () => {
    const mcp = buildMcp();
    const created = structured(
      await callTool(
        mcp,
        "create-schedule",
        {
          name: `ext-target-${Date.now()}`,
          intervalMs: 60_000,
          taskTemplate: "scheduled work",
          targetAgentId: extId,
        },
        leadId,
      ),
    );
    expect(created.success).toBe(false);
    expect(created.message).toMatch(EXTENSION_ERROR);

    const schedule = await createScheduledTask({
      name: `ext-target-existing-${Date.now()}`,
      intervalMs: 60_000,
      taskTemplate: "scheduled work",
      createdByAgentId: leadId,
      timezone: "UTC",
    });
    for (const tool of ["update-schedule", "patch-schedule"]) {
      const result = structured(
        await callTool(mcp, tool, { scheduleId: schedule.id, targetAgentId: extId }, leadId),
      );
      expect(result.success).toBe(false);
      expect(result.message).toMatch(EXTENSION_ERROR);
    }
  });

  test("POST and PUT /api/schedules answer 400", async () => {
    const created = await api(
      "POST",
      "/api/schedules",
      {
        name: `ext-target-http-${Date.now()}`,
        intervalMs: 60_000,
        taskTemplate: "scheduled work",
        targetAgentId: extId,
      },
      leadId,
    );
    expect(created.status).toBe(400);
    expect(created.body.error).toMatch(EXTENSION_ERROR);

    const schedule = await createScheduledTask({
      name: `ext-target-http-existing-${Date.now()}`,
      intervalMs: 60_000,
      taskTemplate: "scheduled work",
      createdByAgentId: leadId,
      timezone: "UTC",
    });
    const updated = await api(
      "PUT",
      `/api/schedules/${schedule.id}`,
      { targetAgentId: extId },
      leadId,
    );
    expect(updated.status).toBe(400);
    expect(updated.body.error).toMatch(EXTENSION_ERROR);
  });

  test("firing a legacy schedule that targets an extension throws", async () => {
    const schedule = await createScheduledTask({
      name: `ext-target-legacy-${Date.now()}`,
      intervalMs: 60_000,
      taskTemplate: "scheduled work",
      createdByAgentId: leadId,
      targetAgentId: extId,
      timezone: "UTC",
    });
    await expect(createStandaloneScheduleTask(schedule)).rejects.toThrow(EXTENSION_ERROR);
  });
});

describe("extension identities never take work", () => {
  test("eligibility gate, pool claim, and pool assignment refuse them", async () => {
    const ext = await getAgentById(extId);
    expect(ext).not.toBeNull();
    expect(isAgentEligibleForTask(ext!, { routingAffinity: undefined })).toBe(false);

    const poolTask = await createTaskExtended("pool work", {});
    expect(await claimTask(poolTask.id, extId)).toBeNull();
    expect(await assignUnassignedTaskPending(poolTask.id, extId)).toBeNull();
  });

  test("legacy offers cannot be accepted or claimed", async () => {
    // Simulate an offer created before creation-time rejection existed.
    const task = await createTaskExtended("legacy offer", { offeredTo: workerId });
    await getDbClient().run("UPDATE agent_tasks SET offeredTo = ? WHERE id = ?", [extId, task.id]);
    expect(await claimOfferedTask(task.id, extId)).toBeNull();
    expect(await acceptTask(task.id, extId)).toBeNull();
  });

  test("/api/poll returns no trigger even with pool work and a legacy assignment", async () => {
    await createTaskExtended("more pool work", {});
    const legacy = await createTaskExtended("legacy assignment", { agentId: workerId });
    await getDbClient().run("UPDATE agent_tasks SET agentId = ? WHERE id = ?", [extId, legacy.id]);
    // maxTasks 0 already hides work from poll; the role gate must hold even if
    // someone raises it.
    await getDbClient().run("UPDATE agents SET maxTasks = 5 WHERE id = ?", [extId]);
    const res = await api("GET", "/api/poll", undefined, extId);
    expect(res.status).toBe(200);
    expect(res.body.trigger).toBeNull();
  });
});

describe("the extension role is reserved", () => {
  async function expectWorkerUnchanged() {
    const worker = await getAgentById(workerId);
    expect(worker?.role).not.toBe("extension");
    expect((await getAllAgents()).map((a) => a.id)).toContain(workerId);
    expect(isAgentEligibleForTask(worker!, { routingAffinity: undefined })).toBe(true);
  }

  async function expectExtensionUnchanged() {
    const ext = await getAgentById(extId);
    expect(ext?.role).toBe("extension");
    expect((await getAllAgents()).map((a) => a.id)).not.toContain(extId);
    await expect(createTaskExtended("still blocked", { agentId: extId })).rejects.toThrow(
      EXTENSION_ERROR,
    );
  }

  test("updateAgentProfile refuses to grant or strip it without the lifecycle flag", async () => {
    await expect(updateAgentProfile(workerId, { role: "extension" })).rejects.toThrow(
      RESERVED_ERROR,
    );
    await expect(updateAgentProfile(extId, { role: "worker" })).rejects.toThrow(LOCKED_ERROR);
    await expectWorkerUnchanged();
    await expectExtensionUnchanged();
  });

  test("update-profile tool: a worker cannot take it, a lead cannot strip it", async () => {
    const mcp = buildMcp();
    const self = structured(await callTool(mcp, "update-profile", { role: "extension" }, workerId));
    expect(self.success).toBe(false);
    expect(self.message).toMatch(RESERVED_ERROR);

    const byLead = structured(
      await callTool(mcp, "update-profile", { agentId: workerId, role: "extension" }, leadId),
    );
    expect(byLead.success).toBe(false);
    expect(byLead.message).toMatch(RESERVED_ERROR);

    const strip = structured(
      await callTool(mcp, "update-profile", { agentId: extId, role: "worker" }, leadId),
    );
    expect(strip.success).toBe(false);
    expect(strip.message).toMatch(LOCKED_ERROR);

    await expectWorkerUnchanged();
    await expectExtensionUnchanged();
  });

  test("join-swarm cannot register with it", async () => {
    const newId = crypto.randomUUID();
    const result = structured(
      await callTool(
        buildMcp(),
        "join-swarm",
        { name: "sneaky-ext", role: "extension", requestedId: newId },
        newId,
      ),
    );
    expect(result.success).toBe(false);
    expect(result.message).toMatch(RESERVED_ERROR);
    expect(await getAgentById(newId)).toBeNull();
  });

  test("HTTP register and profile update answer 400", async () => {
    const newId = crypto.randomUUID();
    const registered = await api(
      "POST",
      "/api/agents",
      { name: "sneaky-http-ext", role: "extension" },
      newId,
    );
    expect(registered.status).toBe(400);
    expect(registered.body.error).toMatch(RESERVED_ERROR);
    expect(await getAgentById(newId)).toBeNull();

    const grant = await api("PUT", `/api/agents/${workerId}/profile`, { role: "extension" });
    expect(grant.status).toBe(400);
    expect(grant.body.error).toMatch(RESERVED_ERROR);

    const strip = await api("PUT", `/api/agents/${extId}/profile`, { role: "worker" });
    expect(strip.status).toBe(400);
    expect(strip.body.error).toMatch(LOCKED_ERROR);

    await expectWorkerUnchanged();
    await expectExtensionUnchanged();
  });

  test("unrelated profile edits still work on both kinds of agent", async () => {
    expect((await updateAgentProfile(workerId, { role: "reviewer" }))?.role).toBe("reviewer");
    expect((await updateAgentProfile(extId, { description: "still an extension" }))?.role).toBe(
      "extension",
    );
    expect(await ensureExtensionAgent("tool-call-tracker")).toBe(extId);
  });
});
