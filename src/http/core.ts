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
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";
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

  // API-key authentication (if API_KEY is configured). Routes that opt out via
  // `route({ auth: { apiKey: false } })` — webhooks, OAuth provider callbacks,
  // etc. — are skipped based on the central `routeRegistry`. Unknown paths
  // fall through to the bearer check (fail-closed).
  if (apiKey) {
    const pathSegments = getPathSegments(req.url || "");
    if (!isPublicRoute(req.method, pathSegments)) {
      const authHeader = req.headers.authorization;
      const providedKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

      if (providedKey !== apiKey) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return true;
      }
    }
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
