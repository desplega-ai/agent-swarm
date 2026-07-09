import { getMcpServerById, getResolvedConfig } from "@/be/db";
import { McpHttpClient, type McpTool, type McpToolCallEnvelope } from "@/mcp-client/http-client";
import { ensureMcpToken } from "@/oauth/ensure-mcp-token";
import type { McpServer } from "@/types";
import { registerVolatileSecret } from "@/utils/secret-scrubber";

const MCP_PROXY_TIMEOUT_MS = 30_000;

function parseHeadersJson(value: string | null): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([key, headerValue]) => [key, headerValue]),
    );
  } catch {
    return {};
  }
}

function resolveHeaderConfigKeys(
  headerConfigKeys: string | null,
  context: { agentId?: string; repoId?: string },
): Record<string, string> {
  if (!headerConfigKeys) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(headerConfigKeys);
  } catch {
    return {};
  }

  const configs = getResolvedConfig(context.agentId, context.repoId);
  const configMap = new Map(configs.map((config) => [config.key, config.value]));
  const resolved: Record<string, string> = {};

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const value = configMap.get(item);
      if (value === undefined) continue;
      registerVolatileSecret(value, `mcp-header:${item}`);
      resolved[item] = value;
    }
    return resolved;
  }

  if (!parsed || typeof parsed !== "object") return resolved;
  for (const [headerName, configKey] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof configKey !== "string") continue;
    const value = configMap.get(configKey);
    if (value === undefined) continue;
    registerVolatileSecret(value, `mcp-header:${configKey}`);
    resolved[headerName] = value;
  }
  return resolved;
}

async function resolveMcpHeaders(
  server: McpServer,
  context: { agentId?: string; repoId?: string },
): Promise<Record<string, string>> {
  const headers = {
    ...parseHeadersJson(server.headers),
    ...resolveHeaderConfigKeys(server.headerConfigKeys, context),
  };

  if (server.authMethod !== "oauth") return headers;

  delete headers.Authorization;
  delete headers.authorization;
  const token = await ensureMcpToken(server.id);
  if (!token) throw new Error("No OAuth token for this MCP server");
  if (token.status !== "connected") {
    throw new Error(token.lastErrorMessage ?? `OAuth status: ${token.status}`);
  }

  registerVolatileSecret(token.accessToken, `mcp-oauth:${server.id}`);
  const rawType = token.tokenType || "Bearer";
  const prefix = rawType.toLowerCase() === "bearer" ? "Bearer" : rawType;
  headers.Authorization = `${prefix} ${token.accessToken}`;
  return headers;
}

async function createMcpServerClient(
  serverId: string,
  context: { agentId?: string; repoId?: string; timeoutMs?: number } = {},
): Promise<McpHttpClient> {
  const server = getMcpServerById(serverId);
  if (!server) throw new Error("MCP server not found");
  if (!server.isEnabled) throw new Error("MCP server is disabled");
  if (server.transport === "sse") {
    throw new Error("SSE MCP servers are not supported yet — use a streamable HTTP server");
  }
  if (server.transport !== "http") {
    throw new Error("Only streamable HTTP MCP servers are supported by script connections");
  }
  if (!server.url) throw new Error("MCP server URL is required");

  const client = new McpHttpClient(server.url, "", "", undefined, {
    clientInfo: { name: "agent-swarm-script-mcp-proxy", version: "1.0.0" },
    omitEmptyAuthHeaders: true,
    timeoutMs: context.timeoutMs ?? MCP_PROXY_TIMEOUT_MS,
  });
  client.useRawUrl = true;
  client.customHeaders = await resolveMcpHeaders(server, context);
  return client;
}

export async function listMcpServerTools(
  serverId: string,
  context: { agentId?: string; repoId?: string; timeoutMs?: number } = {},
): Promise<McpTool[]> {
  const client = await createMcpServerClient(serverId, context);
  await client.initialize();
  return client.listTools();
}

export async function callMcpServerTool(
  serverId: string,
  tool: string,
  args: Record<string, unknown>,
  context: { agentId?: string; repoId?: string; timeoutMs?: number } = {},
): Promise<McpToolCallEnvelope> {
  const client = await createMcpServerClient(serverId, context);
  await client.initialize();
  return client.callToolRaw(tool, args);
}
