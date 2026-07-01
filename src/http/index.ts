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
import { initJira } from "../jira";
import { initLinear } from "../linear";
import {
  initOtel,
  isPollTracingEnabled,
  startSpan,
  withRemoteContext,
  withSpanContext,
} from "../otel";
import { startScriptRunSupervisor, stopScriptRunSupervisor } from "../script-workflows/supervisor";
import { getServerSessionsProcessed } from "../server-runtime-counters";
import { startSlackApp, stopSlackApp } from "../slack";
import { initTelemetry, telemetry } from "../telemetry";
import { getApiKey } from "../utils/api-key";
import { getMcpBaseUrl } from "../utils/constants";
import { scrubSecrets } from "../utils/secret-scrubber";
import { initWorkflows } from "../workflows";
import { handleActiveSessions } from "./active-sessions";
import { handleAgentRegister, handleAgentsRest } from "./agents";
import { handleApiKeys } from "./api-keys";
import { handleApprovalRequests } from "./approval-requests";
import { handleBudgets } from "./budgets";
import { handleConfig } from "./config";
import { handleContext } from "./context";
import { handleCore, loadGlobalConfigsIntoEnv } from "./core";
import { handleDbQuery } from "./db-query";
import { handleEcosystem } from "./ecosystem";
import { handleEvents } from "./events";
import { handleHeartbeat } from "./heartbeat";
import { handleInboxState } from "./inbox-state";
import { handleIntegrations } from "./integrations";
import { handleKv } from "./kv";
import {
  closeIdleMcpTransports,
  DEFAULT_MCP_TRANSPORT_IDLE_TIMEOUT_MS,
  handleMcp,
  type McpSessionAgents,
  type McpTransportActivity,
} from "./mcp";
import { handleMcpBridge } from "./mcp-bridge";
import { handleMcpOAuth, startMcpOAuthPendingGc, stopMcpOAuthPendingGc } from "./mcp-oauth";
import { handleMcpServers } from "./mcp-servers";
import { closeIdleMcpUserTransports, handleMcpUser } from "./mcp-user";
import { handleMemory, startMemoryGc, stopMemoryGc } from "./memory";
import { handleMetrics } from "./metrics";
import { handlePageProxy } from "./page-proxy";
import { handlePages } from "./pages";
import { handlePagesPublic } from "./pages-public";
import { handlePoll } from "./poll";
import { handlePricing } from "./pricing";
import { handlePromptTemplates } from "./prompt-templates";
import { handleRepos } from "./repos";
import { describeRequestRoute } from "./route-def";
import { handleSchedules } from "./schedules";
import { handleScriptRuns } from "./script-runs";
import { handleScripts } from "./scripts";
import { handleSessionData } from "./session-data";
import { handleSessions } from "./sessions";
import { handleSkills } from "./skills";
import { handleStats } from "./stats";
import { handleStatus } from "./status";
import { handleTaskTemplates } from "./task-templates";
import { handleTasks } from "./tasks";
import { handleTrackers } from "./trackers";
import { handleUsers } from "./users";
import {
  getPathSegments,
  httpServerSemconvAttributes,
  parseQueryParams,
  safeRequestUrlForLog,
  setCorsHeaders,
} from "./utils";
import { handleWebhooks } from "./webhooks";
import { handleWorkflowEvents } from "./workflow-events";
import { handleWorkflows } from "./workflows";
import { handleX } from "./x";

// Last-line-of-defense: never let a single bad request (e.g. a SQLITE_BUSY
// thrown out of a transaction callback) kill the API process. Log and keep going.
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandledRejection:", reason);
});

const port = parseInt(process.env.PORT || process.argv[2] || "3013", 10);
const apiKey = getApiKey();

// Use globalThis to persist state across hot reloads
const globalState = globalThis as typeof globalThis & {
  __httpServer?: Server<typeof IncomingMessage, typeof ServerResponse>;
  __transports?: Record<string, StreamableHTTPServerTransport>;
  __mcpSessionAgents?: McpSessionAgents;
  __transportsUser?: Record<string, StreamableHTTPServerTransport>;
  __sessionUsers?: Record<string, string>;
  __transportActivity?: McpTransportActivity;
  __transportActivityUser?: McpTransportActivity;
  __sigintRegistered?: boolean;
  __apiGcInterval?: ReturnType<typeof setInterval>;
  __runId?: string;
};

const API_GC_INTERVAL_MS = 5 * 60 * 1000;
const MCP_TRANSPORT_IDLE_TIMEOUT_MS = DEFAULT_MCP_TRANSPORT_IDLE_TIMEOUT_MS;
const serverStartedAt = Date.now();
let shutdownSignal = "unknown";

type GcCapableGlobal = typeof globalThis & { gc?: () => void };

function scheduleApiGc(reason: string): boolean {
  const gc = (globalThis as GcCapableGlobal).gc;
  if (typeof gc !== "function") return false;

  const timer = setTimeout(() => {
    const startedAt = Date.now();
    try {
      gc();
      console.log(`[HTTP] Explicit GC completed after ${reason} in ${Date.now() - startedAt}ms`);
    } catch (err) {
      console.warn(`[HTTP] Explicit GC failed after ${reason}: ${err}`);
    }
  }, 0);
  timer.unref?.();
  return true;
}

function startApiGcInterval() {
  if (globalState.__apiGcInterval) return;

  const gc = (globalThis as GcCapableGlobal).gc;
  if (typeof gc !== "function") {
    console.log("[HTTP] Explicit GC unavailable; idle MCP transport sweeps remain enabled");
  }

  const interval = setInterval(() => {
    const closedOwnerTransports = closeIdleMcpTransports(transports, transportActivity, {
      idleTimeoutMs: MCP_TRANSPORT_IDLE_TIMEOUT_MS,
      label: "MCP",
      onClose: (id) => {
        delete mcpSessionAgents[id];
      },
    });
    const closedUserTransports = closeIdleMcpUserTransports(
      transportsUser,
      sessionUsers,
      transportActivityUser,
      { idleTimeoutMs: MCP_TRANSPORT_IDLE_TIMEOUT_MS },
    );
    if (closedOwnerTransports > 0 || closedUserTransports > 0) {
      console.log(
        `[HTTP] Closed ${closedOwnerTransports} owner MCP and ${closedUserTransports} user MCP idle transport(s)`,
      );
    }
    scheduleApiGc("periodic API sweep");
  }, API_GC_INTERVAL_MS);
  interval.unref?.();
  globalState.__apiGcInterval = interval;
}

// Clean up previous server on hot reload
if (globalState.__httpServer) {
  console.log("[HTTP] Hot reload detected, closing previous server...");
  globalState.__httpServer.close();
}

const transports: Record<string, StreamableHTTPServerTransport> = globalState.__transports ?? {};
const mcpSessionAgents: McpSessionAgents = globalState.__mcpSessionAgents ?? {};
const transportsUser: Record<string, StreamableHTTPServerTransport> =
  globalState.__transportsUser ?? {};
const sessionUsers: Record<string, string> = globalState.__sessionUsers ?? {};
const transportActivity: McpTransportActivity = globalState.__transportActivity ?? {};
const transportActivityUser: McpTransportActivity = globalState.__transportActivityUser ?? {};

const httpServer = createHttpServer(async (req, res) => {
  const startTime = performance.now();
  let statusCode = 200;
  let spanEnded = false;

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
      `[HTTP] ${statusEmoji} ${req.method} ${safeRequestUrlForLog(req.url)} → ${statusCode} (${elapsed}ms)`,
    );
  };

  // Ensure we log on response finish
  res.on("finish", logRequest);

  // Log errors
  res.on("error", (err) => {
    console.error(
      `[HTTP] ❌ ${req.method} ${safeRequestUrlForLog(req.url)} → Error: ${scrubSecrets(err.message)}`,
    );
  });

  await withRemoteContext(req.headers as Record<string, unknown>, async () => {
    const reqPath = req.url?.split("?")[0] ?? "";
    const pathSegments = getPathSegments(req.url || "");
    const skipSpan = reqPath === "/api/poll" && !isPollTracingEnabled();
    // Per OTel HTTP semantic conventions: span name is `{METHOD} {route-template}`
    // and `http.route` carries the bounded-cardinality template so SigNoz can
    // group/filter/aggregate by endpoint as a first-class field. `http.route` is
    // omitted (not fabricated) for unmatched core/MCP/404 paths. Raw path stays
    // on `url.path`.
    const { spanName, httpRoute } = describeRequestRoute(req.method, pathSegments);
    // Standard OTel HTTP server semconv attributes — host, scheme, protocol
    // version, user-agent (the method/path/route/status are set inline below).
    const semconv = httpServerSemconvAttributes(req);
    const span = skipSpan
      ? null
      : startSpan(spanName, {
          "http.request.method": req.method ?? "",
          "url.path": reqPath,
          "url.scheme": semconv["url.scheme"],
          "http.route": httpRoute,
          "server.address": semconv["server.address"],
          "network.protocol.version": semconv["network.protocol.version"],
          "user_agent.original": semconv["user_agent.original"],
          "agent.id": req.headers["x-agent-id"] as string | undefined,
          "agentswarm.component": "api",
        });

    if (span) {
      res.on("finish", () => {
        if (spanEnded) return;
        spanEnded = true;
        span.setAttributes({
          "http.response.status_code": statusCode,
          "agentswarm.http.duration_ms": Math.round((performance.now() - startTime) * 10) / 10,
        });
        if (statusCode >= 500) {
          span.setStatus({ code: 2, message: `HTTP ${statusCode}` });
        }
        span.end();
      });

      res.on("error", (err) => {
        if (spanEnded) return;
        spanEnded = true;
        span.recordException(err);
        span.setStatus({ code: 2, message: err.message });
        span.end();
      });
    }

    // Run request handling inside the HTTP span's active context so any spans
    // created downstream (MCP `mcp.tool` spans, future DB/auto-instrumentation)
    // nest under it instead of attaching to the root with no parent.
    const handleRequest = async () => {
      setCorsHeaders(req, res);

      // ── Core routes (OPTIONS, health, auth, /me, /cancelled-tasks, /ping, /close) ──
      if (await handleCore(req, res, req.headers["x-agent-id"] as string | undefined, apiKey))
        return;

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
        () => handleBudgets(req, res, pathSegments, queryParams, myAgentId),
        () => handleContext(req, res, pathSegments, queryParams, myAgentId),
        () => handleTasks(req, res, pathSegments, queryParams, myAgentId),
        () => handleStats(req, res, pathSegments, queryParams),
        () => handleStatus(req, res, pathSegments, queryParams),
        () => handleActiveSessions(req, res, pathSegments, queryParams, myAgentId),
        () => handlePricing(req, res, pathSegments, queryParams, myAgentId),
        () => handleSchedules(req, res, pathSegments, queryParams, myAgentId),
        () => handleWorkflows(req, res, pathSegments, queryParams, myAgentId),
        () => handleWorkflowEvents(req, res, pathSegments, queryParams),
        () => handleApprovalRequests(req, res, pathSegments, queryParams),
        () => handleConfig(req, res, pathSegments, queryParams),
        () => handleKv(req, res, pathSegments, queryParams),
        () => handleIntegrations(req, res, pathSegments),
        () => handlePromptTemplates(req, res, pathSegments, queryParams),
        () => handleDbQuery(req, res, pathSegments, queryParams),
        () => handleMetrics(req, res, pathSegments, queryParams, myAgentId),
        () => handleRepos(req, res, pathSegments, queryParams),
        () => handleSkills(req, res, pathSegments, queryParams, myAgentId),
        () => handleScriptRuns(req, res, pathSegments, queryParams, myAgentId),
        () => handleScripts(req, res, pathSegments, queryParams, myAgentId),
        () => handleX(req, res, pathSegments),
        () => handleMcpBridge(req, res, pathSegments, queryParams, myAgentId),
        () => handleMcpServers(req, res, pathSegments, queryParams),
        () => handleMcpOAuth(req, res, pathSegments, queryParams),
        () => handleMemory(req, res, pathSegments, myAgentId),
        () => handlePagesPublic(req, res, pathSegments, queryParams),
        () => handlePageProxy(req, res),
        () => handlePages(req, res, pathSegments, queryParams, myAgentId),
        () => handleApiKeys(req, res, pathSegments, queryParams),
        () => handleHeartbeat(req, res, pathSegments),
        () => handleEvents(req, res, pathSegments, queryParams, myAgentId),
        () => handleUsers(req, res, pathSegments, queryParams),
        () => handleSessions(req, res, pathSegments, queryParams),
        () => handleInboxState(req, res, pathSegments, queryParams),
        () => handleTaskTemplates(req, res, pathSegments, queryParams),
        () => handleMcp(req, res, transports, transportActivity, mcpSessionAgents),
        () => handleMcpUser(req, res, transportsUser, sessionUsers, transportActivityUser),
      ];

      try {
        for (const handler of handlers) {
          if (await handler()) return;
        }

        // ── 404 ──
        res.writeHead(404);
        res.end("Not Found");
      } catch (err) {
        if (span) {
          span.recordException(err);
          span.setStatus({ code: 2, message: err instanceof Error ? err.message : String(err) });
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[HTTP] ❌ ${req.method} ${safeRequestUrlForLog(req.url)} → ${scrubSecrets(message)}`,
        );
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: message }));
        } else if (!res.writableEnded) {
          res.end();
        }
      }
    };

    if (span) {
      await withSpanContext(span, handleRequest);
    } else {
      await handleRequest();
    }
  });
});

// Store references in globalThis for hot reload persistence
globalState.__httpServer = httpServer;
globalState.__transports = transports;
globalState.__transportsUser = transportsUser;
globalState.__mcpSessionAgents = mcpSessionAgents;
globalState.__sessionUsers = sessionUsers;
globalState.__transportActivity = transportActivity;
globalState.__transportActivityUser = transportActivityUser;

async function shutdown() {
  console.log("Shutting down HTTP server...");
  telemetry.server("shutdown", {
    signal: shutdownSignal,
    uptimeMs: Date.now() - serverStartedAt,
    sessionsProcessed: getServerSessionsProcessed(),
  });

  // Stop scheduler (if enabled)
  if (hasCapability("scheduling")) {
    const { stopScheduler } = await import("../scheduler");
    stopScheduler();
  }

  // Stop heartbeat triage
  stopHeartbeat();

  // Stop durable script workflow subprocesses
  stopScriptRunSupervisor();

  // Stop Slack bot
  await stopSlackApp();

  // Stop OAuth keepalive
  if (process.env.OAUTH_KEEPALIVE_DISABLE !== "true") {
    const { stopOAuthKeepalive } = await import("../oauth/keepalive");
    await stopOAuthKeepalive();
  }

  // Stop MCP OAuth pending-session garbage collector
  stopMcpOAuthPendingGc();

  // Stop memory expired-row garbage collector
  stopMemoryGc();

  if (globalState.__apiGcInterval) {
    clearInterval(globalState.__apiGcInterval);
    delete globalState.__apiGcInterval;
  }

  // Close all active transports (SSE connections, etc.)
  for (const [id, transport] of Object.entries(transports)) {
    console.log(`[HTTP] Closing transport ${id}`);
    transport.close();
    delete transports[id];
    delete mcpSessionAgents[id];
    delete transportActivity[id];
  }

  for (const [id, transport] of Object.entries(transportsUser)) {
    console.log(`[HTTP] Closing user transport ${id}`);
    transport.close();
    delete transportsUser[id];
    delete sessionUsers[id];
    delete transportActivityUser[id];
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
  process.on("SIGINT", () => {
    shutdownSignal = "SIGINT";
    shutdown();
  });
  process.on("SIGTERM", () => {
    shutdownSignal = "SIGTERM";
    shutdown();
  });
}

if (!globalState.__runId) {
  globalState.__runId = `run_${Date.now()}`;
}

startApiGcInterval();

// Load global swarm configs before the server starts listening so decrypt/key
// failures fail closed instead of leaving the runtime half-initialized.
let startupConfigsInjected: string[] = [];
try {
  startupConfigsInjected = loadGlobalConfigsIntoEnv(false);
} catch (err) {
  console.error("[startup] Failed to load global swarm configs before listen:", err);
  throw err;
}

// Phase 2 of the cost-tracking plan: project the vendored models.dev snapshot
// into pricing rows at boot. Lazy `getDb()` would also work, but doing it
// here surfaces the count in the boot log and makes the API ready to recompute
// USD before the first POST /api/session-costs lands.
try {
  const { seedPricingFromModelsDev } = await import("../be/seed-pricing");
  seedPricingFromModelsDev();
  const { startPricingRefreshLoop } = await import("../be/pricing-refresh");
  startPricingRefreshLoop();
} catch (err) {
  console.error("[startup] Failed to seed pricing rows:", err);
}

// Seed the built-in entity catalog (scripts today; more kinds later) so
// `script-search` & co. return useful hits from a fresh DB. Idempotent and
// version-aware: a pristine entity updates when its source changes, a
// user-modified one is preserved. Script embeddings are deferred to a
// post-listen backfill so boot doesn't block on embedding provider calls.
// See src/be/seed for the framework.
try {
  const { runAllSeeders } = await import("../be/seed");
  await runAllSeeders({ scriptEmbeddingMode: "skip" });
} catch (err) {
  console.error("[startup] Failed to seed built-in entities:", err);
}

// business-use initialization (no-op if envs not set)
initialize();

await initOtel("api");

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

    // Initialize anonymized telemetry (opt-out via ANONYMIZED_TELEMETRY=false).
    // The api-server is the sole authority for the install identity — pass
    // generateIfMissing so it mints a new install ID on first boot. Workers
    // must NOT mint (see src/commands/runner.ts).
    await initTelemetry(
      "api-server",
      (key) => getSwarmConfigs({ scope: "global", key })?.[0]?.value,
      (key, value) => {
        upsertSwarmConfig({ scope: "global", key, value });
      },
      { generateIfMissing: true },
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

    // Initialize Jira tracker integration (if configured)
    initJira();

    // Initialize workflow engine (trigger subscriptions + resume listener)
    initWorkflows();

    // Reconcile durable script workflow subprocesses
    startScriptRunSupervisor(getMcpBaseUrl());

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

    // Start expired-memory garbage collector (1-hour tick, immediate first run)
    startMemoryGc();

    // Background backfill: re-embed any agent_memory rows with wrong-dimension
    // embeddings (e.g. 1536d instead of 512d). Non-blocking, idempotent, no-op
    // when the DB is clean. See src/be/memory/boot-reembed.ts.
    import("../be/memory/boot-reembed")
      .then(({ runBootReembed }) => runBootReembed())
      .catch((err) => {
        console.error("[boot-reembed] startup backfill failed (non-fatal):", err);
      });

    // Background backfill: embed any scripts that were seeded without embeddings
    // (scriptEmbeddingMode: "skip" during boot). Non-blocking, idempotent, no-op
    // when every non-scratch script already has an embedding.
    import("../be/scripts/boot-reembed")
      .then(({ runBootReembedScripts }) => runBootReembedScripts())
      .catch((err) => {
        console.error("[boot-reembed-scripts] startup backfill failed (non-fatal):", err);
      });

    // One-time scrub: retroactively redact any session_logs rows containing
    // sensitive patterns that pre-date the defense-in-depth scrub layer.
    // Idempotent, tracked via seed_state.
    import("../be/boot-scrub-logs")
      .then(({ runBootScrubLogs }) => runBootScrubLogs())
      .catch((err) => {
        console.error("[boot-scrub-logs] startup scrub failed (non-fatal):", err);
      });
  })
  .on("error", (err) => {
    console.error("HTTP Server Error:", err);
  });
