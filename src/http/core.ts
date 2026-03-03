import type { IncomingMessage, ServerResponse } from "node:http";
import {
  getAgentById,
  getDb,
  getInboxSummary,
  getRecentlyCancelledTasksForAgent,
  getResolvedConfig,
  getTaskById,
  shouldBlockPolling,
  updateAgentStatus,
} from "../be/db";
import {
  initAgentMail,
  isAgentMailEnabled,
  resetAgentMail,
} from "../agentmail";
import {
  initGitHub,
  isGitHubEnabled,
  resetGitHub,
} from "../github";
import { startSlackApp, stopSlackApp } from "../slack";
import type { AgentStatus } from "../types";
import { agentWithCapacity, parseQueryParams } from "./utils";

/**
 * Load global swarm_config entries into process.env.
 * When override=false (default, used at startup), existing env vars take precedence.
 * When override=true (used for reload), DB values overwrite process.env.
 * Returns the list of keys that were set/updated.
 */
export function loadGlobalConfigsIntoEnv(override = false): string[] {
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
        return true;
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
