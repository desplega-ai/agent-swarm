#!/usr/bin/env bun

import pkg from "../../package.json";
import type { Agent } from "../types";

const SERVER_NAME = pkg.config?.name ?? "agent-swarm";

type McpServerConfig = {
  url: string;
  headers: {
    Authorization: string;
    "X-Agent-ID": string;
  };
};

interface HookMessage {
  hook_event_name: string;
  session_id?: string;
  transcript_path?: string;
  permission_mode?: string;
  cwd?: string;
  source?: string;
  trigger?: string;
  custom_instructions?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  tool_use_id?: string;
  prompt?: string;
  stop_hook_active?: boolean;
}

interface MentionPreview {
  channelName: string;
  agentName: string;
  content: string;
  createdAt: string;
}

interface InboxSummary {
  unreadCount: number;
  mentionsCount: number;
  offeredTasksCount: number;
  poolTasksCount: number;
  inProgressCount: number;
  recentMentions: MentionPreview[];
}

interface AgentWithInbox extends Agent {
  inbox?: InboxSummary;
}

/**
 * Main hook handler - processes Claude Code hook events
 */
export async function handleHook(): Promise<void> {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  let mcpConfig: McpServerConfig | undefined;

  try {
    const mcpFile = Bun.file(`${projectDir}/.mcp.json`);
    if (await mcpFile.exists()) {
      const config = await mcpFile.json();
      mcpConfig = config?.mcpServers?.[SERVER_NAME] as McpServerConfig;
    }
  } catch {
    // No config found, proceed without MCP
  }

  let msg: HookMessage;
  try {
    msg = await Bun.stdin.json();
  } catch {
    // No stdin or invalid JSON - exit silently
    return;
  }

  const getBaseUrl = (): string => {
    if (!mcpConfig) return "";
    try {
      const url = new URL(mcpConfig.url);
      return url.origin;
    } catch {
      return "";
    }
  };

  const hasAgentIdHeader = (): boolean => {
    if (!mcpConfig) return false;
    return Boolean(mcpConfig.headers["X-Agent-ID"]);
  };

  const ping = async (): Promise<void> => {
    if (!mcpConfig) return;

    try {
      await fetch(`${getBaseUrl()}/ping`, {
        method: "POST",
        headers: mcpConfig.headers,
      });
    } catch {
      // Silently fail - server might not be running
    }
  };

  const close = async (): Promise<void> => {
    if (!mcpConfig) return;

    try {
      await fetch(`${getBaseUrl()}/close`, {
        method: "POST",
        headers: mcpConfig.headers,
      });
    } catch {
      // Silently fail
    }
  };

  const getAgentInfo = async (): Promise<AgentWithInbox | undefined> => {
    if (!mcpConfig) return;

    try {
      const resp = await fetch(`${getBaseUrl()}/me?include=inbox`, {
        method: "GET",
        headers: mcpConfig.headers,
      });

      if ([400, 404].includes(resp.status)) {
        return;
      }

      return (await resp.json()) as AgentWithInbox;
    } catch {
      // Silently fail
    }

    return;
  };

  const formatSystemTray = (inbox: InboxSummary): string | null => {
    const {
      unreadCount,
      mentionsCount,
      offeredTasksCount,
      poolTasksCount,
      inProgressCount,
      recentMentions,
    } = inbox;

    // If all counts are zero, return null (no tray)
    if (
      unreadCount === 0 &&
      offeredTasksCount === 0 &&
      poolTasksCount === 0 &&
      inProgressCount === 0
    ) {
      return null;
    }

    const lines: string[] = [];

    // Main tray line
    const parts: string[] = [];

    // Messages section
    if (unreadCount > 0) {
      const mentionsSuffix = mentionsCount > 0 ? ` (${mentionsCount} @mention)` : "";
      parts.push(`📬 ${unreadCount} unread${mentionsSuffix}`);
    }

    // Tasks section
    const taskParts = [
      `${offeredTasksCount} offered`,
      `${poolTasksCount} pool`,
      `${inProgressCount} active`,
    ];
    parts.push(`📋 ${taskParts.join(", ")}`);

    lines.push(parts.join(" | "));

    // Inline @mentions (up to 3)
    if (recentMentions && recentMentions.length > 0) {
      for (const mention of recentMentions) {
        lines.push(
          `  └─ @mention from ${mention.agentName} in #${mention.channelName}: "${mention.content}"`,
        );
      }
    }

    // Nudge - remind to check inbox
    if (unreadCount > 0 || offeredTasksCount > 0) {
      const actions: string[] = [];
      if (unreadCount > 0) actions.push("read-messages");
      if (offeredTasksCount > 0) actions.push("poll-task");
      lines.push(`→ Use ${actions.join(" or ")} to check`);
    }

    return lines.join("\n");
  };

  // Ping the server to indicate activity
  await ping();

  // Get current agent info
  const agentInfo = await getAgentInfo();

  // Always output agent status with system tray
  if (agentInfo) {
    // Base status line
    console.log(
      `You are registered as ${agentInfo.isLead ? "lead" : "worker"} agent "${agentInfo.name}" (ID: ${agentInfo.id}, status: ${agentInfo.status}).`,
    );

    // System tray (if there's activity)
    if (agentInfo.inbox) {
      const tray = formatSystemTray(agentInfo.inbox);
      if (tray) {
        console.log(tray);
      }
    }

    if (!agentInfo.isLead && agentInfo.status === "busy") {
      console.log(
        `Remember to call store-progress periodically to update the lead agent on your progress as you are currently marked as busy. The comments you leave will be helpful for the lead agent to monitor your work.`,
      );
    }
  } else {
    console.log(
      `You are not registered in the agent swarm yet. Use the join-swarm tool to register yourself, then check your status with my-agent-info.

If the ${SERVER_NAME} server is not running or disabled, disregard this message.

${hasAgentIdHeader() ? `You have a pre-defined agent ID via header: ${mcpConfig?.headers["X-Agent-ID"]}, it will be used automatically on join-swarm.` : "You do not have a pre-defined agent ID, you will receive one when you join the swarm, or optionally you can request one when calling join-swarm."}`,
    );
  }

  // Handle specific hook events
  switch (msg.hook_event_name) {
    case "SessionStart":
      if (!agentInfo) break;

      // System prompt - tool reference (only on SessionStart)
      console.log(`
## Agent Swarm Tools
**Messages:** read-messages (no channel = all unread), post-message
**Tasks:** poll-task (wait), task-action (claim/release), store-progress (update)
**Info:** get-swarm (agents), get-tasks (tasks), get-task-details (task info)
`);

      if (agentInfo.isLead) {
        console.log(
          `As the lead agent, coordinate the swarm to fulfill the user's request efficiently.`,
        );
      } else {
        console.log(
          `As a worker agent, use poll-task to wait for tasks or task-action to claim from pool.`,
        );
      }
      break;

    case "PreCompact":
      // Covered by SessionStart hook
      break;

    case "PreToolUse":
      // Nothing to do here for now
      break;

    case "PostToolUse":
      if (agentInfo) {
        if (agentInfo.isLead) {
          if (msg.tool_name?.endsWith("send-task")) {
            const maybeTaskId = (msg.tool_response as { task?: { id?: string } })?.task?.id;

            console.log(
              `Task sent successfully.${maybeTaskId ? ` Task ID: ${maybeTaskId}.` : ""} Monitor progress using the get-task-details tool periodically.`,
            );
          }
        } else {
          console.log(
            `Remember to call store-progress periodically to update the lead agent on your progress.`,
          );
        }
      }
      break;

    case "UserPromptSubmit":
      // Nothing specific for now
      break;

    case "Stop":
      // Mark the agent as offline
      await close();
      break;

    default:
      break;
  }
}

// Run directly when executed as a script
const isMainModule = import.meta.main;
if (isMainModule) {
  await handleHook();
  process.exit(0);
}
