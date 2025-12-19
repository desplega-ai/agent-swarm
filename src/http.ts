import { randomUUID } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "@/server";
import {
  closeDb,
  getAgentById,
  getAgentWithTasks,
  getAllAgents,
  getAllAgentsWithTasks,
  getAllChannels,
  getAllLogs,
  getAllTasks,
  getChannelById,
  getChannelMessages,
  getDb,
  getInboxSummary,
  getLogsByAgentId,
  getLogsByTaskId,
  getTaskById,
  postMessage,
  updateAgentStatus,
} from "./be/db";
import { startSlackApp, stopSlackApp } from "./slack";
import type { AgentLog, AgentStatus } from "./types";

const port = parseInt(process.env.PORT || process.argv[2] || "3013", 10);
const apiKey = process.env.API_KEY || "";

// Use globalThis to persist state across hot reloads
const globalState = globalThis as typeof globalThis & {
  __httpServer?: Server<typeof IncomingMessage, typeof ServerResponse>;
  __transports?: Record<string, StreamableHTTPServerTransport>;
  __sigintRegistered?: boolean;
};

// Clean up previous server on hot reload
if (globalState.__httpServer) {
  console.log("[HTTP] Hot reload detected, closing previous server...");
  globalState.__httpServer.close();
}

const transports: Record<string, StreamableHTTPServerTransport> = globalState.__transports ?? {};

function setCorsHeaders(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "*");
}

function parseQueryParams(url: string): URLSearchParams {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return new URLSearchParams();
  return new URLSearchParams(url.slice(queryIndex + 1));
}

function getPathSegments(url: string): string[] {
  const pathEnd = url.indexOf("?");
  const path = pathEnd === -1 ? url : url.slice(0, pathEnd);
  return path.split("/").filter(Boolean);
}

const httpServer = createHttpServer(async (req, res) => {
  setCorsHeaders(res);

  // Handle preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const myAgentId = req.headers["x-agent-id"] as string | undefined;

  console.log(
    `[HTTP] ${req.method} ${req.url} (sessionId=${sessionId || ""}, agentId=${myAgentId || ""})`,
  );

  if (req.url === "/health") {
    // Read version from package.json
    const version = (await Bun.file("package.json").json()).version;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        version,
      }),
    );

    return;
  }

  // API key authentication (if API_KEY is configured)
  if (apiKey) {
    const authHeader = req.headers.authorization;
    const providedKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (providedKey !== apiKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
  }

  if (req.method === "GET" && (req.url === "/me" || req.url?.startsWith("/me?"))) {
    if (!myAgentId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing X-Agent-ID header" }));
      return;
    }

    const agent = getAgentById(myAgentId);

    if (!agent) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Agent not found" }));
      return;
    }

    // Check for ?include=inbox query param
    const includeInbox = parseQueryParams(req.url || "").get("include") === "inbox";

    if (includeInbox) {
      const inbox = getInboxSummary(myAgentId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...agent, inbox }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(agent));
    return;
  }

  if (req.method === "POST" && req.url === "/ping") {
    if (!myAgentId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing X-Agent-ID header" }));
      return;
    }

    const tx = getDb().transaction(() => {
      const agent = getAgentById(myAgentId);

      if (!agent) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Agent not found" }));
        return false;
      }

      let status: AgentStatus = "idle";

      if (agent.status === "busy") {
        status = "busy";
      }

      updateAgentStatus(agent.id, status);

      return true;
    });

    if (!tx()) {
      return;
    }

    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && req.url === "/close") {
    if (!myAgentId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing X-Agent-ID header" }));
      return;
    }

    const tx = getDb().transaction(() => {
      const agent = getAgentById(myAgentId);

      if (!agent) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Agent not found" }));
        return false;
      }

      updateAgentStatus(agent.id, "offline");

      return true;
    });

    if (!tx()) {
      return;
    }

    res.writeHead(204);
    res.end();
    return;
  }

  // ============================================================================
  // REST API Endpoints (for frontend dashboard)
  // ============================================================================

  const pathSegments = getPathSegments(req.url || "");
  const queryParams = parseQueryParams(req.url || "");

  // GET /api/agents - List all agents (optionally with tasks)
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "agents" &&
    !pathSegments[2]
  ) {
    const includeTasks = queryParams.get("include") === "tasks";
    const agents = includeTasks ? getAllAgentsWithTasks() : getAllAgents();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ agents }));
    return;
  }

  // GET /api/agents/:id - Get single agent (optionally with tasks)
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "agents" &&
    pathSegments[2]
  ) {
    const agentId = pathSegments[2];
    const includeTasks = queryParams.get("include") === "tasks";
    const agent = includeTasks ? getAgentWithTasks(agentId) : getAgentById(agentId);

    if (!agent) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Agent not found" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(agent));
    return;
  }

  // GET /api/tasks - List all tasks (with optional filters: status, agentId, search)
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "tasks" &&
    !pathSegments[2]
  ) {
    const status = queryParams.get("status") as import("./types").AgentTaskStatus | null;
    const agentId = queryParams.get("agentId");
    const search = queryParams.get("search");
    const tasks = getAllTasks({
      status: status || undefined,
      agentId: agentId || undefined,
      search: search || undefined,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tasks }));
    return;
  }

  // GET /api/tasks/:id - Get single task with logs
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "tasks" &&
    pathSegments[2]
  ) {
    const taskId = pathSegments[2];
    const task = getTaskById(taskId);

    if (!task) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Task not found" }));
      return;
    }

    const logs = getLogsByTaskId(taskId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...task, logs }));
    return;
  }

  // GET /api/logs - List recent logs (optionally filtered by agentId)
  if (req.method === "GET" && pathSegments[0] === "api" && pathSegments[1] === "logs") {
    const limitParam = queryParams.get("limit");
    const limit = limitParam ? parseInt(limitParam, 10) : 100;
    const agentId = queryParams.get("agentId");
    let logs: AgentLog[] = [];
    if (agentId) {
      logs = getLogsByAgentId(agentId).slice(0, limit);
    } else {
      logs = getAllLogs(limit);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ logs }));
    return;
  }

  // GET /api/stats - Dashboard summary stats
  if (req.method === "GET" && pathSegments[0] === "api" && pathSegments[1] === "stats") {
    const agents = getAllAgents();
    const tasks = getAllTasks();

    const stats = {
      agents: {
        total: agents.length,
        idle: agents.filter((a) => a.status === "idle").length,
        busy: agents.filter((a) => a.status === "busy").length,
        offline: agents.filter((a) => a.status === "offline").length,
      },
      tasks: {
        total: tasks.length,
        pending: tasks.filter((t) => t.status === "pending").length,
        in_progress: tasks.filter((t) => t.status === "in_progress").length,
        completed: tasks.filter((t) => t.status === "completed").length,
        failed: tasks.filter((t) => t.status === "failed").length,
      },
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(stats));
    return;
  }

  // GET /api/channels - List all channels
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "channels" &&
    !pathSegments[2]
  ) {
    const channels = getAllChannels();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ channels }));
    return;
  }

  // GET /api/channels/:id/messages - Get messages in a channel
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "channels" &&
    pathSegments[2] &&
    pathSegments[3] === "messages" &&
    !pathSegments[4]
  ) {
    const channelId = pathSegments[2];
    const channel = getChannelById(channelId);

    if (!channel) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Channel not found" }));
      return;
    }

    const limit = queryParams.get("limit") ? parseInt(queryParams.get("limit")!, 10) : 50;
    const since = queryParams.get("since") || undefined;
    const before = queryParams.get("before") || undefined;

    const messages = getChannelMessages(channelId, { limit, since, before });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ messages }));
    return;
  }

  // GET /api/channels/:id/messages/:messageId/thread - Get thread messages
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "channels" &&
    pathSegments[2] &&
    pathSegments[3] === "messages" &&
    pathSegments[4] &&
    pathSegments[5] === "thread"
  ) {
    const channelId = pathSegments[2];
    const parentMessageId = pathSegments[4];

    const channel = getChannelById(channelId);
    if (!channel) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Channel not found" }));
      return;
    }

    // Get all messages that reply to this message
    const allMessages = getChannelMessages(channelId, { limit: 1000 });
    const threadMessages = allMessages.filter((m) => m.replyToId === parentMessageId);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ messages: threadMessages }));
    return;
  }

  // POST /api/channels/:id/messages - Post a message
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "channels" &&
    pathSegments[2] &&
    pathSegments[3] === "messages"
  ) {
    const channelId = pathSegments[2];
    const channel = getChannelById(channelId);

    if (!channel) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Channel not found" }));
      return;
    }

    // Parse request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    if (!body.content || typeof body.content !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or invalid content" }));
      return;
    }

    // agentId is optional (null for human users)
    const agentId = body.agentId || null;

    // If agentId provided, verify agent exists
    if (agentId) {
      const agent = getAgentById(agentId);
      if (!agent) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid agentId" }));
        return;
      }
    }

    const message = postMessage(channelId, agentId, body.content, {
      replyToId: body.replyToId,
      mentions: body.mentions,
    });

    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify(message));
    return;
  }

  if (req.url !== "/mcp") {
    res.writeHead(404);
    res.end("Not Found");
    return;
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
        },
        onsessionclosed: (id) => {
          delete transports[id];
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId];
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
      return;
    }

    await transport.handleRequest(req, res, body);
    return;
  }

  if (req.method === "GET" || req.method === "DELETE") {
    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res);
      return;
    }
    res.writeHead(400);
    res.end("Invalid session");
    return;
  }

  res.writeHead(405);
  res.end("Method not allowed");
});

// Store references in globalThis for hot reload persistence
globalState.__httpServer = httpServer;
globalState.__transports = transports;

async function shutdown() {
  console.log("Shutting down HTTP server...");

  // Stop Slack bot
  await stopSlackApp();

  // Close all active transports (SSE connections, etc.)
  for (const [id, transport] of Object.entries(transports)) {
    console.log(`[HTTP] Closing transport ${id}`);
    transport.close();
    delete transports[id];
  }

  // Close all active connections forcefully
  httpServer.closeAllConnections();
  httpServer.close(() => {
    closeDb();
    console.log("MCP HTTP server closed, and database connection closed");
    process.exit(0);
  });
}

// Only register SIGINT handler once (avoid duplicates on hot reload)
if (!globalState.__sigintRegistered) {
  globalState.__sigintRegistered = true;
  process.on("SIGINT", shutdown);
}

httpServer
  .listen(port, async () => {
    console.log(`MCP HTTP server running on http://localhost:${port}/mcp`);

    // Start Slack bot (if configured)
    await startSlackApp();
  })
  .on("error", (err) => {
    console.error("HTTP Server Error:", err);
  });
