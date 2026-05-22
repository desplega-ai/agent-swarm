import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { resolveUserByToken } from "@/be/users";
import { createUserServer } from "@/server-user";
import type { User } from "@/types";

function unauthorized(res: ServerResponse): true {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unauthorized" }));
  return true;
}

function extractBearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.startsWith("aswt_") ? token : null;
}

function resolveActiveUser(req: IncomingMessage): User | null {
  const token = extractBearer(req);
  if (!token) return null;
  const user = resolveUserByToken(token);
  if (!user || user.status !== "active") return null;
  return user;
}

export async function handleMcpUser(
  req: IncomingMessage,
  res: ServerResponse,
  transports: Record<string, StreamableHTTPServerTransport>,
  sessionUsers: Record<string, string>,
): Promise<boolean> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (req.url !== "/mcp-user") {
    return false;
  }

  const user = resolveActiveUser(req);
  if (!user) return unauthorized(res);

  if (sessionId && transports[sessionId] && sessionUsers[sessionId] !== user.id) {
    return unauthorized(res);
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
    } else if (!sessionId && isInitializeRequest(body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport;
          sessionUsers[id] = user.id;
        },
        onsessionclosed: (id) => {
          delete transports[id];
          delete sessionUsers[id];
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId];
          delete sessionUsers[transport.sessionId];
        }
      };

      const server = createUserServer(user);
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
    return true;
  }

  if (req.method === "GET" || req.method === "DELETE") {
    if (sessionId && transports[sessionId]) {
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
