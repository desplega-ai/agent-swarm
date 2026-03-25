import type { IncomingMessage, ServerResponse } from "node:http";
import { ensure } from "@desplega.ai/business-use";
import { z } from "zod";
import {
  createAgent,
  getAgentById,
  getAgentWithTasks,
  getAllAgents,
  getAllAgentsWithTasks,
  getDb,
  getSwarmConfigs,
  resetEmptyPollCount,
  updateAgentActivity,
  updateAgentMaxTasks,
  updateAgentName,
  updateAgentProfile,
  updateAgentStatus,
} from "../be/db";
import { route } from "./route-def";
import { agentWithCapacity, json, jsonError } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const registerAgent = route({
  method: "post",
  path: "/api/agents",
  pattern: ["api", "agents"],
  summary: "Register or re-register an agent",
  tags: ["Agents"],
  body: z.object({
    name: z.string().min(1),
    isLead: z.boolean().optional(),
    description: z.string().optional(),
    role: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    maxTasks: z.number().int().optional(),
  }),
  responses: {
    200: { description: "Agent re-registered (already existed)" },
    201: { description: "Agent created" },
    400: { description: "Validation error" },
  },
});

const listAgents = route({
  method: "get",
  path: "/api/agents",
  pattern: ["api", "agents"],
  summary: "List all agents",
  tags: ["Agents"],
  query: z.object({
    include: z.enum(["tasks"]).optional(),
  }),
  responses: {
    200: { description: "Agent list with capacity info" },
  },
});

const updateAgentNameRoute = route({
  method: "put",
  path: "/api/agents/{id}/name",
  pattern: ["api", "agents", null, "name"],
  summary: "Update agent name",
  tags: ["Agents"],
  params: z.object({ id: z.string() }),
  body: z.object({ name: z.string().min(1) }),
  responses: {
    200: { description: "Agent updated" },
    404: { description: "Agent not found" },
    409: { description: "Name conflict" },
  },
});

const getAgentSetupScript = route({
  method: "get",
  path: "/api/agents/{id}/setup-script",
  pattern: ["api", "agents", null, "setup-script"],
  summary: "Fetch agent + global setup scripts for Docker entrypoint",
  tags: ["Agents"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Setup scripts" },
    404: { description: "Agent not found" },
  },
});

const updateAgentProfileRoute = route({
  method: "put",
  path: "/api/agents/{id}/profile",
  pattern: ["api", "agents", null, "profile"],
  summary: "Update agent profile (role, description, capabilities, etc.)",
  tags: ["Agents"],
  params: z.object({ id: z.string() }),
  body: z.object({
    role: z.string().max(100).optional(),
    description: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    claudeMd: z.string().max(65536).optional(),
    soulMd: z.string().max(65536).optional(),
    identityMd: z.string().max(65536).optional(),
    setupScript: z.string().max(65536).optional(),
    toolsMd: z.string().max(65536).optional(),
    changeSource: z.string().optional(),
    changedByAgentId: z.string().optional(),
    changeReason: z.string().optional(),
  }),
  responses: {
    200: { description: "Profile updated" },
    400: { description: "Validation error" },
    404: { description: "Agent not found" },
  },
});

const updateAgentActivityRoute = route({
  method: "put",
  path: "/api/agents/{id}/activity",
  pattern: ["api", "agents", null, "activity"],
  summary: "Update agent last activity timestamp",
  tags: ["Agents"],
  params: z.object({ id: z.string() }),
  responses: {
    204: { description: "Activity updated" },
  },
});

const getAgent = route({
  method: "get",
  path: "/api/agents/{id}",
  pattern: ["api", "agents", null],
  summary: "Get a single agent",
  tags: ["Agents"],
  params: z.object({ id: z.string() }),
  query: z.object({
    include: z.enum(["tasks"]).optional(),
  }),
  responses: {
    200: { description: "Agent with capacity info" },
    404: { description: "Agent not found" },
  },
});

// ─── Handlers ────────────────────────────────────────────────────────────────

export async function handleAgentRegister(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  myAgentId: string | undefined,
): Promise<boolean> {
  if (registerAgent.match(req.method, pathSegments)) {
    const parsed = await registerAgent.parse(req, res, pathSegments, new URLSearchParams());
    if (!parsed) return true;

    const agentId = myAgentId || crypto.randomUUID();

    const result = getDb().transaction(() => {
      const existingAgent = getAgentById(agentId);
      if (existingAgent) {
        if (existingAgent.status === "offline") {
          updateAgentStatus(existingAgent.id, "idle");
        }
        if (parsed.body.maxTasks !== undefined && parsed.body.maxTasks !== existingAgent.maxTasks) {
          updateAgentMaxTasks(existingAgent.id, parsed.body.maxTasks);
        }
        resetEmptyPollCount(existingAgent.id);
        return { agent: getAgentById(agentId), created: false };
      }

      const agent = createAgent({
        id: agentId,
        name: parsed.body.name,
        isLead: parsed.body.isLead ?? false,
        status: "idle",
        description: parsed.body.description,
        role: parsed.body.role,
        capabilities: parsed.body.capabilities ?? [],
        maxTasks: parsed.body.maxTasks ?? 1,
      });

      return { agent, created: true };
    })();

    if (result.created) {
      ensure({
        id: "registered",
        flow: "agent",
        runId: agentId,
        data: {
          agentId,
          name: parsed.body.name,
          isLead: parsed.body.isLead ?? false,
        },
      });
    } else {
      ensure({
        id: "reconnected",
        flow: "agent",
        runId: agentId,
        depIds: ["registered"],
        data: {
          agentId,
          name: parsed.body.name,
        },
        validator: (_data, ctx) => {
          // Validates that registered happened before reconnected
          return ctx.deps.length > 0;
        },
      });
    }

    json(res, result.agent, result.created ? 201 : 200);
    return true;
  }

  return false;
}

export async function handleAgentsRest(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  _myAgentId: string | undefined,
): Promise<boolean> {
  if (listAgents.match(req.method, pathSegments)) {
    const parsed = await listAgents.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const includeTasks = parsed.query.include === "tasks";
    const agents = includeTasks ? getAllAgentsWithTasks() : getAllAgents();
    const agentsWithCapacity = agents.map(agentWithCapacity);
    json(res, { agents: agentsWithCapacity });
    return true;
  }

  if (updateAgentNameRoute.match(req.method, pathSegments)) {
    const parsed = await updateAgentNameRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    try {
      const agent = updateAgentName(parsed.params.id, parsed.body.name.trim());
      if (!agent) {
        jsonError(res, "Agent not found", 404);
        return true;
      }
      json(res, agentWithCapacity(agent));
    } catch (error) {
      jsonError(res, (error as Error).message, 409);
    }
    return true;
  }

  if (getAgentSetupScript.match(req.method, pathSegments)) {
    const parsed = await getAgentSetupScript.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const agent = getAgentById(parsed.params.id);
    if (!agent) {
      jsonError(res, "Agent not found", 404);
      return true;
    }
    const globalConfigs = getSwarmConfigs({ scope: "global", key: "SETUP_SCRIPT" });
    const globalSetupScript = globalConfigs[0]?.value ?? null;
    json(res, {
      setupScript: agent.setupScript ?? null,
      globalSetupScript,
    });
    return true;
  }

  if (updateAgentProfileRoute.match(req.method, pathSegments)) {
    const parsed = await updateAgentProfileRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const body = parsed.body;

    // At least one profile field must be provided
    if (
      body.role === undefined &&
      body.description === undefined &&
      body.capabilities === undefined &&
      body.claudeMd === undefined &&
      body.soulMd === undefined &&
      body.identityMd === undefined &&
      body.setupScript === undefined &&
      body.toolsMd === undefined
    ) {
      jsonError(
        res,
        "At least one field (role, description, capabilities, claudeMd, soulMd, identityMd, setupScript, or toolsMd) must be provided",
        400,
      );
      return true;
    }

    // Build version metadata if provided
    const validChangeSources = ["self_edit", "lead_coaching", "api", "system", "session_sync"];
    const versionMeta =
      body.changeSource || body.changedByAgentId || body.changeReason
        ? {
            changeSource: validChangeSources.includes(body.changeSource ?? "")
              ? (body.changeSource as import("../types").ChangeSource)
              : undefined,
            changedByAgentId: body.changedByAgentId ?? null,
            changeReason: body.changeReason ?? null,
          }
        : undefined;

    const agent = updateAgentProfile(
      parsed.params.id,
      {
        role: body.role,
        description: body.description,
        capabilities: body.capabilities,
        claudeMd: body.claudeMd,
        soulMd: body.soulMd,
        identityMd: body.identityMd,
        setupScript: body.setupScript,
        toolsMd: body.toolsMd,
      },
      versionMeta,
    );

    if (!agent) {
      jsonError(res, "Agent not found", 404);
      return true;
    }

    json(res, agentWithCapacity(agent));
    return true;
  }

  if (updateAgentActivityRoute.match(req.method, pathSegments)) {
    const parsed = await updateAgentActivityRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    updateAgentActivity(parsed.params.id);
    res.writeHead(204);
    res.end();
    return true;
  }

  if (getAgent.match(req.method, pathSegments)) {
    const parsed = await getAgent.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const includeTasks = parsed.query.include === "tasks";
    const agent = includeTasks
      ? getAgentWithTasks(parsed.params.id)
      : getAgentById(parsed.params.id);

    if (!agent) {
      jsonError(res, "Agent not found", 404);
      return true;
    }

    json(res, agentWithCapacity(agent));
    return true;
  }

  return false;
}
