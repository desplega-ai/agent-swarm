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
  createAgent,
  createSessionLogs,
  createTaskExtended,
  getActiveTaskCount,
  getAgentById,
  getAgentWithTasks,
  getAllAgents,
  getAllAgentsWithTasks,
  getAllChannels,
  getAllLogs,
  getAllServices,
  getAllTasks,
  getChannelById,
  getChannelMessages,
  getDb,
  getInboxSummary,
  getLogsByAgentId,
  getLogsByTaskId,
  getOfferedTasksForAgent,
  getPendingTaskForAgent,
  getRecentlyFinishedWorkerTasks,
  getServicesByAgentId,
  getSessionLogsByTaskId,
  getTaskById,
  getUnassignedTasksCount,
  getUnreadInboxMessages,
  hasCapacity,
  postMessage,
  startTask,
  updateAgentMaxTasks,
  updateAgentName,
  updateAgentStatus,
} from "./be/db";
import type { CommentEvent, IssueEvent, PullRequestEvent } from "./github";
import {
  handleComment,
  handleIssue,
  handlePullRequest,
  initGitHub,
  isGitHubEnabled,
  verifyWebhookSignature,
} from "./github";
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

/** Add capacity info to agent response */
function agentWithCapacity<T extends { id: string; maxTasks?: number }>(
  agent: T,
): T & { capacity: { current: number; max: number; available: number } } {
  const activeCount = getActiveTaskCount(agent.id);
  const max = agent.maxTasks ?? 1;
  return {
    ...agent,
    capacity: {
      current: activeCount,
      max,
      available: Math.max(0, max - activeCount),
    },
  };
}

const httpServer = createHttpServer(async (req, res) => {
  const startTime = performance.now();
  let statusCode = 200;

  // Wrap writeHead to capture status code
  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = (code: number, ...args: unknown[]) => {
    statusCode = code;
    // @ts-expect-error - writeHead has multiple overloads
    return originalWriteHead(code, ...args);
  };

  // Log request completion
  const logRequest = () => {
    const elapsed = (performance.now() - startTime).toFixed(1);
    const statusEmoji = statusCode >= 400 ? "⚠️" : "✓";
    console.log(`[HTTP] ${statusEmoji} ${req.method} ${req.url} → ${statusCode} (${elapsed}ms)`);
  };

  // Ensure we log on response finish
  res.on("finish", logRequest);

  // Log errors
  res.on("error", (err) => {
    console.error(`[HTTP] ❌ ${req.method} ${req.url} → Error: ${err.message}`);
  });

  setCorsHeaders(res);

  // Handle preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const myAgentId = req.headers["x-agent-id"] as string | undefined;

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
  // Skip auth for GitHub webhook (it has its own signature verification)
  const isGitHubWebhook = req.url?.startsWith("/api/github/webhook");
  if (apiKey && !isGitHubWebhook) {
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

    // Add capacity info to agent response
    const agentResponse = agentWithCapacity(agent);

    if (includeInbox) {
      const inbox = getInboxSummary(myAgentId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...agentResponse, inbox }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(agentResponse));
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
  // Runner-Level Polling Endpoints
  // ============================================================================

  const pathSegments = getPathSegments(req.url || "");

  // POST /api/agents - Register a new agent (or return existing if already registered)
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
      return;
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
    return;
  }

  // GET /api/poll - Poll for triggers (tasks, mentions, etc.)
  if (req.method === "GET" && pathSegments[0] === "api" && pathSegments[1] === "poll") {
    if (!myAgentId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing X-Agent-ID header" }));
      return;
    }

    // Get optional 'since' parameter for finished tasks
    const queryParams = parseQueryParams(req.url || "");
    const since = queryParams.get("since") || undefined;

    // Use transaction for consistent reads across all trigger checks
    const result = getDb().transaction(() => {
      const agent = getAgentById(myAgentId);
      if (!agent) {
        return { error: "Agent not found", status: 404 };
      }

      // Check for offered tasks first (highest priority for both workers and leads)
      const offeredTasks = getOfferedTasksForAgent(myAgentId);
      const firstOfferedTask = offeredTasks[0];
      if (firstOfferedTask) {
        return {
          trigger: {
            type: "task_offered",
            taskId: firstOfferedTask.id,
            task: firstOfferedTask,
          },
        };
      }

      // Check for pending tasks (assigned directly to this agent)
      // Only return a task if agent has capacity (server-side enforcement)
      if (hasCapacity(myAgentId)) {
        const pendingTask = getPendingTaskForAgent(myAgentId);
        if (pendingTask) {
          // Mark task as in_progress immediately to prevent duplicate polling
          startTask(pendingTask.id);
          return {
            trigger: {
              type: "task_assigned",
              taskId: pendingTask.id,
              task: { ...pendingTask, status: "in_progress" },
            },
          };
        }
      }

      if (agent.isLead) {
        // === LEAD-SPECIFIC TRIGGERS ===

        // Check for unread Slack inbox messages (highest priority for lead)
        const unreadInbox = getUnreadInboxMessages(myAgentId);
        if (unreadInbox.length > 0) {
          return {
            trigger: {
              type: "slack_inbox_message",
              count: unreadInbox.length,
              messages: unreadInbox.slice(0, 5), // Return up to 5 most recent
            },
          };
        }

        // Check for unread mentions (internal chat)
        const inbox = getInboxSummary(myAgentId);
        if (inbox.mentionsCount > 0) {
          return {
            trigger: {
              type: "unread_mentions",
              mentionsCount: inbox.mentionsCount,
            },
          };
        }

        // Check for recently finished worker tasks
        const finishedTasks = getRecentlyFinishedWorkerTasks(since);
        if (finishedTasks.length > 0) {
          return {
            trigger: {
              type: "tasks_finished",
              count: finishedTasks.length,
              tasks: finishedTasks,
            },
          };
        }
      } else {
        // === WORKER-SPECIFIC TRIGGERS ===

        // Check for unassigned tasks in pool (workers can claim)
        const unassignedCount = getUnassignedTasksCount();
        if (unassignedCount > 0) {
          return {
            trigger: {
              type: "pool_tasks_available",
              count: unassignedCount,
            },
          };
        }
      }

      // No trigger found
      return { trigger: null };
    })();

    // Handle error case
    if ("error" in result) {
      res.writeHead(result.status ?? 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: result.error }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  // POST /api/session-logs - Store session logs (batch)
  if (req.method === "POST" && pathSegments[0] === "api" && pathSegments[1] === "session-logs") {
    // Parse request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    // Validate required fields
    if (!body.sessionId || typeof body.sessionId !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or invalid 'sessionId' field" }));
      return;
    }

    if (typeof body.iteration !== "number" || body.iteration < 1) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or invalid 'iteration' field" }));
      return;
    }

    if (!Array.isArray(body.lines) || body.lines.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or invalid 'lines' array" }));
      return;
    }

    try {
      createSessionLogs({
        taskId: body.taskId || undefined,
        sessionId: body.sessionId,
        iteration: body.iteration,
        cli: body.cli || "claude",
        lines: body.lines,
      });

      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, count: body.lines.length }));
    } catch (error) {
      console.error("[HTTP] Failed to create session logs:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to store session logs" }));
    }
    return;
  }

  // GET /api/tasks/:id/session-logs - Get session logs for a task
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "tasks" &&
    pathSegments[2] &&
    pathSegments[3] === "session-logs"
  ) {
    const taskId = pathSegments[2];
    const task = getTaskById(taskId);

    if (!task) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Task not found" }));
      return;
    }

    const logs = getSessionLogsByTaskId(taskId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ logs }));
    return;
  }

  // GET /ecosystem - Generate PM2 ecosystem config for agent's services
  if (req.method === "GET" && req.url === "/ecosystem") {
    if (!myAgentId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing X-Agent-ID header" }));
      return;
    }

    const services = getServicesByAgentId(myAgentId);

    // Generate PM2 ecosystem format
    const ecosystem = {
      apps: services
        .filter((s) => s.script) // Only include services with script path
        .map((s) => {
          const app: Record<string, unknown> = {
            name: s.name,
            script: s.script,
          };

          if (s.cwd) app.cwd = s.cwd;
          if (s.interpreter) app.interpreter = s.interpreter;
          if (s.args && s.args.length > 0) app.args = s.args;
          if (s.env && Object.keys(s.env).length > 0) app.env = s.env;
          if (s.port)
            app.env = { ...((app.env as Record<string, string>) || {}), PORT: String(s.port) };

          return app;
        }),
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(ecosystem));
    return;
  }

  // ============================================================================
  // GitHub Webhook Endpoint
  // ============================================================================

  // POST /api/github/webhook - Handle GitHub webhook events
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "github" &&
    pathSegments[2] === "webhook"
  ) {
    // Check if GitHub integration is enabled
    if (!isGitHubEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "GitHub integration not configured" }));
      return;
    }

    // Get event type and signature
    const eventType = req.headers["x-github-event"] as string | undefined;
    const signature = req.headers["x-hub-signature-256"] as string | undefined;

    // Parse request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString();

    // Verify webhook signature
    const isValid = await verifyWebhookSignature(rawBody, signature ?? null);
    if (!isValid) {
      console.log("[GitHub] Invalid webhook signature");
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid signature" }));
      return;
    }

    // Handle ping event (webhook setup verification)
    if (eventType === "ping") {
      console.log("[GitHub] Received ping event - webhook configured successfully");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "pong" }));
      return;
    }

    // Parse JSON body
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }

    console.log(`[GitHub] Received ${eventType} event`);

    // Route to appropriate handler
    let result: { created: boolean; taskId?: string } = { created: false };

    try {
      switch (eventType) {
        case "pull_request":
          result = await handlePullRequest(body as PullRequestEvent);
          break;
        case "issues":
          result = await handleIssue(body as IssueEvent);
          break;
        case "issue_comment":
          result = await handleComment(body as CommentEvent, "issue_comment");
          break;
        case "pull_request_review_comment":
          result = await handleComment(body as CommentEvent, "pull_request_review_comment");
          break;
        default:
          console.log(`[GitHub] Ignoring unsupported event type: ${eventType}`);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[GitHub] ❌ Error handling ${eventType} event: ${errorMessage}`);
      if (err instanceof Error && err.stack) {
        console.error(err.stack);
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error", message: errorMessage }));
    }
    return;
  }

  // ============================================================================
  // REST API Endpoints (for frontend dashboard)
  // ============================================================================

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
    const agentsWithCapacity = agents.map(agentWithCapacity);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ agents: agentsWithCapacity }));
    return;
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
      return;
    }

    if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid name" }));
      return;
    }

    try {
      const agent = updateAgentName(agentId, body.name.trim());
      if (!agent) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Agent not found" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(agentWithCapacity(agent)));
    } catch (error) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
    return;
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
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(agentWithCapacity(agent)));
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

  // POST /api/tasks - Create a new task
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "tasks" &&
    !pathSegments[2]
  ) {
    // Parse request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    // Validate required fields
    if (!body.task || typeof body.task !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or invalid 'task' field" }));
      return;
    }

    try {
      // Create task with provided options
      const task = createTaskExtended(body.task, {
        agentId: body.agentId || undefined,
        creatorAgentId: myAgentId || undefined,
        taskType: body.taskType || undefined,
        tags: body.tags || undefined,
        priority: body.priority || 50,
        dependsOn: body.dependsOn || undefined,
        offeredTo: body.offeredTo || undefined,
        source: body.source || "api",
      });

      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify(task));
    } catch (error) {
      console.error("[HTTP] Failed to create task:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to create task" }));
    }
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

  // GET /api/services - List all services (with optional filters: status, agentId, name)
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "services" &&
    !pathSegments[2]
  ) {
    const status = queryParams.get("status") as import("./types").ServiceStatus | null;
    const agentId = queryParams.get("agentId");
    const name = queryParams.get("name");
    const services = getAllServices({
      status: status || undefined,
      agentId: agentId || undefined,
      name: name || undefined,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ services }));
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

    const limitParam = queryParams.get("limit");
    const limit = limitParam ? parseInt(limitParam, 10) : 50;
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

    // Initialize GitHub webhook handler (if configured)
    initGitHub();
  })
  .on("error", (err) => {
    console.error("HTTP Server Error:", err);
  });
