import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  createMcpServer,
  deleteMcpServer,
  getAgentById,
  getAgentMcpServers,
  getMcpServerById,
  getResolvedConfig,
  installMcpServer,
  listMcpServers,
  uninstallMcpServer,
  updateMcpServer,
} from "../be/db";
import { enqueueAdmissionRow } from "../be/rbac-audit";
import { getUserGrant } from "../be/rbac-roles";
import { ensureMcpToken } from "../oauth/ensure-mcp-token";
import { assertUrlSafe, publicEndpointSsrfOptions } from "../oauth/mcp-wrapper";
import {
  can,
  isRbacEnabled,
  type PermissionVerb,
  type RbacPrincipal,
  type RbacResource,
} from "../rbac";
import { AgentMcpServerSchema, McpServerSchema, McpServerWithInstallInfoSchema } from "../types";
import { getRequestAuth } from "../utils/request-auth-context";
import { route } from "./route-def";
import { jsonError } from "./utils";

// ─── Response Schemas ────────────────────────────────────────────────────────

/**
 * `getAgentMcpServers` response shape. When `?resolveSecrets=true`, each
 * server is additionally decorated with resolved env/header values and any
 * OAuth resolution error — see the `resolveSecrets` branch in the handler.
 */
const McpServerWithOptionalSecretsSchema = McpServerWithInstallInfoSchema.extend({
  resolvedEnv: z.record(z.string(), z.string()).optional(),
  resolvedHeaders: z.record(z.string(), z.string()).optional(),
  authError: z.string().nullable().optional(),
});

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
    200: {
      description: "MCP server list",
      schema: z.object({ servers: z.array(McpServerSchema), total: z.number() }),
    },
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
    200: { description: "MCP server details", schema: McpServerSchema },
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
    201: { description: "MCP server created", schema: z.object({ server: McpServerSchema }) },
    400: { description: "Validation error" },
  },
  rbac: { permission: "mcp-server.create.swarm" },
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
    200: { description: "MCP server updated", schema: z.object({ server: McpServerSchema }) },
    404: { description: "MCP server not found" },
  },
  rbac: { permission: "mcp-server.update.any" },
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
    200: {
      description: "MCP server deleted",
      schema: z.object({
        success: z.boolean(),
        deletedScriptConnectionCount: z.number(),
      }),
    },
    404: { description: "MCP server not found" },
  },
  rbac: { permission: "mcp-server.delete.any" },
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
    200: {
      description: "MCP server installed",
      schema: z.object({ agentMcpServer: AgentMcpServerSchema }),
    },
    404: { description: "MCP server not found" },
  },
  rbac: { permission: "mcp-server.install.any" },
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
    200: {
      description: "MCP server uninstalled",
      schema: z.object({ success: z.boolean() }),
    },
  },
  rbac: { permission: "mcp-server.uninstall.any" },
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
    200: {
      description: "Agent MCP servers list",
      schema: z.object({
        servers: z.array(McpServerWithOptionalSecretsSchema),
        total: z.number(),
      }),
    },
  },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

function canResolveMcpSecretsForHttpUser(req: IncomingMessage): boolean {
  const auth = getRequestAuth(req);
  if (auth?.kind !== "user") return true;
  if (!isRbacEnabled()) return true;

  const verb: PermissionVerb = "mcp-server.read.secrets";
  const grant = getUserGrant(auth.userId);
  const decision =
    grant.grantsAll || grant.verbs.has(verb)
      ? ({ allow: true, verb } as const)
      : ({
          allow: false,
          reason: `admission: missing permission '${verb}'`,
          verb,
        } as const);
  enqueueAdmissionRow({
    userId: auth.userId,
    decision,
    method: req.method,
    route: getAgentMcpServersRoute.def.path,
  });
  return decision.allow;
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * MCP server management is an agent-owned surface. Prefer the supplied agent
 * identity even when the request carries the shared API key, so that an agent
 * cannot use that key to bypass the route's declared RBAC permission.
 */
function mcpServerPrincipal(req: IncomingMessage): RbacPrincipal {
  const agentId = singleHeader(req, "x-agent-id");
  if (agentId) {
    const agent = getAgentById(agentId);
    return { kind: "agent", agentId, isLead: agent?.isLead ?? false };
  }

  const auth = getRequestAuth(req);
  if (auth?.kind === "operator") return { kind: "operator" };
  if (auth?.kind === "user") return { kind: "user", userId: auth.userId };
  return { kind: "agent", agentId: "", isLead: false };
}

function ensureMcpServerPermission(
  req: IncomingMessage,
  res: ServerResponse,
  verb: Extract<PermissionVerb, "mcp-server.create.swarm" | "mcp-server.update.any">,
  resource: RbacResource,
): boolean {
  const principal = mcpServerPrincipal(req);
  // The shared API key without an agent identity is the HTTP admin context.
  // An X-Agent-ID always takes precedence above, so agents cannot use that key
  // to bypass the permission declared on this route.
  if (principal.kind === "operator") return true;

  const decision = can({
    principal,
    verb,
    resource,
    source: "http",
  });
  if (decision.allow) return true;
  jsonError(res, `Forbidden: ${decision.reason}`, 403);
  return false;
}

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
      if (!canResolveMcpSecretsForHttpUser(req)) {
        jsonError(res, "Forbidden: admission: missing permission 'mcp-server.read.secrets'", 403);
        return true;
      }

      const configs = getResolvedConfig(parsed.params.id);
      const configMap = new Map(configs.map((c) => [c.key, c.value]));

      const serversWithSecrets = await Promise.all(
        servers.map(async (server) => {
          const resolvedEnv: Record<string, string> = {};
          const resolvedHeaders: Record<string, string> = {};
          let authError: string | null = null;

          // Resolve env config keys
          // Supports both array format ["KEY_A", "KEY_B"] (key = config key = element)
          // and object format {"ENV_VAR": "config-key-name"}
          if (server.envConfigKeys) {
            try {
              const parsed = JSON.parse(server.envConfigKeys);
              if (Array.isArray(parsed)) {
                for (const key of parsed) {
                  const value = configMap.get(key);
                  if (value !== undefined) {
                    resolvedEnv[key] = value;
                  }
                }
              } else {
                for (const [envVar, configKey] of Object.entries(
                  parsed as Record<string, string>,
                )) {
                  const value = configMap.get(configKey);
                  if (value !== undefined) {
                    resolvedEnv[envVar] = value;
                  }
                }
              }
            } catch {
              // Invalid JSON — skip resolution
            }
          }

          // Resolve header config keys
          // Supports both array format ["Header-A", "Header-B"] and object format {"Header-Name": "config-key-name"}
          if (server.headerConfigKeys) {
            try {
              const parsed = JSON.parse(server.headerConfigKeys);
              if (Array.isArray(parsed)) {
                for (const key of parsed) {
                  const value = configMap.get(key);
                  if (value !== undefined) {
                    resolvedHeaders[key] = value;
                  }
                }
              } else {
                for (const [headerName, configKey] of Object.entries(
                  parsed as Record<string, string>,
                )) {
                  const value = configMap.get(configKey);
                  if (value !== undefined) {
                    resolvedHeaders[headerName] = value;
                  }
                }
              }
            } catch {
              // Invalid JSON — skip resolution
            }
          }

          // OAuth-injected Authorization header: for authMethod='oauth' the
          // DB-backed token overrides anything the static header resolver put
          // in place. Refresh if expiring. If refresh fails we return an
          // authError field so the worker / operator can see why the bearer
          // is missing, rather than silently serving a stale header.
          if (server.authMethod === "oauth") {
            delete resolvedHeaders.Authorization;
            delete resolvedHeaders.authorization;
            try {
              const token = await ensureMcpToken(server.id);
              if (token && token.status === "connected") {
                // Normalize the bearer scheme to capital "Bearer": some resource
                // servers reject the lowercase "bearer" RFC 6749 returns (issue #368).
                // Non-bearer schemes (e.g. "MAC") are preserved verbatim.
                const rawType = token.tokenType || "Bearer";
                const prefix = rawType.toLowerCase() === "bearer" ? "Bearer" : rawType;
                resolvedHeaders.Authorization = `${prefix} ${token.accessToken}`;
              } else if (!token) {
                authError = "No OAuth token for this MCP server";
              } else {
                authError = token.lastErrorMessage ?? `OAuth status: ${token.status}`;
              }
            } catch (err) {
              authError = err instanceof Error ? err.message : String(err);
              console.error(`[mcp-oauth] resolveSecrets failed for ${server.id}: ${authError}`);
            }
          }

          return { ...server, resolvedEnv, resolvedHeaders, authError };
        }),
      );

      getAgentMcpServersRoute.respond(res, 200, {
        servers: serversWithSecrets,
        total: serversWithSecrets.length,
      });
    } else {
      getAgentMcpServersRoute.respond(res, 200, { servers, total: servers.length });
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
      installMcpServerRoute.respond(res, 200, { agentMcpServer });
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
    uninstallMcpServerRoute.respond(res, 200, { success: removed });
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

    listMcpServersRoute.respond(res, 200, { servers, total: servers.length });
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
    getMcpServerRoute.respond(res, 200, server);
    return true;
  }

  // POST /api/mcp-servers
  if (createMcpServerRoute.match(req.method, pathSegments)) {
    const parsed = await createMcpServerRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    if (!ensureMcpServerPermission(req, res, "mcp-server.create.swarm", { kind: "none" })) {
      return true;
    }

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
      if (parsed.body.url) {
        assertUrlSafe(parsed.body.url, publicEndpointSsrfOptions());
      }
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
      createMcpServerRoute.respond(res, 201, { server });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Create failed", 400);
    }
    return true;
  }

  // PUT /api/mcp-servers/:id
  if (updateMcpServerRoute.match(req.method, pathSegments)) {
    const parsed = await updateMcpServerRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const existing = getMcpServerById(parsed.params.id);
    if (!existing) {
      jsonError(res, "MCP server not found", 404);
      return true;
    }
    if (
      !ensureMcpServerPermission(req, res, "mcp-server.update.any", {
        kind: "owned",
        ownerAgentId: existing.ownerAgentId,
      })
    ) {
      return true;
    }

    // Transport-specific validation on update (only if transport is being set)
    const transport = parsed.body.transport as string | undefined;
    if (transport === "stdio" && parsed.body.command === undefined) {
      // Check if existing server already has a command
      if (existing && !existing.command && !parsed.body.command) {
        jsonError(res, "command is required for stdio transport", 400);
        return true;
      }
    }
    if ((transport === "http" || transport === "sse") && parsed.body.url === undefined) {
      if (existing && !existing.url && !parsed.body.url) {
        jsonError(res, "url is required for http/sse transport", 400);
        return true;
      }
    }

    try {
      if (typeof parsed.body.url === "string") {
        assertUrlSafe(parsed.body.url, publicEndpointSsrfOptions());
      }
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Invalid MCP server URL", 400);
      return true;
    }

    const server = updateMcpServer(
      parsed.params.id,
      parsed.body as Parameters<typeof updateMcpServer>[1],
    );
    if (!server) {
      jsonError(res, "MCP server not found", 404);
      return true;
    }
    updateMcpServerRoute.respond(res, 200, { server });
    return true;
  }

  // DELETE /api/mcp-servers/:id
  if (deleteMcpServerRoute.match(req.method, pathSegments)) {
    const parsed = await deleteMcpServerRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const result = deleteMcpServer(parsed.params.id);
    if (!result.deleted) {
      jsonError(res, "MCP server not found", 404);
      return true;
    }
    deleteMcpServerRoute.respond(res, 200, {
      success: true,
      deletedScriptConnectionCount: result.deletedScriptConnectionCount,
    });
    return true;
  }

  return false;
}
