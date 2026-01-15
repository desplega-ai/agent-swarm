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

interface CancelledTask {
  id: string;
  task: string;
  failureReason?: string;
}

interface CancelledTasksResponse {
  cancelled: CancelledTask[];
}

/**
 * Hook response for blocking actions
 * See: https://code.claude.com/docs/en/hooks
 */
interface HookBlockResponse {
  decision: "block";
  reason: string;
}

/**
 * Task file data written by runner to /tmp for hook to read
 */
interface TaskFileData {
  taskId: string;
  agentId: string;
  startedAt: string;
}

/**
 * Read task file from TASK_FILE env var.
 * Returns null if file doesn't exist or can't be read.
 */
async function readTaskFile(): Promise<TaskFileData | null> {
  const taskFilePath = process.env.TASK_FILE;
  if (!taskFilePath) {
    return null;
  }

  try {
    const file = Bun.file(taskFilePath);
    if (!(await file.exists())) {
      return null;
    }
    return (await file.json()) as TaskFileData;
  } catch {
    return null;
  }
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

  /**
   * Check for recently cancelled tasks for this agent.
   * Used to detect task cancellation and stop the worker loop.
   * @deprecated Use isTaskCancelled with specific taskId from task file instead
   */
  const getCancelledTasks = async (): Promise<CancelledTask[]> => {
    if (!mcpConfig) return [];

    try {
      const resp = await fetch(`${getBaseUrl()}/cancelled-tasks`, {
        method: "GET",
        headers: mcpConfig.headers,
      });

      if (!resp.ok) {
        return [];
      }

      const data = (await resp.json()) as CancelledTasksResponse;
      return data.cancelled || [];
    } catch {
      // Silently fail
      return [];
    }
  };

  /**
   * Check if a specific task has been cancelled.
   * Uses task file approach for precise cancellation detection.
   */
  const isTaskCancelled = async (
    taskId: string,
  ): Promise<{ cancelled: boolean; reason?: string }> => {
    if (!mcpConfig) return { cancelled: false };

    try {
      const resp = await fetch(
        `${getBaseUrl()}/cancelled-tasks?taskId=${encodeURIComponent(taskId)}`,
        {
          method: "GET",
          headers: mcpConfig.headers,
        },
      );

      if (!resp.ok) {
        return { cancelled: false };
      }

      const data = (await resp.json()) as CancelledTasksResponse;
      const cancelledTask = data.cancelled?.find((t) => t.id === taskId);
      if (cancelledTask) {
        return { cancelled: true, reason: cancelledTask.failureReason };
      }
      return { cancelled: false };
    } catch {
      // Silently fail
      return { cancelled: false };
    }
  };

  /**
   * Output a blocking response to stop Claude from continuing.
   * This is used when a task has been cancelled.
   */
  const outputBlockResponse = (reason: string): void => {
    const response: HookBlockResponse = {
      decision: "block",
      reason,
    };
    console.log(JSON.stringify(response));
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

      // Covered by base system prompt
      break;

    case "PreCompact":
      // Covered by SessionStart hook
      break;

    case "PreToolUse": {
      // For worker agents, check if their task has been cancelled
      // If so, block the tool call and tell Claude to stop
      if (agentInfo && !agentInfo.isLead && agentInfo.status === "busy") {
        // Use task file approach for precise cancellation detection
        const taskFileData = await readTaskFile();
        if (taskFileData) {
          // Task file exists - check if this specific task is cancelled
          const { cancelled, reason } = await isTaskCancelled(taskFileData.taskId);
          if (cancelled) {
            const cancelReason = reason || "Task cancelled by lead or creator";
            outputBlockResponse(
              `🛑 TASK CANCELLED: Your current task (${taskFileData.taskId.slice(0, 8)}) has been cancelled. Reason: "${cancelReason}". ` +
                `Stop working on this task immediately. Do NOT continue making tool calls. ` +
                `Use store-progress to acknowledge the cancellation and mark the task as failed, then wait for new tasks.`,
            );
            return; // Exit early - don't process other hooks
          }
        } else {
          // No task file - fallback to general check for backwards compatibility
          // This also serves as a safety net when TASK_FILE env var is not set
          const cancelledTasks = await getCancelledTasks();
          const firstCancelledTask = cancelledTasks[0];
          if (firstCancelledTask) {
            const cancelReason =
              firstCancelledTask.failureReason || "Task cancelled by lead or creator";
            outputBlockResponse(
              `🛑 TASK CANCELLED: A task has been cancelled. Reason: "${cancelReason}". ` +
                `Stop working and verify your current task status with store-progress. ` +
                `Note: TASK_FILE not found - consider restarting if this persists.`,
            );
            return; // Exit early - don't process other hooks
          }
        }
      }
      break;
    }

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

    case "UserPromptSubmit": {
      // For worker agents, check if their task has been cancelled
      // This catches cancellations at the start of a new iteration
      if (agentInfo && !agentInfo.isLead && agentInfo.status === "busy") {
        // Use task file approach for precise cancellation detection
        const taskFileData = await readTaskFile();
        if (taskFileData) {
          // Task file exists - check if this specific task is cancelled
          const { cancelled, reason } = await isTaskCancelled(taskFileData.taskId);
          if (cancelled) {
            const cancelReason = reason || "Task cancelled by lead or creator";
            outputBlockResponse(
              `🛑 TASK CANCELLED: Your current task (${taskFileData.taskId.slice(0, 8)}) has been cancelled. Reason: "${cancelReason}". ` +
                `Stop working on this task immediately. ` +
                `Acknowledge this cancellation and wait for new tasks.`,
            );
            return; // Exit early
          }
        } else {
          // No task file - fallback to general check for backwards compatibility
          const cancelledTasks = await getCancelledTasks();
          const firstCancelledTask = cancelledTasks[0];
          if (firstCancelledTask) {
            const cancelReason =
              firstCancelledTask.failureReason || "Task cancelled by lead or creator";
            outputBlockResponse(
              `🛑 TASK CANCELLED: A task has been cancelled. Reason: "${cancelReason}". ` +
                `Stop working and verify your current task status. ` +
                `Note: TASK_FILE not found - consider restarting if this persists.`,
            );
            return; // Exit early
          }
        }
      }
      break;
    }

    case "Stop":
      // Save PM2 processes before shutdown (for container restart persistence)
      try {
        await Bun.$`pm2 save`.quiet();
      } catch {
        // PM2 not available or no processes - silently ignore
      }
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
