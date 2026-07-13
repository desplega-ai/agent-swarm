import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { getAgentById, getResolvedConfig } from "@/be/db";
import { createServer } from "@/server";
import { resolveScriptsOnlyMode } from "@/utils/scripts-only-mode";

export type McpTransportActivity = Record<string, number>;
export type McpSessionAgents = Record<string, string>;

export const DEFAULT_MCP_TRANSPORT_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export function markMcpTransportActivity(
  sessionActivity: McpTransportActivity,
  sessionId: string | undefined,
  now = Date.now(),
): void {
  if (sessionId) {
    sessionActivity[sessionId] = now;
  }
}

export function closeIdleMcpTransports(
  transports: Record<string, StreamableHTTPServerTransport>,
  sessionActivity: McpTransportActivity,
  options: {
    now?: number;
    idleTimeoutMs?: number;
    label?: string;
    onClose?: (id: string) => void;
  } = {},
): number {
  const now = options.now ?? Date.now();
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_MCP_TRANSPORT_IDLE_TIMEOUT_MS;
  let closed = 0;

  for (const [id, transport] of Object.entries(transports)) {
    const lastActivity = sessionActivity[id];
    if (lastActivity === undefined) {
      sessionActivity[id] = now;
      continue;
    }
    if (now - lastActivity < idleTimeoutMs) continue;

    try {
      transport.close();
    } catch (err) {
      console.warn(`[HTTP] Failed to close idle ${options.label ?? "MCP"} transport ${id}: ${err}`);
    } finally {
      delete transports[id];
      delete sessionActivity[id];
      options.onClose?.(id);
      closed++;
    }
  }

  return closed;
}

function unauthorized(res: ServerResponse, message = "Unauthorized"): true {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
  return true;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requireKnownAgent(req: IncomingMessage, res: ServerResponse): string | true {
  const agentId = headerValue(req.headers["x-agent-id"]);
  if (!agentId) return unauthorized(res, "Missing X-Agent-ID header");
  if (!getAgentById(agentId)) return unauthorized(res, "Agent not found");
  return agentId;
}

function validateBoundAgent(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string | undefined,
  sessionAgents: McpSessionAgents,
): true | undefined {
  if (!sessionId) return undefined;
  const boundAgentId = sessionAgents[sessionId];
  if (!boundAgentId) return undefined;

  const agentId = headerValue(req.headers["x-agent-id"]);
  if (!agentId) {
    return unauthorized(res, "Missing X-Agent-ID header");
  }
  if (agentId !== boundAgentId) {
    return unauthorized(res, "X-Agent-ID does not match MCP session");
  }
  return undefined;
}

export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  transports: Record<string, StreamableHTTPServerTransport>,
  sessionActivity: McpTransportActivity = {},
  sessionAgents: McpSessionAgents = {},
): Promise<boolean> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (req.url !== "/mcp") {
    return false;
  }

  const agentMismatch = validateBoundAgent(req, res, sessionId, sessionAgents);
  if (agentMismatch) return true;

  if (req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
      markMcpTransportActivity(sessionActivity, sessionId);
    } else if (!sessionId && isInitializeRequest(body)) {
      const agentId = requireKnownAgent(req, res);
      if (agentId === true) return true;

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport;
          sessionAgents[id] = agentId;
          markMcpTransportActivity(sessionActivity, id);
        },
        onsessionclosed: (id) => {
          delete transports[id];
          delete sessionAgents[id];
          delete sessionActivity[id];
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId];
          delete sessionAgents[transport.sessionId];
          delete sessionActivity[transport.sessionId];
        }
      };

      const configValue = getResolvedConfig(agentId).find(
        (config) => config.key === "SCRIPTS_ONLY_MCP",
      )?.value;
      const server = createServer({
        scriptsOnly: resolveScriptsOnlyMode({
          env: process.env.SCRIPTS_ONLY_MCP,
          configValue,
        }),
      });
      await server.connect(transport);
    } else {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Invalid session" },
          id: null,
        }),
      );
      return true;
    }

    await transport.handleRequest(req, res, body);
    markMcpTransportActivity(sessionActivity, transport.sessionId);
    return true;
  }

  if (req.method === "GET" || req.method === "DELETE") {
    if (sessionId && transports[sessionId]) {
      markMcpTransportActivity(sessionActivity, sessionId);
      await transports[sessionId].handleRequest(req, res);
      return true;
    }
    res.writeHead(400);
    res.end("Invalid session");
    return true;
  }

  res.writeHead(405);
  res.end("Method not allowed");
  return true;
}
