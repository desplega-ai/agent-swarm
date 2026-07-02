import type { IncomingMessage, ServerResponse } from "node:http";
import { initAgentMail, resetAgentMail } from "../agentmail";
import {
  getAgentById,
  getDb,
  getInboxSummary,
  getInjectableGlobalConfigs,
  getRecentlyCancelledTasksForAgent,
  getTaskById,
  shouldBlockPolling,
  updateAgentStatus,
} from "../be/db";
import { initGitHub, resetGitHub } from "../github";
import { initJira, resetJira } from "../jira";
import { initLinear, resetLinear } from "../linear";
import { startSlackApp, stopSlackApp } from "../slack";
import type { AgentStatus } from "../types";
import { setRequestAuth } from "../utils/request-auth-context";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";
import { resolveHttpRequestAuth } from "./auth";
import { generateOpenApiSpec, SCALAR_HTML } from "./openapi";
import { isPublicRoute } from "./route-def";
import { agentWithCapacity, getPathSegments, parseQueryParams } from "./utils";

/**
 * Load global swarm_config entries into process.env.
 * When override=false (default, used at startup), existing env vars take precedence.
 * When override=true (used for reload), DB values overwrite process.env.
 * Reserved keys are filtered before decryption because they must remain
 * environment-only, even if legacy rows still exist in the DB.
 * Returns the list of keys that were set/updated.
 */
export function loadGlobalConfigsIntoEnv(override = false): string[] {
  const globalConfigs = getInjectableGlobalConfigs();
  const updated: string[] = [];
  for (const config of globalConfigs) {
    if (override || !process.env[config.key]) {
      process.env[config.key] = config.value;
      updated.push(config.key);
    }
  }
  // The scrubber caches process.env-derived secret values; invalidate so the
  // next scrub picks up any new/rotated secrets we just injected.
  if (updated.length > 0) {
    refreshSecretScrubberCache();
  }
  return updated;
}

export type ReloadConfigResult = {
  configsLoaded: number;
  keysUpdated: string[];
  integrationsReinitialized: string[];
};

/**
 * Re-read swarm_config into process.env with override=true, then reset and
 * re-init each integration so long-lived clients (Slack socket mode, etc.)
 * pick up the new values without requiring a process restart.
 */
export async function reloadGlobalConfigsAndIntegrations(): Promise<ReloadConfigResult> {
  const updated = loadGlobalConfigsIntoEnv(true);

  const integrations: string[] = [];

  resetAgentMail();
  if (initAgentMail()) integrations.push("agentmail");

  resetGitHub();
  if (initGitHub()) integrations.push("github");

  resetLinear();
  if (initLinear()) integrations.push("linear");

  resetJira();
  if (initJira()) integrations.push("jira");

  await stopSlackApp();
  await startSlackApp();
  integrations.push("slack");

  return {
    configsLoaded: updated.length,
    keysUpdated: updated,
    integrationsReinitialized: integrations,
  };
}

// ─── Auto-reload debouncer ────────────────────────────────────────────────────
// Why this exists: the integrations dashboard saves a row at a time (no bulk
// endpoint — see apps/ui/src/api/hooks/use-config-api.ts useUpsertConfigsBatch),
// so a "save" of N keys produces N upsert calls in tight succession. Reloading
// after each one would tear Slack's socket down N times. Coalesce instead.
let pendingReloadTimer: ReturnType<typeof setTimeout> | null = null;
let inFlightReload: Promise<ReloadConfigResult> | null = null;
let reloadRerunRequested = false;
let autoReloadInvocations = 0;
const AUTO_RELOAD_DEBOUNCE_MS = 250;

/**
 * Schedule a coalesced integrations reload. Repeated calls within the debounce
 * window collapse into a single reload. If a reload is currently running, the
 * scheduler defers the next one until it finishes (so a save during a reload
 * still re-runs once afterwards).
 *
 * Fire-and-forget — failures are logged and swallowed so callers (HTTP handlers)
 * don't have to await the reload before responding.
 */
export function scheduleIntegrationsReload(delayMs = AUTO_RELOAD_DEBOUNCE_MS): void {
  if (inFlightReload) {
    reloadRerunRequested = true;
    return;
  }
  if (pendingReloadTimer) {
    clearTimeout(pendingReloadTimer);
  }
  pendingReloadTimer = setTimeout(() => {
    pendingReloadTimer = null;
    autoReloadInvocations += 1;
    inFlightReload = reloadGlobalConfigsAndIntegrations()
      .then((r) => {
        console.log(
          `[auto-reload] Loaded ${r.configsLoaded} config(s), re-initialized: ${r.integrationsReinitialized.join(", ") || "none"}`,
        );
        return r;
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[auto-reload] Failed:", message);
        throw err;
      })
      .finally(() => {
        inFlightReload = null;
        if (reloadRerunRequested) {
          reloadRerunRequested = false;
          scheduleIntegrationsReload(delayMs);
        }
      });
  }, delayMs);
}

/**
 * For tests + shutdown: cancel any pending timer and await any in-flight
 * reload. Returns once the queue is fully drained.
 */
export async function flushPendingIntegrationsReload(): Promise<void> {
  if (pendingReloadTimer) {
    clearTimeout(pendingReloadTimer);
    pendingReloadTimer = null;
    autoReloadInvocations += 1;
    inFlightReload = reloadGlobalConfigsAndIntegrations()
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[auto-reload] flush failed:", message);
        throw err;
      })
      .finally(() => {
        inFlightReload = null;
      }) as Promise<ReloadConfigResult>;
  }
  if (inFlightReload) {
    try {
      await inFlightReload;
    } catch {
      // Already logged; flush should not throw on caller's path.
    }
  }
  // Drain any reruns queued while we were awaiting.
  while (reloadRerunRequested) {
    reloadRerunRequested = false;
    autoReloadInvocations += 1;
    inFlightReload = reloadGlobalConfigsAndIntegrations()
      .catch(() => null)
      .finally(() => {
        inFlightReload = null;
      }) as Promise<ReloadConfigResult>;
    await inFlightReload;
  }
}

// ─── Test helpers (stable surface for src/tests/) ─────────────────────────────
// Module state is intentionally process-global; tests need to reset it between
// cases to avoid cross-contamination. Not part of the public HTTP API.
export function _autoReloadStatsForTests(): { invocations: number; pending: boolean } {
  return { invocations: autoReloadInvocations, pending: pendingReloadTimer !== null };
}
export function _resetAutoReloadForTests(): void {
  if (pendingReloadTimer) {
    clearTimeout(pendingReloadTimer);
    pendingReloadTimer = null;
  }
  inFlightReload = null;
  reloadRerunRequested = false;
  autoReloadInvocations = 0;
}

export async function handleCore(
  req: IncomingMessage,
  res: ServerResponse,
  myAgentId: string | undefined,
  apiKey: string,
): Promise<boolean> {
  // Handle preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

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

    return true;
  }

  if (req.url === "/openapi.json") {
    const version = (await Bun.file("package.json").json()).version;
    const spec = generateOpenApiSpec({ version });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(spec);
    return true;
  }

  if (req.url === "/docs" || req.url === "/docs/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(SCALAR_HTML);
    return true;
  }

  // API-key authentication. Routes that opt out via
  // `route({ auth: { apiKey: false } })` — webhooks, OAuth provider callbacks,
  // etc. — are skipped based on the central `routeRegistry`. Unknown paths
  // fall through to the bearer check (fail-closed). Normal API calls may use
  // either the global swarm key or an active user-bound `aswt_` token.
  const pathSegments = getPathSegments(req.url || "");
  const isUserMcpRoute = req.url === "/mcp-user";
  // `/mcp-user` runs its own `aswt_`-token auth in `handleMcpUser`; the swarm
  // API key must not gate it.
  if (isUserMcpRoute || isPublicRoute(req.method, pathSegments)) {
    setRequestAuth(req, null);
  } else {
    const auth = resolveHttpRequestAuth(req, apiKey);

    if (!auth) {
      setRequestAuth(req, null);
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return true;
    }
    setRequestAuth(req, auth);
  }

  // POST /internal/reload-config — re-read swarm_config into process.env and re-init integrations
  if (req.method === "POST" && req.url === "/internal/reload-config") {
    try {
      const result = await reloadGlobalConfigsAndIntegrations();
      console.log(
        `[reload-config] Loaded ${result.configsLoaded} config(s), re-initialized: ${result.integrationsReinitialized.join(", ") || "none"}`,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, ...result }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("[reload-config] Failed:", message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to reload config", details: message }));
    }
    return true;
  }

  if (req.method === "GET" && (req.url === "/me" || req.url?.startsWith("/me?"))) {
    if (!myAgentId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing X-Agent-ID header" }));
      return true;
    }

    const agent = getAgentById(myAgentId);

    if (!agent) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Agent not found" }));
      return true;
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
      return true;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(agentResponse));
    return true;
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
      return true;
    }

    const agent = getAgentById(myAgentId);
    if (!agent) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Agent not found" }));
      return true;
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
        return true;
      }
      // Task not found or not cancelled
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ cancelled: [] }));
      return true;
    }

    // No taskId - return all recently cancelled tasks for this agent
    const cancelledTasks = getRecentlyCancelledTasksForAgent(myAgentId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ cancelled: cancelledTasks }));
    return true;
  }

  if (req.method === "POST" && req.url === "/ping") {
    if (!myAgentId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing X-Agent-ID header" }));
      return true;
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
      } else if (agent.status === "waiting_for_credentials") {
        // Preserve the waiting state — only the worker's own credential-wait
        // tick (POST /api/agents/:id/credential-status) clears it once creds
        // resolve. The pinger must not stomp it back to idle.
        status = "waiting_for_credentials";
      }

      updateAgentStatus(agent.id, status);

      return true;
    });

    if (!tx()) {
      return true;
    }

    res.writeHead(204);
    res.end();
    return true;
  }

  if (req.method === "POST" && req.url === "/close") {
    if (!myAgentId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing X-Agent-ID header" }));
      return true;
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
      return true;
    }

    res.writeHead(204);
    res.end();
    return true;
  }

  return false;
}
