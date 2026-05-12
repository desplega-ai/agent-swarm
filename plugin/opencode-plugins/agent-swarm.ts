/**
 * Agent Swarm opencode plugin.
 *
 * Ports swarm hook behaviors (cancellation, heartbeat, identity sync,
 * system.transform, compacting, idle) to opencode plugin events.
 *
 * Required env vars (set by the OpencodeAdapter):
 *   SWARM_API_URL  — swarm API base URL
 *   SWARM_API_KEY  — swarm API key
 *   SWARM_AGENT_ID — agent ID
 *   SWARM_TASK_ID  — current task ID
 *   SWARM_IS_LEAD  — "true" if lead agent, "false" otherwise
 */

import type { Plugin } from "@opencode-ai/plugin";
import { type SwarmConfig, summarizeSessionForOpencode } from "./lib/summarize";

function readConfig(): SwarmConfig {
  return {
    apiUrl: process.env.SWARM_API_URL || `http://localhost:${process.env.PORT || "3013"}`,
    apiKey: process.env.SWARM_API_KEY || "",
    agentId: process.env.SWARM_AGENT_ID || "",
    taskId: process.env.SWARM_TASK_ID || "",
    isLead: process.env.SWARM_IS_LEAD === "true",
  };
}

/** Standard headers for swarm API requests */
function apiHeaders(config: SwarmConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    "X-Agent-ID": config.agentId,
  };
}

/** Fire-and-forget fetch — swallows errors */
function fireAndForget(url: string, init: RequestInit): void {
  void fetch(url, init).catch(() => {});
}

/** Check if a task has been cancelled */
async function isTaskCancelled(
  config: SwarmConfig,
): Promise<{ cancelled: boolean; reason?: string }> {
  try {
    const resp = await fetch(
      `${config.apiUrl}/cancelled-tasks?taskId=${encodeURIComponent(config.taskId)}`,
      { method: "GET", headers: apiHeaders(config) },
    );
    if (!resp.ok) return { cancelled: false };
    const data = (await resp.json()) as {
      cancelled?: Array<{ id: string; failureReason?: string }>;
    };
    const match = data.cancelled?.find((t) => t.id === config.taskId);
    return match ? { cancelled: true, reason: match.failureReason } : { cancelled: false };
  } catch {
    return { cancelled: false };
  }
}

/** Check if agent should stop polling */
async function checkShouldBlockPolling(config: SwarmConfig): Promise<boolean> {
  try {
    const resp = await fetch(`${config.apiUrl}/me`, {
      method: "GET",
      headers: apiHeaders(config),
    });
    if (!resp.ok) return false;
    const data = (await resp.json()) as { shouldBlockPolling?: boolean };
    return data.shouldBlockPolling === true;
  } catch {
    return false;
  }
}

/** Fetch task details for goal reminder */
async function fetchTaskDetails(
  config: SwarmConfig,
): Promise<{ id: string; task: string; progress?: string } | null> {
  try {
    const resp = await fetch(`${config.apiUrl}/api/tasks/${config.taskId}`, {
      method: "GET",
      headers: apiHeaders(config),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as { id: string; task: string; progress?: string };
  } catch {
    return null;
  }
}

/** Sync identity files (SOUL.md, IDENTITY.md, TOOLS.md) to server */
async function syncIdentityFilesToServer(
  config: SwarmConfig,
  changeSource: "self_edit" | "session_sync" = "session_sync",
): Promise<void> {
  const updates: Record<string, string> = {};
  const paths: Record<string, string> = {
    soulMd: "/workspace/SOUL.md",
    identityMd: "/workspace/IDENTITY.md",
    toolsMd: "/workspace/TOOLS.md",
  };

  for (const [key, path] of Object.entries(paths)) {
    try {
      const file = Bun.file(path);
      if (await file.exists()) {
        const content = await file.text();
        if (content.trim() && content.length <= 65536) {
          updates[key] = content;
        }
      }
    } catch {
      /* skip */
    }
  }

  if (Object.keys(updates).length === 0) return;

  try {
    await fetch(`${config.apiUrl}/api/agents/${config.agentId}/profile`, {
      method: "PUT",
      headers: apiHeaders(config),
      body: JSON.stringify({ ...updates, changeSource }),
    });
  } catch {
    /* silently fail */
  }
}

/** Auto-index a file written to memory directory */
async function autoIndexMemoryFile(config: SwarmConfig, editedPath: string): Promise<void> {
  try {
    const fileContent = await Bun.file(editedPath).text();
    const isShared = editedPath.startsWith("/workspace/shared/");
    const fileName = editedPath.split("/").pop() ?? "unnamed";

    await fetch(`${config.apiUrl}/api/memory/index`, {
      method: "POST",
      headers: apiHeaders(config),
      body: JSON.stringify({
        agentId: config.agentId,
        content: fileContent,
        name: fileName.replace(/\.\w+$/, ""),
        scope: isShared ? "swarm" : "agent",
        source: "file_index",
        sourcePath: editedPath,
      }),
    });
  } catch {
    /* non-blocking */
  }
}

/** Fetch concurrent context for lead agents */
async function fetchConcurrentContext(config: SwarmConfig): Promise<string | null> {
  try {
    const resp = await fetch(`${config.apiUrl}/api/concurrent-context`, {
      method: "GET",
      headers: apiHeaders(config),
    });
    if (!resp.ok) return null;

    const data = (await resp.json()) as {
      processingInboxMessages: Array<{ content: string; source: string; createdAt: string }>;
      recentTaskDelegations: Array<{
        task: string;
        agentName: string | null;
        status: string;
      }>;
      activeSwarmTasks: Array<{
        task: string;
        agentName: string | null;
        status: string;
      }>;
    };

    const lines: string[] = [];

    if (data.processingInboxMessages.length > 0) {
      lines.push("=== CONCURRENT SESSION AWARENESS ===");
      lines.push("");
      lines.push("**Other sessions are currently processing these inbox messages:**");
      for (const msg of data.processingInboxMessages) {
        const preview = msg.content.length > 120 ? `${msg.content.slice(0, 120)}...` : msg.content;
        lines.push(`- [${msg.source}] "${preview}" (received ${msg.createdAt})`);
      }
    }

    if (data.recentTaskDelegations.length > 0) {
      if (lines.length === 0) lines.push("=== CONCURRENT SESSION AWARENESS ===");
      lines.push("");
      lines.push("**Recent task delegations (last 5 min):**");
      for (const task of data.recentTaskDelegations) {
        const preview = task.task.length > 120 ? `${task.task.slice(0, 120)}...` : task.task;
        lines.push(`- "${preview}" → ${task.agentName ?? "unassigned"} [${task.status}]`);
      }
    }

    if (data.activeSwarmTasks.length > 0) {
      if (lines.length === 0) lines.push("=== CONCURRENT SESSION AWARENESS ===");
      lines.push("");
      lines.push("**Currently active tasks across the swarm:**");
      for (const task of data.activeSwarmTasks) {
        const preview = task.task.length > 100 ? `${task.task.slice(0, 100)}...` : task.task;
        lines.push(`- ${task.agentName ?? "unassigned"}: "${preview}" [${task.status}]`);
      }
    }

    if (lines.length > 0) {
      lines.push("");
      lines.push(
        "IMPORTANT: Avoid duplicating work that is already being handled by other sessions or agents.",
      );
      lines.push("=== END CONCURRENT SESSION AWARENESS ===");
      return lines.join("\n");
    }

    return null;
  } catch {
    return null;
  }
}

const plugin: Plugin = async (input) => {
  const { client } = input;
  const config = readConfig();

  return {
    // file.edited + session.idle via generic event hook
    event: async ({ event }) => {
      if (event.type === "file.edited") {
        const filePath = event.properties.file;

        // Identity sync on SOUL/IDENTITY/TOOLS/CLAUDE.md edits
        if (
          filePath === "/workspace/SOUL.md" ||
          filePath === "/workspace/IDENTITY.md" ||
          filePath === "/workspace/TOOLS.md" ||
          filePath === "/workspace/CLAUDE.md"
        ) {
          void syncIdentityFilesToServer(config, "self_edit");
        }

        // Memory auto-index
        if (
          filePath.startsWith("/workspace/personal/memory/") ||
          filePath.startsWith("/workspace/shared/memory/")
        ) {
          void autoIndexMemoryFile(config, filePath);
        }
      }

      if (event.type === "session.idle") {
        // Final identity sync
        await syncIdentityFilesToServer(config);

        // Session summary — sources the transcript from opencode's SDK via
        // `client.session.messages` (Phase 2 migration off the previous
        // shellout-based path). Fire-and-forget; the helper handles all
        // errors internally.
        if (!process.env.SKIP_SESSION_SUMMARY) {
          void summarizeSessionForOpencode(config, client, event.properties.sessionID);
        }

        // Notify server session is closing
        fireAndForget(`${config.apiUrl}/api/sessions/${event.properties.sessionID}/close`, {
          method: "POST",
          headers: apiHeaders(config),
        });
      }
    },

    // tool.execute.before: cancellation poll + ScheduleWakeup polling block
    "tool.execute.before": async (input, _output) => {
      // Workers only: check task cancellation
      if (!config.isLead && config.taskId) {
        const { cancelled, reason } = await isTaskCancelled(config);
        if (cancelled) {
          const cancelReason = reason || "Task cancelled by lead or creator";
          throw new Error(
            `🛑 TASK CANCELLED: Your current task (${config.taskId.slice(0, 8)}) has been cancelled. Reason: "${cancelReason}". ` +
              `Stop working on this task immediately. Do NOT continue making tool calls. ` +
              `Use store-progress to acknowledge the cancellation and mark the task as failed, then wait for new tasks.`,
          );
        }
      }

      // Block poll-task when polling limit reached
      if (input.tool.includes("poll-task")) {
        const shouldBlock = await checkShouldBlockPolling(config);
        if (shouldBlock) {
          throw new Error(
            "🛑 POLLING LIMIT REACHED: You have exceeded the maximum empty poll attempts. " +
              "EXIT NOW - do not make any more tool calls.",
          );
        }
      }
    },

    // tool.execute.after: fire-and-forget activity heartbeat
    "tool.execute.after": async (_input, _output) => {
      if (!config.isLead && config.taskId) {
        fireAndForget(`${config.apiUrl}/api/agents/${config.agentId}/activity`, {
          method: "PUT",
          headers: apiHeaders(config),
        });
      }
    },

    // experimental.chat.system.transform: inject concurrent context for lead agents
    "experimental.chat.system.transform": async (_input, output) => {
      if (!config.isLead) return;
      const ctx = await fetchConcurrentContext(config);
      if (ctx) {
        output.system.push(ctx);
      }
    },

    // experimental.session.compacting: re-inject task goal (PreCompact parity)
    "experimental.session.compacting": async (_input, output) => {
      if (!config.taskId) return;
      try {
        const taskDetails = await fetchTaskDetails(config);
        if (taskDetails) {
          const reminder = [
            "=== GOAL REMINDER (injected before context compaction) ===",
            `Task ID: ${taskDetails.id}`,
            `Task: ${taskDetails.task}`,
          ];
          if (taskDetails.progress) {
            reminder.push(`Current Progress: ${taskDetails.progress}`);
          }
          reminder.push("=== Continue working on this task after compaction ===");
          output.context.push(reminder.join("\n"));
        }
      } catch {
        /* don't block compaction */
      }
    },
  };
};

export default plugin;
