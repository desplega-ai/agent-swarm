import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { hasCapability } from "@/server";
import { initAgentMail } from "../agentmail";
import { closeDb } from "../be/db";
import { initGitHub } from "../github";
import { initGitLab } from "../gitlab";
import { stopHeartbeat } from "../heartbeat";
import { initLinear } from "../linear";
import { startSlackApp, stopSlackApp } from "../slack";
import { initWorkflows } from "../workflows";
import { handleActiveSessions } from "./active-sessions";
import { handleAgentRegister, handleAgentsRest } from "./agents";
import { handleConfig } from "./config";
import { handleCore, loadGlobalConfigsIntoEnv } from "./core";
import { handleDbQuery } from "./db-query";
import { handleEcosystem } from "./ecosystem";
import { handleEpics } from "./epics";
import { handleMcp } from "./mcp";
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
    () => handleTasks(req, res, pathSegments, queryParams, myAgentId),
    () => handleStats(req, res, pathSegments, queryParams),
    () => handleActiveSessions(req, res, pathSegments, queryParams, myAgentId),
    () => handleEpics(req, res, pathSegments, queryParams, myAgentId),
    () => handleSchedules(req, res, pathSegments, queryParams, myAgentId),
    () => handleWorkflows(req, res, pathSegments, queryParams, myAgentId),
    () => handleConfig(req, res, pathSegments, queryParams),
    () => handlePromptTemplates(req, res, pathSegments, queryParams),
    () => handleDbQuery(req, res, pathSegments, queryParams),
    () => handleRepos(req, res, pathSegments, queryParams),
    () => handleSkills(req, res, pathSegments, queryParams, myAgentId),
    () => handleMemory(req, res, pathSegments, myAgentId),
    () => handleMcp(req, res, transports),
  ];

  for (const handler of handlers) {
    if (await handler()) return;
  }

  // ── 404 ──
  res.writeHead(404);
  res.end("Not Found");
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
      startScheduler(getExecutorRegistry(), intervalMs);
    }

    // Start heartbeat triage (unless disabled)
    if (process.env.HEARTBEAT_DISABLE !== "true") {
      const { startHeartbeat } = await import("../heartbeat");
      const heartbeatMs = Number(process.env.HEARTBEAT_INTERVAL_MS) || 90000;
      startHeartbeat(heartbeatMs);
    }
  })
  .on("error", (err) => {
    console.error("HTTP Server Error:", err);
  });
