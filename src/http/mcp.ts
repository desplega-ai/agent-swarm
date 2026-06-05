import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "@/server";

export type McpTransportActivity = Record<string, number>;

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

export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  transports: Record<string, StreamableHTTPServerTransport>,
  sessionActivity: McpTransportActivity = {},
): Promise<boolean> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (req.url !== "/mcp") {
    return false;
  }

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
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport;
          markMcpTransportActivity(sessionActivity, id);
        },
        onsessionclosed: (id) => {
          delete transports[id];
          delete sessionActivity[id];
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId];
          delete sessionActivity[transport.sessionId];
        }
      };

      const server = createServer();
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
