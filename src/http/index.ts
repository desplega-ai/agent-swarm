import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { hasCapability } from "@/server";
import { closeDb } from "../be/db";
import { initAgentMail } from "../agentmail";
import { initGitHub } from "../github";
import { startSlackApp, stopSlackApp } from "../slack";

import { getPathSegments, parseQueryParams, setCorsHeaders } from "./utils";
import { handleCore, loadGlobalConfigsIntoEnv } from "./core";
import { handleAgentRegister, handleAgentsRest } from "./agents";
import { handlePoll } from "./poll";
import { handleSessionData } from "./session-data";
import { handleEcosystem } from "./ecosystem";
import { handleWebhooks } from "./webhooks";
import { handleTasks } from "./tasks";
import { handleStats } from "./stats";
import { handleActiveSessions } from "./active-sessions";
import { handleEpics } from "./epics";
import { handleConfig } from "./config";
import { handleRepos } from "./repos";
import { handleMemory } from "./memory";
import { handleMcp } from "./mcp";

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

const transports: Record<string, StreamableHTTPServerTransport> =
  globalState.__transports ?? {};

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
    console.log(
      `[HTTP] ${statusEmoji} ${req.method} ${req.url} → ${statusCode} (${elapsed}ms)`,
    );
  };

  // Ensure we log on response finish
  res.on("finish", logRequest);

  // Log errors
  res.on("error", (err) => {
    console.error(`[HTTP] ❌ ${req.method} ${req.url} → Error: ${err.message}`);
  });

  setCorsHeaders(res);

  // ── Core routes (OPTIONS, health, auth, /me, /cancelled-tasks, /ping, /close) ──
  if (await handleCore(req, res, req.headers["x-agent-id"] as string | undefined, apiKey))
    return;

  const pathSegments = getPathSegments(req.url || "");
  const queryParams = parseQueryParams(req.url || "");
  const myAgentId = req.headers["x-agent-id"] as string | undefined;

  // ── Agent registration ──
  if (await handleAgentRegister(req, res, pathSegments, myAgentId)) return;

  // ── Polling ──
  if (await handlePoll(req, res, pathSegments, myAgentId)) return;

  // ── Session logs & costs ──
  if (await handleSessionData(req, res, pathSegments, queryParams, myAgentId)) return;

  // ── Ecosystem ──
  if (await handleEcosystem(req, res, myAgentId)) return;

  // ── Webhooks (GitHub + AgentMail) ──
  if (await handleWebhooks(req, res, pathSegments)) return;

  // ── Agents REST API ──
  if (await handleAgentsRest(req, res, pathSegments, queryParams, myAgentId)) return;

  // ── Tasks ──
  if (await handleTasks(req, res, pathSegments, queryParams, myAgentId)) return;

  // ── Stats, logs, services ──
  if (await handleStats(req, res, pathSegments, queryParams)) return;

  // ── Active sessions ──
  if (await handleActiveSessions(req, res, pathSegments, queryParams, myAgentId)) return;

  // ── Epics & channels ──
  if (await handleEpics(req, res, pathSegments, queryParams, myAgentId)) return;

  // ── Config ──
  if (await handleConfig(req, res, pathSegments, queryParams)) return;

  // ── Repos ──
  if (await handleRepos(req, res, pathSegments, queryParams)) return;

  // ── Memory ──
  if (await handleMemory(req, res, pathSegments, myAgentId)) return;

  // ── MCP ──
  if (await handleMcp(req, res, transports)) return;

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
        console.log(
          `Injected ${updated.length} swarm_config value(s) into process.env`,
        );
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
      const { startScheduler } = await import("../scheduler");
      const intervalMs = Number(process.env.SCHEDULER_INTERVAL_MS) || 10000;
      startScheduler(intervalMs);
    }
  })
  .on("error", (err) => {
    console.error("HTTP Server Error:", err);
  });
