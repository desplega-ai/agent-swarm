import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getEnabledCapabilities, hasCapability } from "@/server";
import { initAgentMail } from "../agentmail";
import { initAzureDevOps, initAzureDevOpsOutbound } from "../azure-devops";
import { drainApi, isApiDraining } from "../be/api-drain";
import {
  closeDb,
  emitBuiltInIntegrationConnectedOnce,
  getSwarmConfigs,
  upsertSwarmConfig,
} from "../be/db";
import { startDbRetention, stopDbRetention } from "../be/db-retention";
import { startHumanFreeDrain, stopHumanFreeDrain } from "../be/human-free-drain";
import {
  enqueueAuditRow,
  flushAuditBuffer,
  startAuditGc,
  startAuditWriter,
  stopAuditGc,
  stopAuditWriter,
} from "../be/rbac-audit";
import { startPoolRouting, stopPoolRouting } from "../be/runtime-pools/routing";
import { seedRuntimePools } from "../be/runtime-pools/seed";
import { startRuntimeSupervisor, stopRuntimeSupervisor } from "../be/runtime-pools/supervisor";
import { startScratchScriptGc, stopScratchScriptGc } from "../be/scripts/retention";
import { loadSecretRegistry } from "../be/secret-registry";
import { seedLegacyCapabilitiesConfig } from "../be/seed-capabilities";
import { initApiTelemetry } from "../be/telemetry-enable";
import { startWorkerNudgeListener } from "../be/worker-nudge-listener";
import { initBitbucket } from "../bitbucket";
import {
  loadEnabledExtensions,
  setExtensionLoopbackBaseUrl,
  stopExtensionRuntime,
} from "../extensions/lifecycle";
import { initGitHub } from "../github";
import { initGitLab } from "../gitlab";
import { stopHeartbeat } from "../heartbeat";
import { startChatSdk, stopChatSdk } from "../integrations/chat-sdk/runtime";
import { initJira } from "../jira";
import { initLinear } from "../linear";
import {
  initOtel,
  isPollTracingEnabled,
  startSpan,
  withRemoteContext,
  withSpanContext,
} from "../otel";
import { startQueueStallAlarm, stopQueueStallAlarm } from "../queue-stall-alarm";
import { clearAuditSink, isRbacEnabled, setAuditSink } from "../rbac";
import { realtimeBus } from "../realtime/bus";
import { closeRooms, removeNamespaceRooms, sweepRooms } from "../realtime/rooms";
import { attachRealtimeTransport } from "../realtime/transport";
import { startScriptRunSupervisor, stopScriptRunSupervisor } from "../script-workflows/supervisor";
import { getNativeSandboxStatus } from "../scripts-runtime/executors/native";
import { nativeSeccompPolicy } from "../scripts-runtime/sandbox-probe";
import { getServerSessionsProcessed } from "../server-runtime-counters";
import { startSlackApp, stopSlackApp } from "../slack";
import { telemetry } from "../telemetry";
import { startTelemetryTicker } from "../telemetry-snapshot";
import { API_DRAINING_HEADER } from "../utils/api-drain";
import { getApiKey } from "../utils/api-key";
import { ensure, initialize } from "../utils/business-use";
import { getMcpBaseUrl } from "../utils/constants";
import { isEnvFlagEnabled } from "../utils/env-flag";
import { scrubSecrets } from "../utils/secret-scrubber";
import { initWorkflows } from "../workflows";
import { handleActiveSessions } from "./active-sessions";
import { handleAgentRegister, handleAgentsRest } from "./agents";
import { handleApiKeys } from "./api-keys";
import { handleApprovalRequests } from "./approval-requests";
import { handleApps } from "./apps";
import { handleAssets } from "./assets";
import { handleBudgets } from "./budgets";
import { handleCodexOAuthDevice } from "./codex-oauth-device";
import { handleCodexOAuthKeepWarm } from "./codex-oauth-keep-warm";
import { handleComb } from "./comb";
import { handleConfig } from "./config";
import { handleContext } from "./context";
import { handleCore, loadGlobalConfigsIntoEnv } from "./core";
import { handleDbQuery } from "./db-query";
import { handleEvents } from "./events";
import { handleExtensions } from "./extensions";
import { handleFavorites } from "./favorites";
import { handleFleetBenchmark } from "./fleet-benchmark";
import { handleFs } from "./fs";
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
import { handleMcpOAuth } from "./mcp-oauth";
import { handleMcpServers } from "./mcp-servers";
import { closeIdleMcpUserTransports, handleMcpUser } from "./mcp-user";
import { handleMemory, startMemoryGc, stopMemoryGc } from "./memory";
import { handleMetrics } from "./metrics";
import { handleModelProfiles } from "./model-profiles";
import { handleModelsCatalog } from "./models-catalog";
import { handleOAuthCallback, startOAuthPendingGc, stopOAuthPendingGc } from "./oauth-callback";
import { handleGenericOAuth } from "./oauth-generic";
import { handleOAuthLocks } from "./oauth-locks";
import { handleOnboarding } from "./onboarding";
import { handlePageProxy } from "./page-proxy";
import { handlePages } from "./pages";
import { handlePagesPublic } from "./pages-public";
import { handlePoll } from "./poll";
import { handlePricing } from "./pricing";
import { handlePromptTemplates } from "./prompt-templates";
import { handleRanking } from "./ranking";
import { handleRealtimeAsset, handleRealtimeTicket } from "./realtime";
import { handleRepos } from "./repos";
import { handleRooms } from "./rooms";
import { describeRequestRoute } from "./route-def";
import { handleRuntimePools } from "./runtime-pools";
import { handleSchedules } from "./schedules";
import { handleScriptConnectionProxy } from "./script-connection-proxy";
import { handleScriptConnections } from "./script-connections";
import { handleScriptRuns } from "./script-runs";
import { handleScripts } from "./scripts";
import { handleSessionData } from "./session-data";
import { handleSessions } from "./sessions";
import { handleSkills } from "./skills";
import { handleSlackInbound } from "./slack-inbound";
import { handleStats } from "./stats";
import { handleStatus } from "./status";
import { handleTaskTemplates } from "./task-templates";
import { handleTasks } from "./tasks";
import { handleTelemetryUi } from "./telemetry-ui";
import { handleTrackers } from "./trackers";
import { handleUsedBy } from "./used-by";
import { handleUserRoles } from "./user-roles";
import { handleUsers } from "./users";
import {
  getPathSegments,
  httpServerSemconvAttributes,
  parseQueryParams,
  safeRequestUrlForLog,
  setCorsHeaders,
  warnIfCorsAllowsAnyOrigin,
  wireHttpSpanLifecycle,
  writeUnhandledError,
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
  __closeRealtime?: () => void;
  __stopExtensions?: () => Promise<void>;
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
    void sweepRooms().catch((error) =>
      console.error("[rooms] Sweep failed:", scrubSecrets(String(error))),
    );
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
  globalState.__closeRealtime?.();
  await globalState.__stopExtensions?.();
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
    const hasQueryString = (req.url ?? "").includes("?");
    const hasTrailingSlash = reqPath.length > 1 && reqPath.endsWith("/");
    const skipSpan = reqPath === "/api/poll" && !isPollTracingEnabled();
    // Per OTel HTTP semantic conventions: span name is `{METHOD} {route-template}`
    // and `http.route` carries the bounded-cardinality template so SigNoz can
    // group/filter/aggregate by endpoint as a first-class field. `http.route` is
    // omitted (not fabricated) for unmatched core/MCP/404 paths. Raw path stays
    // on `url.path`.
    const { spanName, httpRoute } = describeRequestRoute(
      req.method,
      pathSegments,
      hasQueryString,
      hasTrailingSlash,
    );
    // Standard OTel HTTP server semconv attributes — host, scheme, protocol
    // version, user-agent (the method/path/route/status are set inline below).
    const semconv = httpServerSemconvAttributes(req);
    const span = skipSpan
      ? null
      : startSpan(
          spanName,
          {
            "http.request.method": req.method ?? "",
            "url.path": reqPath,
            "url.scheme": semconv["url.scheme"],
            "http.route": httpRoute,
            "server.address": semconv["server.address"],
            "network.protocol.version": semconv["network.protocol.version"],
            "user_agent.original": semconv["user_agent.original"],
            "agent.id": req.headers["x-agent-id"] as string | undefined,
            "agentswarm.component": "api",
          },
          { kind: "server" },
        );

    if (span) {
      wireHttpSpanLifecycle(res, span, () => statusCode, startTime);
    }

    // Run request handling inside the HTTP span's active context so any spans
    // created downstream (MCP `mcp.tool` spans, future DB/auto-instrumentation)
    // nest under it instead of attaching to the root with no parent.
    const handleRequest = async () => {
      setCorsHeaders(req, res);
      // Tells polling workers to hand off in-flight tasks while this API still serves.
      if (isApiDraining()) res.setHeader(API_DRAINING_HEADER, "1");

      const queryParams = parseQueryParams(req.url || "");
      let myAgentId = req.headers["x-agent-id"] as string | undefined;

      // ── Route handlers (order matters — first match wins) ──
      const handlers: (() => Promise<boolean>)[] = [
        () => handleAgentRegister(req, res, pathSegments, myAgentId),
        () => handlePoll(req, res, pathSegments, queryParams, myAgentId),
        () => handleSessionData(req, res, pathSegments, queryParams, myAgentId),
        () => handleTrackers(req, res, pathSegments),
        () => handleWebhooks(req, res, pathSegments),
        () => handleAgentsRest(req, res, pathSegments, queryParams, myAgentId),
        () => handleBudgets(req, res, pathSegments, queryParams, myAgentId),
        () => handleContext(req, res, pathSegments, queryParams, myAgentId),
        () => handleAssets(req, res, pathSegments, queryParams, myAgentId),
        () => handleTasks(req, res, pathSegments, queryParams, myAgentId),
        () => handleStats(req, res, pathSegments, queryParams, myAgentId),
        () => handleStatus(req, res, pathSegments, queryParams),
        () => handleOnboarding(req, res, pathSegments, queryParams),
        () => handleCodexOAuthDevice(req, res, pathSegments, queryParams),
        () => handleActiveSessions(req, res, pathSegments, queryParams, myAgentId),
        () => handlePricing(req, res, pathSegments, queryParams, myAgentId),
        () => handleSchedules(req, res, pathSegments, queryParams, myAgentId),
        () => handleWorkflows(req, res, pathSegments, queryParams, myAgentId),
        () => handleWorkflowEvents(req, res, pathSegments, queryParams),
        () => handleApprovalRequests(req, res, pathSegments, queryParams),
        () => handleApps(req, res, pathSegments, queryParams, myAgentId),
        () => handleConfig(req, res, pathSegments, queryParams),
        () => handleFs(req, res, pathSegments, queryParams, myAgentId),
        () => handleComb(req, res, pathSegments, queryParams, myAgentId),
        () => handleKv(req, res, pathSegments, queryParams),
        () => handleRooms(req, res, pathSegments, queryParams),
        () => handleRealtimeTicket(req, res, pathSegments, queryParams),
        () => handleRealtimeAsset(req, res),
        () => handleIntegrations(req, res, pathSegments, queryParams),
        () => handleSlackInbound(req, res, pathSegments),
        () => handlePromptTemplates(req, res, pathSegments, queryParams),
        () => handleDbQuery(req, res, pathSegments, queryParams),
        () => handleMetrics(req, res, pathSegments, queryParams, myAgentId),
        () => handleModelsCatalog(req, res, pathSegments, queryParams),
        () => handleModelProfiles(req, res, pathSegments, queryParams, myAgentId),
        () => handleRepos(req, res, pathSegments, queryParams, myAgentId),
        () => handleSkills(req, res, pathSegments, queryParams, myAgentId),
        () => handleScriptConnections(req, res, pathSegments, queryParams, myAgentId),
        () => handleScriptConnectionProxy(req, res, pathSegments, queryParams, myAgentId),
        () => handleScriptRuns(req, res, pathSegments, queryParams, myAgentId),
        () => handleScripts(req, res, pathSegments, queryParams, myAgentId),
        () => handleX(req, res, pathSegments),
        () => handleMcpBridge(req, res, pathSegments, queryParams, myAgentId),
        () => handleMcpServers(req, res, pathSegments, queryParams),
        () => handleMcpOAuth(req, res, pathSegments, queryParams),
        () => handleMemory(req, res, pathSegments, myAgentId),
        () => handleOAuthLocks(req, res, pathSegments, queryParams),
        () => handleOAuthCallback(req, res, pathSegments, queryParams),
        () => handleGenericOAuth(req, res, pathSegments, queryParams),
        () => handleCodexOAuthKeepWarm(req, res, pathSegments),
        () => handlePagesPublic(req, res, pathSegments, queryParams),
        () => handlePageProxy(req, res),
        () => handlePages(req, res, pathSegments, queryParams, myAgentId),
        () => handleApiKeys(req, res, pathSegments, queryParams),
        () => handleHeartbeat(req, res, pathSegments),
        () => handleEvents(req, res, pathSegments, queryParams, myAgentId),
        () => handleRuntimePools(req, res, pathSegments, queryParams, myAgentId),
        () => handleExtensions(req, res, pathSegments, queryParams, myAgentId),
        () => handleFavorites(req, res, pathSegments, queryParams, myAgentId),
        () => handleUserRoles(req, res, pathSegments, queryParams),
        () => handleUsers(req, res, pathSegments, queryParams),
        () => handleSessions(req, res, pathSegments, queryParams, myAgentId),
        () => handleInboxState(req, res, pathSegments, queryParams),
        () => handleTelemetryUi(req, res, pathSegments, queryParams, myAgentId),
        () => handleUsedBy(req, res, pathSegments, queryParams, myAgentId),
        () => handleRanking(req, res, pathSegments, queryParams),
        () => handleFleetBenchmark(req, res, pathSegments, queryParams),
        () => handleTaskTemplates(req, res, pathSegments, queryParams),
        () => handleMcp(req, res, transports, transportActivity, mcpSessionAgents),
        () => handleMcpUser(req, res, transportsUser, sessionUsers, transportActivityUser),
      ];

      try {
        // ── Core routes (OPTIONS, health, auth, /me, /cancelled-tasks, /ping, /close) ──
        // Inside the try: handleCore used to run before it, so a throw there
        // (observed in prod: a BUSY_SNAPSHOT from updateAgentStatus) escaped
        // the async listener as an unhandled rejection and the client got a
        // dropped connection instead of a 500.
        if (await handleCore(req, res, myAgentId, apiKey)) return;
        myAgentId = req.headers["x-agent-id"] as string | undefined;

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
        writeUnhandledError(res, err, req);
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
const detachRealtime = attachRealtimeTransport(httpServer);
const { attachControllerTransport } = await import("./controllers-connect");
const detachControllers = attachControllerTransport(httpServer);
const stopWorkerNudges = startWorkerNudgeListener();
const stopRoomDeletion = realtimeBus.subscribe("room:namespace-deleted", (namespace) => {
  void Promise.resolve(removeNamespaceRooms(String(namespace))).catch((error) =>
    console.error("[rooms] Deletion failed:", scrubSecrets(String(error))),
  );
});
globalState.__closeRealtime = () => {
  detachRealtime();
  detachControllers();
  stopWorkerNudges();
  stopRoomDeletion();
};
globalState.__httpServer = httpServer;
globalState.__transports = transports;
globalState.__transportsUser = transportsUser;
globalState.__mcpSessionAgents = mcpSessionAgents;
globalState.__sessionUsers = sessionUsers;
globalState.__transportActivity = transportActivity;
globalState.__transportActivityUser = transportActivityUser;
globalState.__stopExtensions = stopExtensionRuntime;

async function shutdown() {
  globalState.__closeRealtime?.();
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
  stopPoolRouting();
  await stopRuntimeSupervisor();

  // Stop the out-of-band queue alarm before disconnecting its Slack notifier.
  stopQueueStallAlarm();

  // Dispatch has stopped. Keep serving, bounded, while workers hand off their
  // in-flight tasks; new work waits for the next API (see src/be/api-drain.ts).
  await drainApi();

  // Stop durable script workflow subprocesses
  await stopScriptRunSupervisor();

  // Stop Slack bot
  await stopSlackApp();

  // Stop Chat SDK adapters and drain their background handlers before the DB closes
  await stopChatSdk();

  // Stop OAuth keepalive
  if (process.env.OAUTH_KEEPALIVE_DISABLE !== "true") {
    const { stopOAuthKeepalive } = await import("../oauth/keepalive");
    await stopOAuthKeepalive();
  }

  // Stop the unified OAuth pending-session garbage collector (all flows)
  stopOAuthPendingGc();

  // Stop memory expired-row garbage collector
  stopMemoryGc();

  // Stop opt-in session, agent-log, and event retention before closing SQLite.
  await stopDbRetention();

  // Stop the human-free reclassification drain before closing SQLite.
  stopHumanFreeDrain();

  // Stop scratch-script retention garbage collector
  stopScratchScriptGc();

  await stopExtensionRuntime();

  // Stop RBAC audit: retention GC, flush interval, final drain, detach sink
  stopAuditGc();
  stopAuditWriter();
  await flushAuditBuffer();
  clearAuditSink();

  if (globalState.__apiGcInterval) {
    clearInterval(globalState.__apiGcInterval);
    delete globalState.__apiGcInterval;
  }

  // Close all active transports (SSE connections, etc.)
  for (const [id, transport] of Object.entries(transports)) {
    console.log(`[HTTP] Closing transport ${id}`);
    void transport.close();
    delete transports[id];
    delete mcpSessionAgents[id];
    delete transportActivity[id];
  }

  for (const [id, transport] of Object.entries(transportsUser)) {
    console.log(`[HTTP] Closing user transport ${id}`);
    void transport.close();
    delete transportsUser[id];
    delete sessionUsers[id];
    delete transportActivityUser[id];
  }

  // Drain accepted requests before flushing rooms and closing their database.
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });
  await closeRooms();
  closeDb();
  console.log("MCP HTTP server closed, and database connection closed");
  process.exit(0);
}

// Only register signal handlers once (avoid duplicates on hot reload)
if (!globalState.__sigintRegistered) {
  globalState.__sigintRegistered = true;
  // A rejected shutdown must not become an unhandled rejection: the signal
  // handler is the last code that runs, so an error here is the only chance to
  // learn why the process failed to exit cleanly.
  process.on("SIGINT", () => {
    shutdownSignal = "SIGINT";
    shutdown().catch((err) =>
      console.error(
        "[shutdown] SIGINT shutdown failed:",
        scrubSecrets(err instanceof Error ? err.message : String(err)),
      ),
    );
  });
  process.on("SIGTERM", () => {
    shutdownSignal = "SIGTERM";
    shutdown().catch((err) =>
      console.error(
        "[shutdown] SIGTERM shutdown failed:",
        scrubSecrets(err instanceof Error ? err.message : String(err)),
      ),
    );
  });
}

if (!globalState.__runId) {
  globalState.__runId = `run_${Date.now()}`;
}

startApiGcInterval();

// Load global swarm configs before the server starts listening so decrypt/key
// failures fail closed instead of leaving the runtime half-initialized.
// override=true: a value saved in the dashboard wins over the deployment env
// at boot, matching the reload path and `createServer`. Otherwise a rotated
// credential saved only in swarm_config silently reverts to the stale env
// value on the next deploy (2026-09-16 prod Slack outage). Reserved keys
// (API_KEY, SECRETS_ENCRYPTION_KEY, ...) stay env-only regardless.
let startupConfigsInjected: string[] = [];
try {
  startupConfigsInjected = await loadGlobalConfigsIntoEnv(true);
} catch (err) {
  console.error("[startup] Failed to load global swarm configs before listen:", err);
  process.exitCode = 1;
  throw err;
}
warnIfCorsAllowsAnyOrigin();

// Register every stored secret (config secrets of all scopes, OAuth and MCP
// OAuth credentials, script API tokens) with the scrubber before listen, so
// egress and the boot retro-sweep below can redact values not touched since
// the last restart. Non-fatal: a decrypt failure only loses redaction coverage.
try {
  const loaded = await loadSecretRegistry();
  console.log(
    `[secret-registry] registered config=${loaded.config} oauth=${loaded.oauth} scriptApi=${loaded.scriptApi} runtimeController=${loaded.runtimeController} failed=${loaded.failed}`,
  );
} catch (err) {
  console.error(
    "[secret-registry] load failed (non-fatal):",
    scrubSecrets(err instanceof Error ? err.message : String(err)),
  );
}

try {
  await seedRuntimePools();
} catch (err) {
  console.error(
    "[startup] Failed to seed runtime pools:",
    scrubSecrets(err instanceof Error ? err.message : String(err)),
  );
}

// Upgrade seed: explicit CAPABILITIES env values that predate capability
// gating get the previously always-registered groups backfilled into a
// global swarm_config row (operator-editable; skipped when a row exists).
// Non-fatal — a seed failure must not brick boot.
try {
  await seedLegacyCapabilitiesConfig();
} catch (err) {
  console.warn("[startup] CAPABILITIES upgrade seed failed (non-fatal):", err);
}

// Phase 2 of the cost-tracking plan: project the vendored models.dev snapshot
// into pricing rows at boot. Lazy `getDb()` would also work, but doing it
// here surfaces the count in the boot log and makes the API ready to recompute
// USD before the first POST /api/session-costs lands.
try {
  // Guarded per DB handle: `createServer()` (one per MCP session) calls the
  // same helper, so seeding here is what keeps session init off this path.
  const { ensurePricingSeeded } = await import("../be/boot-seeds");
  ensurePricingSeeded();
  const { startPricingRefreshLoop } = await import("../be/pricing-refresh");
  startPricingRefreshLoop();
} catch (err) {
  console.error("[startup] Failed to seed pricing rows:", err);
}

try {
  const { ensureModelProfilesSeeded } = await import("../be/boot-seeds");
  await ensureModelProfilesSeeded();
} catch (err) {
  console.error("[startup] Failed to seed model profiles:", err);
}

try {
  const { ensureRbacSeeded } = await import("../be/boot-seeds");
  ensureRbacSeeded();
} catch (err) {
  console.error("[startup] Failed to sync RBAC seed rows:", err);
  // RBAC flag-on must fail closed; flag-off deployments should not be bricked
  // by role-catalog drift for a disabled security feature.
  if (isRbacEnabled()) throw err;
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

try {
  await loadEnabledExtensions();
} catch (err) {
  console.error(
    "[startup] Failed to initialize extensions:",
    scrubSecrets(err instanceof Error ? err.message : String(err)),
  );
}

// Wire the RBAC permission-audit sink into can() and start the batched writer
// (2s flush) + retention GC (daily tick) BEFORE the server accepts traffic —
// installing it inside the listen callback would leave an unaudited startup
// window (requests can land while telemetry/Slack init awaits are pending).
// RBAC_AUDIT_DISABLED=true makes the sink a no-op inside enqueueAuditRow.
setAuditSink(enqueueAuditRow);
startAuditWriter();
await startAuditGc();
startScratchScriptGc();

// business-use initialization (no-op if envs not set)
initialize();

await initOtel("api");

httpServer
  .listen(port, async () => {
    const boundAddress = httpServer.address();
    if (boundAddress && typeof boundAddress === "object") {
      setExtensionLoopbackBaseUrl(`http://127.0.0.1:${boundAddress.port}`);
    }
    console.log(`MCP HTTP server running on http://localhost:${port}/mcp`);

    // Measure the native script sandbox once; /health reports the level as
    // `meta.scripts.sandbox`.
    void getNativeSandboxStatus().then((status) => {
      console.log(
        `[Scripts] Native script sandbox: ${status.level} (uid drop ${status.uidDropped ? "on" : "off"}, seccomp ${status.seccomp ? "on" : "off"}, exec-deny policy ${nativeSeccompPolicy()})${status.error ? `; probe error: ${status.error}` : ""}`,
      );
    });

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
    const telemetryGetConfig = async (key: string) =>
      (await getSwarmConfigs({ scope: "global", key }))?.[0]?.value;
    const telemetrySetConfig = async (key: string, value: string) => {
      await upsertSwarmConfig({ scope: "global", key, value });
    };
    // Also keeps the accessors so turning telemetry on at runtime re-inits it.
    await initApiTelemetry(telemetryGetConfig, telemetrySetConfig);
    telemetry.server("started", { port });
    // Org email domain (hourly + on user changes) and the daily org.snapshot.
    startTelemetryTicker({ getConfig: telemetryGetConfig, setConfig: telemetrySetConfig });
    if (process.env.GITHUB_TOKEN) {
      await emitBuiltInIntegrationConnectedOnce("github");
    }

    // Start Slack bot (if configured). Never let a Slack failure abort the
    // rest of this callback: on 2026-09-16 an invalid app token made
    // app.start() reject here, and the scheduler, heartbeat, script-run
    // supervisor, and OAuth sweeps below never started while /health stayed
    // green for 7 hours. Slack is one integration, not the boot path.
    try {
      await startSlackApp();
    } catch (err) {
      console.error("[Slack] Failed to start, continuing boot without Slack:", err);
    }

    // Chat SDK channel: never the boot path, so not awaited. Adapter init
    // makes network calls (Slack's auth.test retries for up to ~30 min), and
    // the scheduler, heartbeat and supervisor below must start regardless.
    void startChatSdk().catch((err: unknown) => {
      console.error(
        "[chat-sdk] Failed to start, continuing without Chat SDK:",
        scrubSecrets(err instanceof Error ? err.message : String(err)),
      );
    });

    // Independent of workers, scheduler targets, and heartbeat agent tasks.
    startQueueStallAlarm();

    // Initialize GitHub webhook handler (if configured)
    initGitHub();

    // Initialize GitLab webhook handler (if configured)
    initGitLab();

    // Initialize Azure DevOps service-hook handler (if configured)
    initAzureDevOps();
    initAzureDevOpsOutbound();

    // Initialize Bitbucket Cloud webhook handler (if configured)
    initBitbucket();

    // Initialize AgentMail webhook handler (if configured)
    initAgentMail();

    // Initialize Linear tracker integration (if configured)
    await initLinear();

    // Initialize Jira tracker integration (if configured)
    await initJira();

    // Initialize workflow engine (trigger subscriptions + resume listener)
    await initWorkflows();

    // Reconcile durable script workflow subprocesses
    await startScriptRunSupervisor(getMcpBaseUrl());

    // Start scheduler (if enabled)
    if (hasCapability("scheduling")) {
      const { startScheduler } = await import("../scheduler");
      const { getExecutorRegistry } = await import("../workflows");
      const intervalMs = Number(process.env.SCHEDULER_INTERVAL_MS) || 10000;
      startScheduler(getExecutorRegistry(), intervalMs, {
        runId: globalState.__runId!,
      });
    }

    // Start heartbeat triage (unless disabled). Read post-hydration (this block
    // runs after `loadGlobalConfigsIntoEnv`), so a DB-saved value applies on
    // restart — which is what the Configuration page's "Restart required"
    // badge promises for HEARTBEAT_DISABLE / HEARTBEAT_INTERVAL_MS.
    if (!isEnvFlagEnabled("HEARTBEAT_DISABLE", false)) {
      const { startHeartbeat } = await import("../heartbeat");
      const heartbeatMs = Number(process.env.HEARTBEAT_INTERVAL_MS) || 90000;
      startHeartbeat(heartbeatMs);
    }

    startPoolRouting();
    startRuntimeSupervisor();

    // Start OAuth token keepalive (proactive refresh to prevent expiry)
    if (process.env.OAUTH_KEEPALIVE_DISABLE !== "true") {
      const { startOAuthKeepalive } = await import("../oauth/keepalive");
      startOAuthKeepalive();
    }

    // Start generic OAuth token refresh sweep (all oauth_apps providers,
    // 15-min tick, first run ~1 min after boot). Complements the tracker-only
    // keepalive above — see src/be/oauth-refresh-sweep.ts.
    if (process.env.OAUTH_REFRESH_SWEEP_DISABLE !== "true") {
      const { startOAuthRefreshSweep } = await import("../be/oauth-refresh-sweep");
      startOAuthRefreshSweep();
    }

    // Start the unified OAuth pending-session garbage collector (5-min tick, all flows)
    startOAuthPendingGc();

    // Start expired-memory garbage collector (1-hour tick, immediate first run)
    await startMemoryGc();

    // Start the opt-in DB retention sweep after config hydration. Every key is
    // read on each tick, so config reloads take effect without a restart.
    await startDbRetention();

    // Finish the human-free reclassification a request left queued (a very large
    // task tree, or a restart mid-drain). Wakes on demand; see human-free-drain.ts.
    startHumanFreeDrain();

    // (RBAC audit sink is wired pre-listen — see above httpServer.listen.)

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

    // Versioned retro-sweep: once per SCRUBBER_RULES_VERSION, redact stored
    // rows (logs, tasks, memory, events, workflow steps) that pre-date the
    // current scrubber rules. Idempotent and resumable, tracked via seed_state.
    import("../be/boot-scrub-sweep")
      .then(({ runBootScrubSweep }) => runBootScrubSweep())
      .catch((err) => {
        console.error("[boot-scrub-sweep] startup scrub failed (non-fatal):", err);
      });
  })
  .on("error", (err) => {
    console.error("HTTP Server Error:", err);
  });
