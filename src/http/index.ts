import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { ensure, initialize } from "@desplega.ai/business-use";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getEnabledCapabilities, hasCapability } from "@/server";
import { initAgentMail } from "../agentmail";
import { closeDb, getSwarmConfigs, upsertSwarmConfig } from "../be/db";
import { initGitHub } from "../github";
import { initGitLab } from "../gitlab";
import { stopHeartbeat } from "../heartbeat";
import { initLinear } from "../linear";
import { startSlackApp, stopSlackApp } from "../slack";
import { initTelemetry, telemetry } from "../telemetry";
import { initWorkflows } from "../workflows";
import { handleActiveSessions } from "./active-sessions";
import { handleAgentRegister, handleAgentsRest } from "./agents";
import { handleApiKeys } from "./api-keys";
import { handleApprovalRequests } from "./approval-requests";
import { handleConfig } from "./config";
import { handleContext } from "./context";
import { handleCore, loadGlobalConfigsIntoEnv } from "./core";
import { handleDbQuery } from "./db-query";
import { handleEcosystem } from "./ecosystem";
import { handleEvents } from "./events";
import { handleHeartbeat } from "./heartbeat";
import { handleMcp } from "./mcp";
import { handleMcpOAuth, startMcpOAuthPendingGc, stopMcpOAuthPendingGc } from "./mcp-oauth";
import { handleMcpServers } from "./mcp-servers";
import { handleMemory } from "./memory";
import { handlePoll } from "./poll";
import { handlePromptTemplates } from "./prompt-templates";
import { handleRepos } from "./repos";
import { handleSchedules } from "./schedules";
import { handleSessionData } from "./session-data";
import { handleSkills } from "./skills";
import { handleStats } from "./stats";
import { handleTasks } from "./tasks";
import { handleTrackers } from "./trackers";
import { getPathSegments, parseQueryParams, setCorsHeaders } from "./utils";
import { handleWebhooks } from "./webhooks";
import { handleWorkflows } from "./workflows";

// Last-line-of-defense: never let a single bad request (e.g. a SQLITE_BUSY
// thrown out of a transaction callback) kill the API process. Log and keep going.
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandledRejection:", reason);
});

const port = parseInt(process.env.PORT || process.argv[2] || "3013", 10);
const apiKey = process.env.API_KEY || "";

// Use globalThis to persist state across hot reloads
const globalState = globalThis as typeof globalThis & {
  __httpServer?: Server<typeof IncomingMessage, typeof ServerResponse>;
  __transports?: Record<string, StreamableHTTPServerTransport>;
  __sigintRegistered?: boolean;
  __runId?: string;
};

// Clean up previous server on hot reload
if (globalState.__httpServer) {
  console.log("[HTTP] Hot reload detected, closing previous server...");
  globalState.__httpServer.close();
}

const transports: Record<string, StreamableHTTPServerTransport> = globalState.__transports ?? {};

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

  // ── Core routes (OPTIONS, health, auth, /me, /cancelled-tasks, /ping, /close) ──
  if (await handleCore(req, res, req.headers["x-agent-id"] as string | undefined, apiKey)) return;

  const pathSegments = getPathSegments(req.url || "");
  const queryParams = parseQueryParams(req.url || "");
  const myAgentId = req.headers["x-agent-id"] as string | undefined;

  // ── Route handlers (order matters — first match wins) ──
  const handlers: (() => Promise<boolean>)[] = [
    () => handleAgentRegister(req, res, pathSegments, myAgentId),
    () => handlePoll(req, res, pathSegments, queryParams, myAgentId),
    () => handleSessionData(req, res, pathSegments, queryParams, myAgentId),
    () => handleEcosystem(req, res, pathSegments, myAgentId),
    () => handleTrackers(req, res, pathSegments),
    () => handleWebhooks(req, res, pathSegments),
    () => handleAgentsRest(req, res, pathSegments, queryParams, myAgentId),
    () => handleContext(req, res, pathSegments, queryParams, myAgentId),
    () => handleTasks(req, res, pathSegments, queryParams, myAgentId),
    () => handleStats(req, res, pathSegments, queryParams),
    () => handleActiveSessions(req, res, pathSegments, queryParams, myAgentId),
    () => handleSchedules(req, res, pathSegments, queryParams, myAgentId),
    () => handleWorkflows(req, res, pathSegments, queryParams, myAgentId),
    () => handleApprovalRequests(req, res, pathSegments, queryParams),
    () => handleConfig(req, res, pathSegments, queryParams),
    () => handlePromptTemplates(req, res, pathSegments, queryParams),
    () => handleDbQuery(req, res, pathSegments, queryParams),
    () => handleRepos(req, res, pathSegments, queryParams),
    () => handleSkills(req, res, pathSegments, queryParams, myAgentId),
    () => handleMcpServers(req, res, pathSegments, queryParams),
    () => handleMcpOAuth(req, res, pathSegments, queryParams),
    () => handleMemory(req, res, pathSegments, myAgentId),
    () => handleApiKeys(req, res, pathSegments, queryParams),
    () => handleHeartbeat(req, res, pathSegments),
    () => handleEvents(req, res, pathSegments, queryParams, myAgentId),
    () => handleMcp(req, res, transports),
  ];

  try {
    for (const handler of handlers) {
      if (await handler()) return;
    }

    // ── 404 ──
    res.writeHead(404);
    res.end("Not Found");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[HTTP] ❌ ${req.method} ${req.url} → ${message}`);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

// Store references in globalThis for hot reload persistence
globalState.__httpServer = httpServer;
globalState.__transports = transports;

async function shutdown() {
  console.log("Shutting down HTTP server...");

  // Stop scheduler (if enabled)
  if (hasCapability("scheduling")) {
    const { stopScheduler } = await import("../scheduler");
    stopScheduler();
  }

  // Stop heartbeat triage
  stopHeartbeat();

  // Stop Slack bot
  await stopSlackApp();

  // Stop OAuth keepalive
  if (process.env.OAUTH_KEEPALIVE_DISABLE !== "true") {
    const { stopOAuthKeepalive } = await import("../oauth/keepalive");
    stopOAuthKeepalive();
  }

  // Stop MCP OAuth pending-session garbage collector
  stopMcpOAuthPendingGc();

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

// Only register signal handlers once (avoid duplicates on hot reload)
if (!globalState.__sigintRegistered) {
  globalState.__sigintRegistered = true;
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (!globalState.__runId) {
  globalState.__runId = `run_${Date.now()}`;
}

// Load global swarm configs before the server starts listening so decrypt/key
// failures fail closed instead of leaving the runtime half-initialized.
let startupConfigsInjected: string[] = [];
try {
  startupConfigsInjected = loadGlobalConfigsIntoEnv(false);
} catch (err) {
  console.error("[startup] Failed to load global swarm configs before listen:", err);
  throw err;
}

// business-use initialization (no-op if envs not set)
initialize();

httpServer
  .listen(port, async () => {
    console.log(`MCP HTTP server running on http://localhost:${port}/mcp`);

    ensure({
      id: "listen",
      flow: "api",
      runId: globalState.__runId!,
      data: {
        capabilities: getEnabledCapabilities(),
      },
    });

    if (startupConfigsInjected.length > 0) {
      console.log(
        `Injected ${startupConfigsInjected.length} swarm_config value(s) into process.env`,
      );
    }

    // Initialize anonymized telemetry (opt-out via ANONYMIZED_TELEMETRY=false)
    await initTelemetry(
      "api-server",
      (key) => getSwarmConfigs({ scope: "global", key })?.[0]?.value,
      (key, value) => {
        upsertSwarmConfig({ scope: "global", key, value });
      },
    );
    telemetry.server("started", { port });

    // Start Slack bot (if configured)
    await startSlackApp();

    // Initialize GitHub webhook handler (if configured)
    initGitHub();

    // Initialize GitLab webhook handler (if configured)
    initGitLab();

    // Initialize AgentMail webhook handler (if configured)
    initAgentMail();

    // Initialize Linear tracker integration (if configured)
    initLinear();

    // Initialize workflow engine (trigger subscriptions + resume listener)
    initWorkflows();

    // Start scheduler (if enabled)
    if (hasCapability("scheduling")) {
      const { startScheduler } = await import("../scheduler");
      const { getExecutorRegistry } = await import("../workflows");
      const intervalMs = Number(process.env.SCHEDULER_INTERVAL_MS) || 10000;
      startScheduler(getExecutorRegistry(), intervalMs, {
        runId: globalState.__runId!,
      });
    }

    // Start heartbeat triage (unless disabled)
    if (process.env.HEARTBEAT_DISABLE !== "true") {
      const { startHeartbeat } = await import("../heartbeat");
      const heartbeatMs = Number(process.env.HEARTBEAT_INTERVAL_MS) || 90000;
      startHeartbeat(heartbeatMs);
    }

    // Start OAuth token keepalive (proactive refresh to prevent expiry)
    if (process.env.OAUTH_KEEPALIVE_DISABLE !== "true") {
      const { startOAuthKeepalive } = await import("../oauth/keepalive");
      startOAuthKeepalive();
    }

    // Start MCP OAuth pending-session garbage collector (5-min tick)
    startMcpOAuthPendingGc();
  })
  .on("error", (err) => {
    console.error("HTTP Server Error:", err);
  });
