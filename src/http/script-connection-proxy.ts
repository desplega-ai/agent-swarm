import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getAgentById } from "@/be/db";
import { callMcpServerTool } from "@/be/mcp-proxy";
import { getScriptConnectionById } from "@/be/script-connections";
import { can } from "@/rbac";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

const mcpCallRoute = route({
  method: "post",
  path: "/api/script-connections/{id}/mcp-call",
  pattern: ["api", "script-connections", null, "mcp-call"],
  summary: "Invoke a tool on an MCP script connection",
  tags: ["Script Connections"],
  auth: { apiKey: true, agentId: true },
  rbac: { permission: "script-connection.invoke" },
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    tool: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
  }),
  responses: {
    200: { description: "MCP call result" },
    400: { description: "Invalid MCP connection or request" },
    403: { description: "Not allowed to invoke this MCP connection" },
    404: { description: "Script connection or agent not found" },
  },
});

function connectionScopeMatches(
  connection: { scope: string; scopeId: string | null },
  agentId: string,
): boolean {
  if (connection.scope === "global") return true;
  if (connection.scope === "agent") return connection.scopeId === agentId;
  return false;
}

export async function handleScriptConnectionProxy(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  agentId: string | undefined,
): Promise<boolean> {
  if (!mcpCallRoute.match(req.method, pathSegments)) return false;

  const parsed = await mcpCallRoute.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;

  if (!agentId) {
    jsonError(res, "X-Agent-ID required for script connection MCP proxy", 400);
    return true;
  }
  const agent = getAgentById(agentId);
  if (!agent) {
    jsonError(res, "Agent not found", 404);
    return true;
  }

  const decision = can({
    principal: { kind: "agent", agentId, isLead: agent.isLead },
    verb: "script-connection.invoke",
    resource: { kind: "none" },
    source: "http",
  });
  if (!decision.allow) {
    jsonError(res, decision.reason, 403);
    return true;
  }

  const connection = getScriptConnectionById(parsed.params.id);
  if (!connection) {
    jsonError(res, "Script connection not found", 404);
    return true;
  }
  if (!connection.enabled) {
    jsonError(res, "Script connection is disabled", 403);
    return true;
  }
  if (connection.kind !== "mcp") {
    jsonError(res, "Script connection is not an MCP connection", 400);
    return true;
  }
  if (!connectionScopeMatches(connection, agentId)) {
    jsonError(res, "Script connection is not available to this agent", 403);
    return true;
  }
  if (!connection.mcpServerId) {
    jsonError(res, "Script MCP connection is missing mcpServerId", 400);
    return true;
  }

  try {
    const result = await callMcpServerTool(
      connection.mcpServerId,
      parsed.body.tool,
      parsed.body.arguments ?? {},
      { agentId, timeoutMs: 30_000 },
    );
    json(res, result);
  } catch (err) {
    json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}
