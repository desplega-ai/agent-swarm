import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  createMcpServer,
  deleteMcpServer,
  getAgentMcpServers,
  getMcpServerById,
  getResolvedConfig,
  installMcpServer,
  listMcpServers,
  uninstallMcpServer,
  updateMcpServer,
} from "../be/db";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const listMcpServersRoute = route({
  method: "get",
  path: "/api/mcp-servers",
  pattern: ["api", "mcp-servers"],
  summary: "List MCP servers with optional filters",
  tags: ["MCP Servers"],
  auth: { apiKey: true },
  query: z.object({
    scope: z.string().optional(),
    transport: z.string().optional(),
    ownerAgentId: z.string().optional(),
    enabled: z.string().optional(),
    search: z.string().optional(),
  }),
  responses: {
    200: { description: "MCP server list" },
  },
});

const getMcpServerRoute = route({
  method: "get",
  path: "/api/mcp-servers/{id}",
  pattern: ["api", "mcp-servers", null],
  summary: "Get MCP server by ID",
  tags: ["MCP Servers"],
  auth: { apiKey: true },
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "MCP server details" },
    404: { description: "MCP server not found" },
  },
});

const createMcpServerRoute = route({
  method: "post",
  path: "/api/mcp-servers",
  pattern: ["api", "mcp-servers"],
  summary: "Create a new MCP server",
  tags: ["MCP Servers"],
  auth: { apiKey: true },
  body: z.object({
    name: z.string().min(1),
    transport: z.enum(["stdio", "http", "sse"]),
    description: z.string().optional(),
    scope: z.string().optional(),
    ownerAgentId: z.string().optional(),
    command: z.string().optional(),
    args: z.string().optional(),
    url: z.string().optional(),
    headers: z.string().optional(),
    envConfigKeys: z.string().optional(),
    headerConfigKeys: z.string().optional(),
  }),
  responses: {
    201: { description: "MCP server created" },
    400: { description: "Validation error" },
  },
});

const updateMcpServerRoute = route({
  method: "put",
  path: "/api/mcp-servers/{id}",
  pattern: ["api", "mcp-servers", null],
  summary: "Update an MCP server",
  tags: ["MCP Servers"],
  auth: { apiKey: true },
  params: z.object({ id: z.string() }),
  body: z.record(z.string(), z.unknown()),
  responses: {
    200: { description: "MCP server updated" },
    404: { description: "MCP server not found" },
  },
});

const deleteMcpServerRoute = route({
  method: "delete",
  path: "/api/mcp-servers/{id}",
  pattern: ["api", "mcp-servers", null],
  summary: "Delete an MCP server",
  tags: ["MCP Servers"],
  auth: { apiKey: true },
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "MCP server deleted" },
    404: { description: "MCP server not found" },
  },
});

const installMcpServerRoute = route({
  method: "post",
  path: "/api/mcp-servers/{id}/install",
  pattern: ["api", "mcp-servers", null, "install"],
  summary: "Install MCP server for an agent",
  tags: ["MCP Servers"],
  auth: { apiKey: true },
  params: z.object({ id: z.string() }),
  body: z.object({
    agentId: z.string(),
  }),
  responses: {
    200: { description: "MCP server installed" },
    404: { description: "MCP server not found" },
  },
});

const uninstallMcpServerRoute = route({
  method: "delete",
  path: "/api/mcp-servers/{id}/install/{agentId}",
  pattern: ["api", "mcp-servers", null, "install", null],
  summary: "Uninstall MCP server for an agent",
  tags: ["MCP Servers"],
  auth: { apiKey: true },
  params: z.object({ id: z.string(), agentId: z.string() }),
  responses: {
    200: { description: "MCP server uninstalled" },
  },
});

const getAgentMcpServersRoute = route({
  method: "get",
  path: "/api/agents/{id}/mcp-servers",
  pattern: ["api", "agents", null, "mcp-servers"],
  summary: "Get all MCP servers installed for an agent",
  tags: ["MCP Servers"],
  auth: { apiKey: true },
  params: z.object({ id: z.string() }),
  query: z.object({
    resolveSecrets: z.string().optional(),
  }),
  responses: {
    200: { description: "Agent MCP servers list" },
  },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleMcpServers(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  // GET /api/agents/:id/mcp-servers (must be before /api/mcp-servers routes)
  if (getAgentMcpServersRoute.match(req.method, pathSegments)) {
    const parsed = await getAgentMcpServersRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const servers = getAgentMcpServers(parsed.params.id);
    const resolveSecrets = parsed.query.resolveSecrets === "true";

    if (resolveSecrets) {
      const configs = getResolvedConfig(parsed.params.id);
      const configMap = new Map(configs.map((c) => [c.key, c.value]));

      const serversWithSecrets = servers.map((server) => {
        const resolvedEnv: Record<string, string> = {};
        const resolvedHeaders: Record<string, string> = {};

        // Resolve env config keys (JSON object: {"ENV_VAR": "config-key-name"})
        if (server.envConfigKeys) {
          try {
            const mapping = JSON.parse(server.envConfigKeys) as Record<string, string>;
            for (const [envVar, configKey] of Object.entries(mapping)) {
              const value = configMap.get(configKey);
              if (value !== undefined) {
                resolvedEnv[envVar] = value;
              }
            }
          } catch {
            // Invalid JSON — skip resolution
          }
        }

        // Resolve header config keys (JSON object: {"Header-Name": "config-key-name"})
        if (server.headerConfigKeys) {
          try {
            const mapping = JSON.parse(server.headerConfigKeys) as Record<string, string>;
            for (const [headerName, configKey] of Object.entries(mapping)) {
              const value = configMap.get(configKey);
              if (value !== undefined) {
                resolvedHeaders[headerName] = value;
              }
            }
          } catch {
            // Invalid JSON — skip resolution
          }
        }

        return { ...server, resolvedEnv, resolvedHeaders };
      });

      json(res, { servers: serversWithSecrets, total: serversWithSecrets.length });
    } else {
      json(res, { servers, total: servers.length });
    }
    return true;
  }

  // POST /api/mcp-servers/:id/install
  if (installMcpServerRoute.match(req.method, pathSegments)) {
    const parsed = await installMcpServerRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const server = getMcpServerById(parsed.params.id);
    if (!server) {
      jsonError(res, "MCP server not found", 404);
      return true;
    }

    try {
      const agentMcpServer = installMcpServer(parsed.body.agentId, parsed.params.id);
      json(res, { agentMcpServer });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Install failed", 400);
    }
    return true;
  }

  // DELETE /api/mcp-servers/:id/install/:agentId
  if (uninstallMcpServerRoute.match(req.method, pathSegments)) {
    const parsed = await uninstallMcpServerRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const removed = uninstallMcpServer(parsed.params.agentId, parsed.params.id);
    json(res, { success: removed });
    return true;
  }

  // GET /api/mcp-servers
  if (listMcpServersRoute.match(req.method, pathSegments)) {
    const parsed = await listMcpServersRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const servers = listMcpServers({
      scope: parsed.query.scope as "global" | "swarm" | "agent" | undefined,
      transport: parsed.query.transport as "stdio" | "http" | "sse" | undefined,
      ownerAgentId: parsed.query.ownerAgentId,
      isEnabled: parsed.query.enabled !== undefined ? parsed.query.enabled === "true" : undefined,
      search: parsed.query.search,
    });

    json(res, { servers, total: servers.length });
    return true;
  }

  // GET /api/mcp-servers/:id
  if (getMcpServerRoute.match(req.method, pathSegments)) {
    const parsed = await getMcpServerRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const server = getMcpServerById(parsed.params.id);
    if (!server) {
      jsonError(res, "MCP server not found", 404);
      return true;
    }
    json(res, server);
    return true;
  }

  // POST /api/mcp-servers
  if (createMcpServerRoute.match(req.method, pathSegments)) {
    const parsed = await createMcpServerRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    // Transport-specific validation
    if (parsed.body.transport === "stdio" && !parsed.body.command) {
      jsonError(res, "command is required for stdio transport", 400);
      return true;
    }
    if ((parsed.body.transport === "http" || parsed.body.transport === "sse") && !parsed.body.url) {
      jsonError(res, "url is required for http/sse transport", 400);
      return true;
    }

    try {
      const server = createMcpServer({
        name: parsed.body.name,
        transport: parsed.body.transport,
        description: parsed.body.description,
        scope: parsed.body.scope as "global" | "swarm" | "agent" | undefined,
        ownerAgentId: parsed.body.ownerAgentId,
        command: parsed.body.command,
        args: parsed.body.args,
        url: parsed.body.url,
        headers: parsed.body.headers,
        envConfigKeys: parsed.body.envConfigKeys,
        headerConfigKeys: parsed.body.headerConfigKeys,
      });
      json(res, { server }, 201);
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Create failed", 400);
    }
    return true;
  }

  // PUT /api/mcp-servers/:id
  if (updateMcpServerRoute.match(req.method, pathSegments)) {
    const parsed = await updateMcpServerRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    // Transport-specific validation on update (only if transport is being set)
    const transport = parsed.body.transport as string | undefined;
    if (transport === "stdio" && parsed.body.command === undefined) {
      // Check if existing server already has a command
      const existing = getMcpServerById(parsed.params.id);
      if (existing && !existing.command && !parsed.body.command) {
        jsonError(res, "command is required for stdio transport", 400);
        return true;
      }
    }
    if ((transport === "http" || transport === "sse") && parsed.body.url === undefined) {
      const existing = getMcpServerById(parsed.params.id);
      if (existing && !existing.url && !parsed.body.url) {
        jsonError(res, "url is required for http/sse transport", 400);
        return true;
      }
    }

    const server = updateMcpServer(
      parsed.params.id,
      parsed.body as Parameters<typeof updateMcpServer>[1],
    );
    if (!server) {
      jsonError(res, "MCP server not found", 404);
      return true;
    }
    json(res, { server });
    return true;
  }

  // DELETE /api/mcp-servers/:id
  if (deleteMcpServerRoute.match(req.method, pathSegments)) {
    const parsed = await deleteMcpServerRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const deleted = deleteMcpServer(parsed.params.id);
    if (!deleted) {
      jsonError(res, "MCP server not found", 404);
      return true;
    }
    json(res, { success: true });
    return true;
  }

  return false;
}
