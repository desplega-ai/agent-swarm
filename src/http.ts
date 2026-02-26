import { randomUUID } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer, hasCapability } from "@/server";
import type { AgentMailWebhookPayload } from "./agentmail";
import {
  handleMessageReceived,
  initAgentMail,
  isAgentMailEnabled,
  resetAgentMail,
  verifyAgentMailWebhook,
} from "./agentmail";
import { chunkContent } from "./be/chunking";
import {
  assignTaskToEpic,
  claimInboxMessages,
  claimMentions,
  claimOfferedTask,
  cleanupAgentSessions,
  cleanupStaleSessions,
  closeDb,
  completeTask,
  createAgent,
  createEpic,
  createMemory,
  createSessionCost,
  createSessionLogs,
  createSwarmRepo,
  createTaskExtended,
  deleteActiveSession,
  deleteActiveSessionById,
  deleteEpic,
  deleteMemoriesBySourcePath,
  deleteSwarmConfig,
  deleteSwarmRepo,
  failTask,
  getActiveSessions,
  getActiveTaskCount,
  getAgentById,
  getAgentWithTasks,
  getAllAgents,
  getAllAgentsWithTasks,
  getAllChannels,
  getAllLogs,
  getAllServices,
  getAllSessionCosts,
  getAllTasks,
  getChannelById,
  getChannelMessages,
  getConcurrentContext,
  getDb,
  getEpicById,
  getEpics,
  getEpicsWithProgressUpdates,
  getEpicWithProgress,
  getInboxSummary,
  getLogsByAgentId,
  getLogsByTaskId,
  getOfferedTasksForAgent,
  getPausedTasksForAgent,
  getPendingTaskForAgent,
  getRecentlyCancelledTasksForAgent,
  getResolvedConfig,
  getScheduledTasks,
  getServicesByAgentId,
  getSessionCostsByAgentId,
  getSessionCostsByTaskId,
  getSessionLogsByTaskId,
  getSwarmConfigById,
  getSwarmConfigs,
  getSwarmRepoById,
  getSwarmRepos,
  getTaskById,
  getTaskStats,
  getTasksByEpicId,
  getTasksCount,
  getUnassignedTasksCount,
  hasCapacity,
  heartbeatActiveSession,
  insertActiveSession,
  markEpicsProgressNotified,
  maskSecrets,
  pauseTask,
  postMessage,
  resetEmptyPollCount,
  resumeTask,
  searchMemoriesByVector,
  shouldBlockPolling,
  startTask,
  updateAgentMaxTasks,
  updateAgentName,
  updateAgentProfile,
  updateAgentStatus,
  updateAgentStatusFromCapacity,
  updateEpic,
  updateMemoryEmbedding,
  updateSwarmRepo,
  updateTaskClaudeSessionId,
  upsertSwarmConfig,
} from "./be/db";
import { getEmbedding, serializeEmbedding } from "./be/embedding";
import type {
  CheckRunEvent,
  CheckSuiteEvent,
  CommentEvent,
  IssueEvent,
  PullRequestEvent,
  PullRequestReviewEvent,
  WorkflowRunEvent,
} from "./github";
import {
  handleCheckRun,
  handleCheckSuite,
  handleComment,
  handleIssue,
  handlePullRequest,
  handlePullRequestReview,
  handleWorkflowRun,
  initGitHub,
  isGitHubEnabled,
  resetGitHub,
  verifyWebhookSignature,
} from "./github";
import { startSlackApp, stopSlackApp } from "./slack";
import type { AgentLog, AgentStatus, EpicStatus, SessionCost } from "./types";

const port = parseInt(process.env.PORT || process.argv[2] || "3013", 10);
const apiKey = process.env.API_KEY || "";

/**
 * Load global swarm_config entries into process.env.
 * When override=false (default, used at startup), existing env vars take precedence.
 * When override=true (used for reload), DB values overwrite process.env.
 * Returns the list of keys that were set/updated.
 */
function loadGlobalConfigsIntoEnv(override = false): string[] {
  const globalConfigs = getResolvedConfig();
  const updated: string[] = [];
  for (const config of globalConfigs) {
    if (override || !process.env[config.key]) {
      process.env[config.key] = config.value;
      updated.push(config.key);
    }
  }
  return updated;
}

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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
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
  // Skip auth for webhooks (they have their own signature verification)
  const isGitHubWebhook = req.url?.startsWith("/api/github/webhook");
  const isAgentMailWebhook = req.url?.startsWith("/api/agentmail/webhook");
  if (apiKey && !isGitHubWebhook && !isAgentMailWebhook) {
    const authHeader = req.headers.authorization;
    const providedKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (providedKey !== apiKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
  }

  // POST /internal/reload-config — re-read swarm_config into process.env and re-init integrations
  if (req.method === "POST" && req.url === "/internal/reload-config") {
    try {
      const updated = loadGlobalConfigsIntoEnv(true);

      // Re-initialize integrations so they pick up new secrets
      const integrations: string[] = [];

      resetAgentMail();
      if (initAgentMail()) integrations.push("agentmail");

      resetGitHub();
      if (initGitHub()) integrations.push("github");

      // Slack: stop and restart to pick up new token
      await stopSlackApp();
      await startSlackApp();
      integrations.push("slack");

      console.log(
        `[reload-config] Loaded ${updated.length} config(s), re-initialized: ${integrations.join(", ") || "none"}`,
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          configsLoaded: updated.length,
          keysUpdated: updated,
          integrationsReinitialized: integrations,
        }),
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("[reload-config] Failed:", message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to reload config", details: message }));
    }
    return;
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

    // Add capacity info and polling limit check to agent response
    const agentResponse = {
      ...agentWithCapacity(agent),
      shouldBlockPolling: shouldBlockPolling(myAgentId),
    };

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

  // GET /cancelled-tasks - Check for recently cancelled tasks (for hook cancellation detection)
  // Supports optional ?taskId= query param for checking specific task cancellation
  if (
    req.method === "GET" &&
    (req.url === "/cancelled-tasks" || req.url?.startsWith("/cancelled-tasks?"))
  ) {
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

    // Check for specific taskId query param
    const queryParams = parseQueryParams(req.url || "");
    const taskId = queryParams.get("taskId");

    if (taskId) {
      // Check if specific task is cancelled
      const task = getTaskById(taskId);
      if (task && task.status === "cancelled") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            cancelled: [
              {
                id: task.id,
                task: task.task,
                failureReason: task.failureReason,
              },
            ],
          }),
        );
        return;
      }
      // Task not found or not cancelled
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ cancelled: [] }));
      return;
    }

    // No taskId - return all recently cancelled tasks for this agent
    const cancelledTasks = getRecentlyCancelledTasksForAgent(myAgentId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ cancelled: cancelledTasks }));
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
    return;
  }

  // GET /api/poll - Poll for triggers (tasks, mentions, etc.)
  if (req.method === "GET" && pathSegments[0] === "api" && pathSegments[1] === "poll") {
    if (!myAgentId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing X-Agent-ID header" }));
      return;
    }

    // Use transaction for consistent reads across all trigger checks
    let result:
      | { error: string; status: number }
      | { trigger: { type: string; [key: string]: unknown } | null };
    try {
      result = getDb().transaction(() => {
        const agent = getAgentById(myAgentId);
        if (!agent) {
          return { error: "Agent not found", status: 404 };
        }

        // Check for offered tasks first (highest priority for both workers and leads)
        // Atomically claim the task for review to prevent duplicate processing
        const offeredTasks = getOfferedTasksForAgent(myAgentId);
        const firstOfferedTask = offeredTasks[0];
        if (firstOfferedTask) {
          const claimedTask = claimOfferedTask(firstOfferedTask.id, myAgentId);
          if (claimedTask) {
            return {
              trigger: {
                type: "task_offered",
                taskId: claimedTask.id,
                task: claimedTask,
              },
            };
          }
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

        // Check for unread mentions (internal chat) - all agents can be woken by @mentions
        // Uses atomic claiming via processing_since to prevent duplicate processing.
        // Only idle agents poll, so busy workers won't be interrupted.
        const claimedChannels = claimMentions(myAgentId);
        if (claimedChannels.length > 0) {
          // Recalculate inbox summary now that we've claimed
          const inbox = getInboxSummary(myAgentId);
          return {
            trigger: {
              type: "unread_mentions",
              mentionsCount: inbox.mentionsCount,
              claimedChannels: claimedChannels.map((c) => c.channelId), // Include for tracking
            },
          };
        }

        if (agent.isLead) {
          // === LEAD-SPECIFIC TRIGGERS ===

          // NOTE: tasks_finished trigger has been replaced by follow-up task creation
          // in store-progress. When a worker completes/fails a task, a follow-up task
          // is created and assigned to the lead, which is picked up via the normal
          // task_assigned trigger above. This is more reliable and visible than the
          // old poll-based notification approach.

          // Check for unread Slack inbox messages
          // Atomically claim messages to prevent duplicate processing
          const claimedInbox = claimInboxMessages(myAgentId, 5);
          if (claimedInbox.length > 0) {
            return {
              trigger: {
                type: "slack_inbox_message",
                count: claimedInbox.length,
                messages: claimedInbox,
              },
            };
          }

          // Check for epic progress updates (tasks completed/failed for active epics)
          // This trigger helps lead plan next steps for epics - similar to ralph loop
          const epicsWithUpdates = getEpicsWithProgressUpdates();
          if (epicsWithUpdates.length > 0) {
            // Atomically mark as notified within this transaction
            const epicIds = epicsWithUpdates.map((e) => e.epic.id);
            markEpicsProgressNotified(epicIds);

            return {
              trigger: {
                type: "epic_progress_changed",
                count: epicsWithUpdates.length,
                epics: epicsWithUpdates,
              },
            };
          }
        } else {
          // === WORKER-SPECIFIC TRIGGERS ===

          // Check for unassigned tasks in pool (workers can claim)
          // NOTE: This trigger is intentionally unprotected from duplicate processing.
          // Multiple workers should all receive this notification so they can compete
          // to claim tasks. The actual claiming happens via task-action tool with
          // atomic SQL guards in claimTask().
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
    } catch (error) {
      console.error("[/api/poll] Database error:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Database error occurred while polling for triggers",
          details: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }

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

  // POST /api/session-costs - Store session cost record
  if (req.method === "POST" && pathSegments[0] === "api" && pathSegments[1] === "session-costs") {
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

    if (!body.agentId || typeof body.agentId !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or invalid 'agentId' field" }));
      return;
    }

    if (typeof body.totalCostUsd !== "number") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or invalid 'totalCostUsd' field" }));
      return;
    }

    try {
      const cost = createSessionCost({
        sessionId: body.sessionId,
        taskId: body.taskId || undefined,
        agentId: body.agentId,
        totalCostUsd: body.totalCostUsd,
        inputTokens: body.inputTokens ?? 0,
        outputTokens: body.outputTokens ?? 0,
        cacheReadTokens: body.cacheReadTokens ?? 0,
        cacheWriteTokens: body.cacheWriteTokens ?? 0,
        durationMs: body.durationMs ?? 0,
        numTurns: body.numTurns ?? 1,
        model: body.model || "opus",
        isError: body.isError ?? false,
      });

      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, cost }));
    } catch (error) {
      console.error("[HTTP] Failed to create session cost:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to store session cost" }));
    }
    return;
  }

  // GET /api/session-costs - Query session costs with filters
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "session-costs" &&
    !pathSegments[2]
  ) {
    const costsQueryParams = parseQueryParams(req.url || "");
    const agentId = costsQueryParams.get("agentId");
    const taskId = costsQueryParams.get("taskId");
    const limitParam = costsQueryParams.get("limit");
    const limit = limitParam ? parseInt(limitParam, 10) : 100;

    let costs: SessionCost[];
    if (taskId) {
      costs = getSessionCostsByTaskId(taskId);
    } else if (agentId) {
      costs = getSessionCostsByAgentId(agentId, limit);
    } else {
      costs = getAllSessionCosts(limit);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ costs }));
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
        case "pull_request_review":
          result = await handlePullRequestReview(body as PullRequestReviewEvent);
          break;
        case "check_run":
          result = await handleCheckRun(body as CheckRunEvent);
          break;
        case "check_suite":
          result = await handleCheckSuite(body as CheckSuiteEvent);
          break;
        case "workflow_run":
          result = await handleWorkflowRun(body as WorkflowRunEvent);
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
  // AgentMail Webhook Endpoint
  // ============================================================================

  // POST /api/agentmail/webhook - Handle AgentMail webhook events
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "agentmail" &&
    pathSegments[2] === "webhook"
  ) {
    // Check if AgentMail integration is enabled
    if (!isAgentMailEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "AgentMail integration not configured" }));
      return;
    }

    // Read raw body (required for Svix signature verification)
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString();

    // Extract Svix headers for verification
    const svixHeaders: Record<string, string> = {};
    for (const key of ["svix-id", "svix-timestamp", "svix-signature"]) {
      const value = req.headers[key];
      if (typeof value === "string") {
        svixHeaders[key] = value;
      }
    }

    // Verify webhook signature
    const verified = verifyAgentMailWebhook(rawBody, svixHeaders);
    if (!verified) {
      console.log("[AgentMail] Invalid webhook signature");
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid signature" }));
      return;
    }

    // Return 200 immediately — Svix best practice to avoid retries.
    // Processing happens asynchronously below; dedup is handled in handlers.ts.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ received: true }));

    // Process webhook asynchronously
    const payload = verified as AgentMailWebhookPayload;
    console.log(`[AgentMail] Received ${payload.event_type} event (${payload.event_id})`);

    try {
      switch (payload.event_type) {
        case "message.received":
          await handleMessageReceived(payload);
          break;
        default:
          console.log(`[AgentMail] Ignoring event type: ${payload.event_type}`);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[AgentMail] Error handling ${payload.event_type} event: ${errorMessage}`);
      if (err instanceof Error && err.stack) {
        console.error(err.stack);
      }
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
      return;
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
    return;
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
      return;
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
      return;
    }

    // Validate role length if provided
    if (body.role !== undefined && body.role.length > 100) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Role must be 100 characters or less" }));
      return;
    }

    // Validate capabilities if provided
    if (body.capabilities !== undefined && !Array.isArray(body.capabilities)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Capabilities must be an array of strings" }));
      return;
    }

    // Validate text field sizes (max 64KB each)
    for (const field of ["claudeMd", "soulMd", "identityMd", "setupScript", "toolsMd"] as const) {
      const value = body[field];
      if (value !== undefined && value.length > 65536) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `${field} must be 64KB or less` }));
        return;
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
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(agentWithCapacity(agent)));
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
    const filters = {
      status: status || undefined,
      agentId: agentId || undefined,
      search: search || undefined,
    };
    const tasks = getAllTasks(filters);
    const total = getTasksCount(filters);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tasks, total }));
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
        parentTaskId: body.parentTaskId || undefined,
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

  // PUT /api/tasks/:id/claude-session - Update Claude session ID (called by runner)
  if (
    req.method === "PUT" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "tasks" &&
    pathSegments[2] &&
    pathSegments[3] === "claude-session"
  ) {
    const taskId = pathSegments[2];
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    if (!body.claudeSessionId || typeof body.claudeSessionId !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or invalid 'claudeSessionId' field" }));
      return;
    }

    const task = updateTaskClaudeSessionId(taskId, body.claudeSessionId);
    if (!task) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Task not found" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(task));
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

  // POST /api/tasks/:id/finish - Mark task as completed or failed (runner wrapper endpoint)
  // This endpoint is called by the runner when a Claude process exits to ensure task status is updated
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "tasks" &&
    pathSegments[2] &&
    pathSegments[3] === "finish"
  ) {
    if (!myAgentId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing X-Agent-ID header" }));
      return;
    }

    const taskId = pathSegments[2];

    // Parse request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    // Validate status field
    if (!body.status || !["completed", "failed"].includes(body.status)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Missing or invalid 'status' field (must be 'completed' or 'failed')",
        }),
      );
      return;
    }

    const result = getDb().transaction(() => {
      const task = getTaskById(taskId);

      if (!task) {
        return { error: "Task not found", status: 404 };
      }

      // Only allow the assigned agent (or task creator if unassigned) to finish the task
      if (task.agentId && task.agentId !== myAgentId) {
        return { error: "Task is assigned to another agent", status: 403 };
      }

      // Only finish tasks that are in_progress (prevent double-finishing)
      if (task.status !== "in_progress") {
        // Task already finished or not started - return success with current state
        return { task, alreadyFinished: true };
      }

      let updatedTask: typeof task;
      if (body.status === "completed") {
        const result = completeTask(
          taskId,
          body.output || "Completed by runner wrapper (no explicit output)",
        );
        if (!result) {
          return { error: "Failed to complete task", status: 500 };
        }
        updatedTask = result;
      } else {
        const result = failTask(
          taskId,
          body.failureReason || "Process exited without explicit completion",
        );
        if (!result) {
          return { error: "Failed to mark task as failed", status: 500 };
        }
        updatedTask = result;
      }

      // Update agent status based on remaining capacity
      if (task.agentId) {
        updateAgentStatusFromCapacity(task.agentId);
      }

      return { task: updatedTask };
    })();

    if ("error" in result) {
      res.writeHead(result.status ?? 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: result.error }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        success: true,
        alreadyFinished: result.alreadyFinished ?? false,
        task: result.task,
      }),
    );
    return;
  }

  // GET /api/paused-tasks - Get paused tasks for this agent
  if (req.method === "GET" && pathSegments[0] === "api" && pathSegments[1] === "paused-tasks") {
    if (!myAgentId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing X-Agent-ID header" }));
      return;
    }

    const pausedTasks = getPausedTasksForAgent(myAgentId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tasks: pausedTasks }));
    return;
  }

  // POST /api/tasks/:id/pause - Pause an in-progress task (for graceful shutdown)
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "tasks" &&
    pathSegments[2] &&
    pathSegments[3] === "pause"
  ) {
    if (!myAgentId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing X-Agent-ID header" }));
      return;
    }

    const taskId = pathSegments[2];
    const task = getTaskById(taskId);

    if (!task) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Task not found" }));
      return;
    }

    // Only allow the assigned agent to pause their own task
    if (task.agentId !== myAgentId) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Task belongs to another agent" }));
      return;
    }

    if (task.status !== "in_progress") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Task status is '${task.status}', not 'in_progress'` }));
      return;
    }

    const pausedTask = pauseTask(taskId);
    if (!pausedTask) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to pause task" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, task: pausedTask }));
    return;
  }

  // POST /api/tasks/:id/resume - Resume a paused task
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "tasks" &&
    pathSegments[2] &&
    pathSegments[3] === "resume"
  ) {
    if (!myAgentId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing X-Agent-ID header" }));
      return;
    }

    const taskId = pathSegments[2];
    const task = getTaskById(taskId);

    if (!task) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Task not found" }));
      return;
    }

    // Only allow the assigned agent to resume their own task
    if (task.agentId !== myAgentId) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Task belongs to another agent" }));
      return;
    }

    if (task.status !== "paused") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Task status is '${task.status}', not 'paused'` }));
      return;
    }

    const resumedTask = resumeTask(taskId);
    if (!resumedTask) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to resume task" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, task: resumedTask }));
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
    const taskStats = getTaskStats();

    const stats = {
      agents: {
        total: agents.length,
        idle: agents.filter((a) => a.status === "idle").length,
        busy: agents.filter((a) => a.status === "busy").length,
        offline: agents.filter((a) => a.status === "offline").length,
      },
      tasks: {
        total: taskStats.total,
        unassigned: taskStats.unassigned,
        offered: taskStats.offered,
        reviewing: taskStats.reviewing,
        pending: taskStats.pending,
        in_progress: taskStats.in_progress,
        paused: taskStats.paused,
        completed: taskStats.completed,
        failed: taskStats.failed,
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

  // GET /api/scheduled-tasks - List all scheduled tasks (with optional filters: enabled, name)
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "scheduled-tasks" &&
    !pathSegments[2]
  ) {
    const enabledParam = queryParams.get("enabled");
    const name = queryParams.get("name");
    const scheduledTasks = getScheduledTasks({
      enabled: enabledParam !== null ? enabledParam === "true" : undefined,
      name: name || undefined,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ scheduledTasks }));
    return;
  }

  // GET /api/concurrent-context - Get concurrent session context for lead awareness
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "concurrent-context" &&
    !pathSegments[2]
  ) {
    const context = getConcurrentContext();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(context));
    return;
  }

  // ============================================================================
  // Active Session Endpoints (runner session tracking)
  // ============================================================================

  // GET /api/active-sessions - List active sessions (with optional agentId filter)
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "active-sessions" &&
    !pathSegments[2]
  ) {
    const agentId = queryParams.get("agentId");
    const sessions = getActiveSessions(agentId || undefined);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions }));
    return;
  }

  // POST /api/active-sessions - Create a new active session
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "active-sessions" &&
    !pathSegments[2]
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    let body: {
      agentId?: string;
      taskId?: string;
      triggerType?: string;
      inboxMessageId?: string;
      taskDescription?: string;
    };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }
    if (!body.agentId || !body.triggerType) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "agentId and triggerType are required" }));
      return;
    }
    const session = insertActiveSession({
      agentId: body.agentId,
      taskId: body.taskId,
      triggerType: body.triggerType,
      inboxMessageId: body.inboxMessageId,
      taskDescription: body.taskDescription,
    });
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ session }));
    return;
  }

  // DELETE /api/active-sessions/by-task/:taskId - Delete by taskId
  if (
    req.method === "DELETE" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "active-sessions" &&
    pathSegments[2] === "by-task" &&
    pathSegments[3]
  ) {
    const deleted = deleteActiveSession(pathSegments[3]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ deleted }));
    return;
  }

  // DELETE /api/active-sessions/:id - Delete by session id
  if (
    req.method === "DELETE" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "active-sessions" &&
    pathSegments[2]
  ) {
    const deleted = deleteActiveSessionById(pathSegments[2]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ deleted }));
    return;
  }

  // PUT /api/active-sessions/heartbeat/:taskId - Update heartbeat for a session
  if (
    req.method === "PUT" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "active-sessions" &&
    pathSegments[2] === "heartbeat" &&
    pathSegments[3]
  ) {
    const updated = heartbeatActiveSession(pathSegments[3]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ updated }));
    return;
  }

  // POST /api/active-sessions/cleanup - Clean up stale sessions
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "active-sessions" &&
    pathSegments[2] === "cleanup" &&
    !pathSegments[3]
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    let body: { agentId?: string; maxAgeMinutes?: number } = {};
    try {
      const text = Buffer.concat(chunks).toString();
      if (text) body = JSON.parse(text);
    } catch {
      // Empty body is fine — defaults apply
    }
    let cleaned = 0;
    if (body.agentId) {
      cleaned = cleanupAgentSessions(body.agentId);
    } else {
      cleaned = cleanupStaleSessions(body.maxAgeMinutes ?? 30);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ cleaned }));
    return;
  }

  // ============================================================================
  // Epic Endpoints
  // ============================================================================

  // GET /api/epics - List all epics
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "epics" &&
    !pathSegments[2]
  ) {
    const status = queryParams.get("status") as EpicStatus | null;
    const search = queryParams.get("search");
    const leadAgentId = queryParams.get("leadAgentId");
    const rawEpics = getEpics({
      status: status || undefined,
      search: search || undefined,
      leadAgentId: leadAgentId || undefined,
    });
    // Enrich each epic with progress data for the UI
    const epics = rawEpics.map((e) => getEpicWithProgress(e.id) ?? e);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ epics, total: epics.length }));
    return;
  }

  // POST /api/epics - Create a new epic
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "epics" &&
    !pathSegments[2]
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    if (!body.name || !body.goal) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required fields: name, goal" }));
      return;
    }

    try {
      const epic = createEpic({
        ...body,
        createdByAgentId: myAgentId || undefined,
      });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify(epic));
    } catch (_error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to create epic" }));
    }
    return;
  }

  // GET /api/epics/:id - Get single epic with progress and tasks
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "epics" &&
    pathSegments[2] &&
    !pathSegments[3]
  ) {
    const epicId = pathSegments[2];
    const epic = getEpicWithProgress(epicId);

    if (!epic) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Epic not found" }));
      return;
    }

    const tasks = getTasksByEpicId(epicId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...epic, tasks }));
    return;
  }

  // PUT /api/epics/:id - Update an epic
  if (
    req.method === "PUT" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "epics" &&
    pathSegments[2] &&
    !pathSegments[3]
  ) {
    const epicId = pathSegments[2];
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    const epic = updateEpic(epicId, body);
    if (!epic) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Epic not found" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(epic));
    return;
  }

  // DELETE /api/epics/:id - Delete an epic
  if (
    req.method === "DELETE" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "epics" &&
    pathSegments[2] &&
    !pathSegments[3]
  ) {
    const epicId = pathSegments[2];
    const deleted = deleteEpic(epicId);

    if (!deleted) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Epic not found" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // POST /api/epics/:id/tasks - Add task to epic (create new or assign existing)
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "epics" &&
    pathSegments[2] &&
    pathSegments[3] === "tasks"
  ) {
    const epicId = pathSegments[2];
    const epic = getEpicById(epicId);

    if (!epic) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Epic not found" }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    // If taskId provided, assign existing task
    if (body.taskId) {
      const task = assignTaskToEpic(body.taskId, epicId);
      if (!task) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Task not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(task));
      return;
    }

    // Otherwise create new task in this epic
    if (!body.task) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing task description or taskId" }));
      return;
    }

    try {
      const task = createTaskExtended(body.task, {
        ...body,
        epicId,
        creatorAgentId: myAgentId || undefined,
        tags: [...(body.tags || []), `epic:${epic.name}`],
        source: "api",
      });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify(task));
    } catch (_error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to create task" }));
    }
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

  // ============================================================================
  // Config Endpoints (Centralized Environment/Config Management)
  // ============================================================================

  // GET /api/config/resolved - Get merged config with scope resolution
  // MUST come before GET /api/config/:id to avoid "resolved" matching as an ID
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "config" &&
    pathSegments[2] === "resolved" &&
    !pathSegments[3]
  ) {
    const agentId = queryParams.get("agentId") || undefined;
    const repoId = queryParams.get("repoId") || undefined;
    const includeSecrets = queryParams.get("includeSecrets") === "true";
    const configs = getResolvedConfig(agentId, repoId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ configs: includeSecrets ? configs : maskSecrets(configs) }));
    return;
  }

  // GET /api/config/:id - Get single config entry
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "config" &&
    pathSegments[2] &&
    !pathSegments[3]
  ) {
    const configId = pathSegments[2];
    const includeSecrets = queryParams.get("includeSecrets") === "true";
    const config = getSwarmConfigById(configId);

    if (!config) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Config not found" }));
      return;
    }

    const result = includeSecrets ? config : maskSecrets([config])[0];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  // GET /api/config - List config entries with optional filters
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "config" &&
    !pathSegments[2]
  ) {
    const scope = queryParams.get("scope") || undefined;
    const scopeId = queryParams.get("scopeId") || undefined;
    const includeSecrets = queryParams.get("includeSecrets") === "true";
    const configs = getSwarmConfigs({ scope, scopeId });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ configs: includeSecrets ? configs : maskSecrets(configs) }));
    return;
  }

  // PUT /api/config - Upsert a config entry
  if (
    req.method === "PUT" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "config" &&
    !pathSegments[2]
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    if (!body.scope || !body.key || body.value === undefined) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required fields: scope, key, value" }));
      return;
    }

    const validScopes = ["global", "agent", "repo"];
    if (!validScopes.includes(body.scope)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid scope. Must be: global, agent, repo" }));
      return;
    }

    if (body.scope === "global" && body.scopeId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Global scope must not have scopeId" }));
      return;
    }

    if ((body.scope === "agent" || body.scope === "repo") && !body.scopeId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Agent/repo scope requires scopeId" }));
      return;
    }

    try {
      const includeSecrets = queryParams.get("includeSecrets") === "true";
      const config = upsertSwarmConfig({
        scope: body.scope,
        scopeId: body.scopeId || null,
        key: body.key,
        value: String(body.value),
        isSecret: body.isSecret || false,
        envPath: body.envPath || null,
        description: body.description || null,
      });
      const result = includeSecrets || !config.isSecret ? config : maskSecrets([config])[0];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (_error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to upsert config" }));
    }
    return;
  }

  // DELETE /api/config/:id - Delete a config entry
  if (
    req.method === "DELETE" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "config" &&
    pathSegments[2] &&
    !pathSegments[3]
  ) {
    const configId = pathSegments[2];
    const deleted = deleteSwarmConfig(configId);

    if (!deleted) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Config not found" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // ============================================================================
  // Repos endpoints
  // ============================================================================

  // GET /api/repos/:id - Get single repo
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "repos" &&
    pathSegments[2] &&
    !pathSegments[3]
  ) {
    const repo = getSwarmRepoById(pathSegments[2]);
    if (!repo) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Repo not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(repo));
    return;
  }

  // GET /api/repos - List repos with optional filters
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "repos" &&
    !pathSegments[2]
  ) {
    const autoCloneParam = queryParams.get("autoClone");
    const nameParam = queryParams.get("name") || undefined;
    const filters: { autoClone?: boolean; name?: string } = {};
    if (autoCloneParam !== null) {
      filters.autoClone = autoCloneParam === "true";
    }
    if (nameParam) {
      filters.name = nameParam;
    }
    const repos = getSwarmRepos(Object.keys(filters).length > 0 ? filters : undefined);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ repos }));
    return;
  }

  // POST /api/repos - Create a new repo
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "repos" &&
    !pathSegments[2]
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    if (!body.url || !body.name) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required fields: url, name" }));
      return;
    }

    try {
      const repo = createSwarmRepo({
        url: body.url,
        name: body.name,
        clonePath: body.clonePath,
        defaultBranch: body.defaultBranch,
        autoClone: body.autoClone,
      });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify(repo));
    } catch (error) {
      const msg = (error as Error).message;
      if (msg.includes("UNIQUE constraint")) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Repo with that url, name, or clonePath already exists" }));
      } else {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to create repo" }));
      }
    }
    return;
  }

  // PUT /api/repos/:id - Update a repo
  if (
    req.method === "PUT" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "repos" &&
    pathSegments[2] &&
    !pathSegments[3]
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    try {
      const updated = updateSwarmRepo(pathSegments[2], {
        url: body.url,
        name: body.name,
        clonePath: body.clonePath,
        defaultBranch: body.defaultBranch,
        autoClone: body.autoClone,
      });

      if (!updated) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Repo not found" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(updated));
    } catch (error) {
      const msg = (error as Error).message;
      if (msg.includes("UNIQUE constraint")) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Repo with that url, name, or clonePath already exists" }));
      } else {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to update repo" }));
      }
    }
    return;
  }

  // DELETE /api/repos/:id - Delete a repo
  if (
    req.method === "DELETE" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "repos" &&
    pathSegments[2] &&
    !pathSegments[3]
  ) {
    const deleted = deleteSwarmRepo(pathSegments[2]);
    if (!deleted) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Repo not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // POST /api/memory/index - Ingest content into memory system (async embedding)
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "memory" &&
    pathSegments[2] === "index" &&
    !pathSegments[3]
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    const { agentId, content, name, scope, source, sourceTaskId, sourcePath, tags } = body;

    if (!content || !name || !scope || !source) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required fields: content, name, scope, source" }));
      return;
    }

    if (!["agent", "swarm"].includes(scope)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "scope must be 'agent' or 'swarm'" }));
      return;
    }

    if (!["manual", "file_index", "session_summary", "task_completion"].includes(source)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid source type" }));
      return;
    }

    // Chunk content and create memories in a transaction (with dedup)
    const contentChunks = chunkContent(content);
    if (contentChunks.length === 0) {
      // Content too small to chunk — create a single memory
      contentChunks.push({
        content: content.trim(),
        chunkIndex: 0,
        totalChunks: 1,
        headings: [],
      });
    }

    const memoryIds = getDb().transaction(() => {
      // Delete old chunks if re-indexing same file
      if (sourcePath && agentId) {
        deleteMemoriesBySourcePath(sourcePath, agentId);
      }

      const ids: string[] = [];
      for (const chunk of contentChunks) {
        const memory = createMemory({
          agentId: agentId || null,
          content: chunk.content,
          name,
          scope,
          source,
          sourcePath: sourcePath || null,
          sourceTaskId: sourceTaskId || null,
          chunkIndex: chunk.chunkIndex,
          totalChunks: chunk.totalChunks,
          tags: tags || [],
        });
        ids.push(memory.id);
      }
      return ids;
    })();

    // Async embedding — fire and forget
    (async () => {
      for (let i = 0; i < contentChunks.length; i++) {
        try {
          const embedding = await getEmbedding(contentChunks[i]!.content);
          if (embedding) {
            updateMemoryEmbedding(memoryIds[i]!, serializeEmbedding(embedding));
          }
        } catch (err) {
          console.error(`[memory] Failed to embed chunk ${memoryIds[i]}:`, (err as Error).message);
        }
      }
    })();

    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ queued: true, memoryIds }));
    return;
  }

  // POST /api/memory/search - Search memories by natural language query
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "memory" &&
    pathSegments[2] === "search" &&
    !pathSegments[3]
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const { query, limit = 5 } = body;
    const searchAgentId = myAgentId;

    if (!query || !searchAgentId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required fields: query, X-Agent-ID header" }));
      return;
    }

    try {
      const queryEmbedding = await getEmbedding(query);
      if (!queryEmbedding) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
        return;
      }

      const results = searchMemoriesByVector(queryEmbedding, searchAgentId, {
        scope: "all",
        limit: Math.min(limit, 20),
        isLead: false,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          results: results.map((r) => ({
            id: r.id,
            name: r.name,
            content: r.content,
            similarity: r.similarity,
            source: r.source,
            scope: r.scope,
          })),
        }),
      );
    } catch (err) {
      console.error("[memory-search] Error:", (err as Error).message);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
    }
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

  // Stop scheduler (if enabled)
  if (hasCapability("scheduling")) {
    const { stopScheduler } = await import("./scheduler");
    stopScheduler();
  }

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

    // Load global swarm configs into process.env (so integrations can read them)
    // Infrastructure-level env vars take precedence — only missing keys are filled.
    try {
      const updated = loadGlobalConfigsIntoEnv(false);
      if (updated.length > 0) {
        console.log(`Injected ${updated.length} swarm_config value(s) into process.env`);
      }
    } catch (e) {
      console.error("Failed to load global swarm configs:", e);
    }

    // Start Slack bot (if configured)
    await startSlackApp();

    // Initialize GitHub webhook handler (if configured)
    initGitHub();

    // Initialize AgentMail webhook handler (if configured)
    initAgentMail();

    // Start scheduler (if enabled)
    if (hasCapability("scheduling")) {
      const { startScheduler } = await import("./scheduler");
      const intervalMs = Number(process.env.SCHEDULER_INTERVAL_MS) || 10000;
      startScheduler(intervalMs);
    }
  })
  .on("error", (err) => {
    console.error("HTTP Server Error:", err);
  });
