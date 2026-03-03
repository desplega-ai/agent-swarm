import type { IncomingMessage, ServerResponse } from "node:http";
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
import { agentWithCapacity } from "./utils";

export async function handleAgentRegister(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  myAgentId: string | undefined,
): Promise<boolean> {
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "agents" &&
    !pathSegments[2]
  ) {
    // Parse request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    // Validate required fields
    if (!body.name || typeof body.name !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or invalid 'name' field" }));
      return true;

    }

    // Use X-Agent-ID header if provided, otherwise generate new UUID
    const agentId = myAgentId || crypto.randomUUID();

    // Use transaction to ensure atomicity of check-and-create/update
    const result = getDb().transaction(() => {
      // Check if agent already exists
      const existingAgent = getAgentById(agentId);
      if (existingAgent) {
        // Update status to idle if offline
        if (existingAgent.status === "offline") {
          updateAgentStatus(existingAgent.id, "idle");
        }
        // Update maxTasks if provided (allows runner to sync its MAX_CONCURRENT_TASKS)
        if (body.maxTasks !== undefined && body.maxTasks !== existingAgent.maxTasks) {
          updateAgentMaxTasks(existingAgent.id, body.maxTasks);
        }
        // Reset empty poll count on re-registration (agent is starting fresh)
        resetEmptyPollCount(existingAgent.id);
        return { agent: getAgentById(agentId), created: false };
      }

      // Create new agent
      const agent = createAgent({
        id: agentId,
        name: body.name,
        isLead: body.isLead ?? false,
        status: "idle",
        description: body.description,
        role: body.role,
        capabilities: body.capabilities,
        maxTasks: body.maxTasks ?? 1,
      });

      return { agent, created: true };
    })();

    res.writeHead(result.created ? 201 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.agent));
    return true;

  }

  return false;
}

export async function handleAgentsRest(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "agents" &&
    !pathSegments[2]
  ) {
    const includeTasks = queryParams.get("include") === "tasks";
    const agents = includeTasks ? getAllAgentsWithTasks() : getAllAgents();
    const agentsWithCapacity = agents.map(agentWithCapacity);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ agents: agentsWithCapacity }));
    return true;

  }

  // PUT /api/agents/:id/name - Update agent name (check before GET to avoid conflict)
  if (
    req.method === "PUT" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "agents" &&
    pathSegments[2] &&
    pathSegments[3] === "name"
  ) {
    const agentId = pathSegments[2];

    // Parse request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const bodyText = Buffer.concat(chunks).toString();

    let body: { name?: string };
    try {
      body = JSON.parse(bodyText);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return true;

    }

    if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid name" }));
      return true;

    }

    try {
      const agent = updateAgentName(agentId, body.name.trim());
      if (!agent) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Agent not found" }));
        return true;

      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(agentWithCapacity(agent)));
    } catch (error) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
    return true;

  }

  // GET /api/agents/:id/setup-script - Fetch agent + global setup scripts for Docker entrypoint
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "agents" &&
    pathSegments[2] &&
    pathSegments[3] === "setup-script"
  ) {
    const agentId = pathSegments[2];
    const agent = getAgentById(agentId);
    if (!agent) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Agent not found" }));
      return true;

    }

    // Fetch global setup script from swarm_config
    const globalConfigs = getSwarmConfigs({ scope: "global", key: "SETUP_SCRIPT" });
    const globalSetupScript = globalConfigs[0]?.value ?? null;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        setupScript: agent.setupScript ?? null,
        globalSetupScript,
      }),
    );
    return true;

  }

  // PUT /api/agents/:id/profile - Update agent profile (role, description, capabilities)
  if (
    req.method === "PUT" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "agents" &&
    pathSegments[2] &&
    pathSegments[3] === "profile"
  ) {
    const agentId = pathSegments[2];

    // Parse request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const bodyText = Buffer.concat(chunks).toString();

    let body: {
      role?: string;
      description?: string;
      capabilities?: string[];
      claudeMd?: string;
      soulMd?: string;
      identityMd?: string;
      setupScript?: string;
      toolsMd?: string;
      changeSource?: string;
      changedByAgentId?: string;
      changeReason?: string;
    };
    try {
      body = JSON.parse(bodyText);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return true;

    }

    // At least one field must be provided
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
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error:
            "At least one field (role, description, capabilities, claudeMd, soulMd, identityMd, setupScript, or toolsMd) must be provided",
        }),
      );
      return true;

    }

    // Validate role length if provided
    if (body.role !== undefined && body.role.length > 100) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Role must be 100 characters or less" }));
      return true;

    }

    // Validate capabilities if provided
    if (body.capabilities !== undefined && !Array.isArray(body.capabilities)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Capabilities must be an array of strings" }));
      return true;

    }

    // Validate text field sizes (max 64KB each)
    for (const field of ["claudeMd", "soulMd", "identityMd", "setupScript", "toolsMd"] as const) {
      const value = body[field];
      if (value !== undefined && value.length > 65536) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `${field} must be 64KB or less` }));
        return true;

      }
    }

    // Build version metadata if provided
    const validChangeSources = ["self_edit", "lead_coaching", "api", "system", "session_sync"];
    const versionMeta =
      body.changeSource || body.changedByAgentId || body.changeReason
        ? {
            changeSource: validChangeSources.includes(body.changeSource ?? "")
              ? (body.changeSource as import("./types").ChangeSource)
              : undefined,
            changedByAgentId: body.changedByAgentId ?? null,
            changeReason: body.changeReason ?? null,
          }
        : undefined;

    const agent = updateAgentProfile(
      agentId,
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
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Agent not found" }));
      return true;

    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(agentWithCapacity(agent)));
    return true;

  }

  // PUT /api/agents/:id/activity - Update agent last activity timestamp
  if (
    req.method === "PUT" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "agents" &&
    pathSegments[2] &&
    pathSegments[3] === "activity"
  ) {
    const agentId = pathSegments[2];
    updateAgentActivity(agentId);
    res.writeHead(204);
    res.end();
    return true;

  }

  // GET /api/agents/:id - Get single agent (optionally with tasks)
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "agents" &&
    pathSegments[2] &&
    !pathSegments[3]
  ) {
    const agentId = pathSegments[2];
    const includeTasks = queryParams.get("include") === "tasks";
    const agent = includeTasks ? getAgentWithTasks(agentId) : getAgentById(agentId);

    if (!agent) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Agent not found" }));
      return true;

    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(agentWithCapacity(agent)));
    return true;

  }

  // GET /api/tasks - List all tasks (with optional filters: status, agentId, search)

  return false;
}
