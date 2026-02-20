#!/usr/bin/env bun

import pkg from "../../package.json";
import type { Agent } from "../types";

const SERVER_NAME = pkg.config?.name ?? "agent-swarm";

// CLAUDE.md file paths
const CLAUDE_MD_PATH = `${process.env.HOME}/.claude/CLAUDE.md`;
const CLAUDE_MD_BACKUP_PATH = `${process.env.HOME}/.claude/CLAUDE.md.bak`;

// Identity file paths (workspace root)
const SOUL_MD_PATH = "/workspace/SOUL.md";
const IDENTITY_MD_PATH = "/workspace/IDENTITY.md";

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

/** Fetch task details from API (for PreCompact goal reminder) */
async function fetchTaskDetails(
  taskId: string,
): Promise<{ id: string; task: string; progress?: string } | null> {
  const apiUrl = process.env.MCP_BASE_URL || "http://localhost:3013";
  const apiKey = process.env.API_KEY || "";
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const response = await fetch(`${apiUrl}/api/tasks/${taskId}`, { headers });
    if (!response.ok) return null;
    return (await response.json()) as { id: string; task: string; progress?: string };
  } catch {
    return null;
  }
}

/**
 * Backup existing CLAUDE.md file if it exists
 */
async function backupExistingClaudeMd(): Promise<void> {
  const file = Bun.file(CLAUDE_MD_PATH);
  if (await file.exists()) {
    const content = await file.text();
    await Bun.write(CLAUDE_MD_BACKUP_PATH, content);
  }
}

/**
 * Write agent's CLAUDE.md content to ~/.claude/CLAUDE.md
 */
async function writeAgentClaudeMd(content: string): Promise<void> {
  // Ensure ~/.claude directory exists
  const dir = `${process.env.HOME}/.claude`;
  try {
    await Bun.$`mkdir -p ${dir}`.quiet();
  } catch {
    // Directory may already exist
  }
  await Bun.write(CLAUDE_MD_PATH, content);
}

/**
 * Restore CLAUDE.md from backup or remove it if no backup exists
 */
async function restoreClaudeMdBackup(): Promise<void> {
  const backupFile = Bun.file(CLAUDE_MD_BACKUP_PATH);
  if (await backupFile.exists()) {
    const content = await backupFile.text();
    await Bun.write(CLAUDE_MD_PATH, content);
    // Remove backup file
    await Bun.$`rm -f ${CLAUDE_MD_BACKUP_PATH}`.quiet();
  } else {
    // No backup existed, remove the agent's CLAUDE.md
    await Bun.$`rm -f ${CLAUDE_MD_PATH}`.quiet();
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
   * Sync CLAUDE.md content back to the server
   */
  const syncClaudeMdToServer = async (agentId: string): Promise<void> => {
    if (!mcpConfig) return;

    const file = Bun.file(CLAUDE_MD_PATH);
    if (!(await file.exists())) return;

    const content = await file.text();

    // Don't sync if content is empty or too large (>64KB)
    if (!content.trim() || content.length > 65536) return;

    try {
      await fetch(`${getBaseUrl()}/api/agents/${agentId}/profile`, {
        method: "PUT",
        headers: {
          ...mcpConfig.headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ claudeMd: content }),
      });
    } catch {
      // Silently fail - don't block shutdown
    }
  };

  /**
   * Sync SOUL.md and IDENTITY.md content back to the server
   */
  const syncIdentityFilesToServer = async (agentId: string): Promise<void> => {
    if (!mcpConfig) return;

    const updates: Record<string, string> = {};

    const soulFile = Bun.file(SOUL_MD_PATH);
    if (await soulFile.exists()) {
      const content = await soulFile.text();
      if (content.trim() && content.length <= 65536) {
        updates.soulMd = content;
      }
    }

    const identityFile = Bun.file(IDENTITY_MD_PATH);
    if (await identityFile.exists()) {
      const content = await identityFile.text();
      if (content.trim() && content.length <= 65536) {
        updates.identityMd = content;
      }
    }

    const TOOLS_MD_PATH = "/workspace/TOOLS.md";
    try {
      const toolsMdFile = Bun.file(TOOLS_MD_PATH);
      if (await toolsMdFile.exists()) {
        const content = await toolsMdFile.text();
        if (content.trim() && content.length <= 65536) {
          updates.toolsMd = content;
        }
      }
    } catch {
      /* skip */
    }

    if (Object.keys(updates).length === 0) return;

    try {
      await fetch(`${getBaseUrl()}/api/agents/${agentId}/profile`, {
        method: "PUT",
        headers: {
          ...mcpConfig.headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(updates),
      });
    } catch {
      // Silently fail
    }
  };

  /**
   * Sync setup script content back to the server.
   * Extracts only agent-managed content between markers to avoid duplicating operator content.
   */
  const syncSetupScriptToServer = async (agentId: string): Promise<void> => {
    if (!mcpConfig) return;

    const SETUP_SCRIPT_PATH = "/workspace/start-up.sh";
    const file = Bun.file(SETUP_SCRIPT_PATH);
    if (!(await file.exists())) return;

    const raw = await file.text();
    if (!raw.trim()) return;

    const markerStart = "# === Agent-managed setup (from DB) ===";
    const markerEnd = "# === End agent-managed setup ===";
    const startIdx = raw.indexOf(markerStart);
    const endIdx = raw.indexOf(markerEnd);

    let content: string;
    if (startIdx !== -1 && endIdx !== -1) {
      // Markers present — extract ONLY the content between them.
      content = raw.substring(startIdx + markerStart.length, endIdx).trim();
    } else {
      // No markers — agent created/replaced the entire file. Store as-is minus shebang.
      content = raw.replace(/^#!\/bin\/bash\n/, "").trim();
    }

    if (!content || content.length > 65536) return;

    try {
      await fetch(`${getBaseUrl()}/api/agents/${agentId}/profile`, {
        method: "PUT",
        headers: {
          ...mcpConfig.headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ setupScript: content }),
      });
    } catch {
      /* silently fail */
    }
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

  /**
   * Check for task cancellation and output a block response if cancelled.
   * Used by both PreToolUse and UserPromptSubmit hooks.
   * @param includeTaskFileWarning Whether to include a warning about missing TASK_FILE (for PreToolUse)
   * @returns true if task is cancelled (and response was output), false otherwise
   */
  const checkAndBlockIfCancelled = async (includeTaskFileWarning: boolean): Promise<boolean> => {
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
        return true;
      }
    } else {
      // No task file - fallback to general check for backwards compatibility
      // This also serves as a safety net when TASK_FILE env var is not set
      const cancelledTasks = await getCancelledTasks();
      const firstCancelledTask = cancelledTasks[0];
      if (firstCancelledTask) {
        const cancelReason =
          firstCancelledTask.failureReason || "Task cancelled by lead or creator";
        const taskFileNote = includeTaskFileWarning
          ? ` Note: TASK_FILE not found - consider restarting if this persists.`
          : "";
        outputBlockResponse(
          `🛑 TASK CANCELLED: A task has been cancelled. Reason: "${cancelReason}". ` +
            `Stop working and verify your current task status with store-progress.${taskFileNote}`,
        );
        return true;
      }
    }
    return false;
  };

  /**
   * Check if agent has exceeded poll limit and should stop polling.
   * @returns true if polling should be blocked, false otherwise
   */
  const checkShouldBlockPolling = async (): Promise<boolean> => {
    if (!mcpConfig) return false;
    try {
      const resp = await fetch(`${getBaseUrl()}/me`, {
        method: "GET",
        headers: mcpConfig.headers,
      });
      if (!resp.ok) return false;
      const data = (await resp.json()) as AgentWithInbox & { shouldBlockPolling?: boolean };
      return data.shouldBlockPolling === true;
    } catch {
      return false;
    }
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

      // Write agent's CLAUDE.md if available
      if (agentInfo.claudeMd) {
        try {
          await backupExistingClaudeMd();
          await writeAgentClaudeMd(agentInfo.claudeMd);
          console.log("Loaded your personal CLAUDE.md configuration.");
        } catch (error) {
          console.log(`Warning: Could not load CLAUDE.md: ${(error as Error).message}`);
        }
      }
      break;

    case "PreCompact": {
      // Inject goal reminder before context compaction
      const taskFileData = await readTaskFile();
      if (taskFileData?.taskId) {
        try {
          const taskDetails = await fetchTaskDetails(taskFileData.taskId);
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
            console.log(reminder.join("\n"));
          }
        } catch {
          // Don't block compaction if fetch fails
        }
      }
      break;
    }

    case "PreToolUse": {
      // For worker agents, check if their task has been cancelled
      // If so, block the tool call and tell Claude to stop
      if (agentInfo && !agentInfo.isLead && agentInfo.status === "busy") {
        if (await checkAndBlockIfCancelled(true)) {
          return; // Exit early - don't process other hooks
        }
      }

      // Block poll-task when polling limit reached
      if (msg.tool_name?.endsWith("poll-task")) {
        const shouldBlock = await checkShouldBlockPolling();
        if (shouldBlock) {
          outputBlockResponse(
            `🛑 POLLING LIMIT REACHED: You have exceeded the maximum empty poll attempts. ` +
              `EXIT NOW - do not make any more tool calls.`,
          );
          return;
        }
      }
      break;
    }

    case "PostToolUse":
      if (agentInfo) {
        // Sync identity files when agent edits them
        const toolName = msg.tool_name;
        const toolInput = msg.tool_input as { file_path?: string } | undefined;
        const editedPath = toolInput?.file_path;

        if (
          (toolName === "Write" || toolName === "Edit") &&
          editedPath &&
          (editedPath === SOUL_MD_PATH || editedPath === IDENTITY_MD_PATH)
        ) {
          try {
            await syncIdentityFilesToServer(agentInfo.id);
          } catch {
            // Non-blocking — don't interrupt the agent's workflow
          }
        }

        // Sync setup script edits back to DB
        if (
          (toolName === "Write" || toolName === "Edit") &&
          editedPath &&
          editedPath.startsWith("/workspace/start-up")
        ) {
          try {
            await syncSetupScriptToServer(agentInfo.id);
          } catch {
            // Non-blocking
          }
        }

        // Sync TOOLS.md edits back to DB
        if ((toolName === "Write" || toolName === "Edit") && editedPath === "/workspace/TOOLS.md") {
          try {
            await syncIdentityFilesToServer(agentInfo.id);
          } catch {
            // Non-blocking
          }
        }

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
        if (await checkAndBlockIfCancelled(true)) {
          return; // Exit early
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

      // Sync CLAUDE.md, identity files, and setup script back to database, then restore backup
      if (agentInfo?.id) {
        try {
          await syncClaudeMdToServer(agentInfo.id);
          await syncIdentityFilesToServer(agentInfo.id);
          await syncSetupScriptToServer(agentInfo.id);
          await restoreClaudeMdBackup();
        } catch {
          // Silently fail - don't block shutdown
        }
      }

      // Mark the agent as offline
      await close();
      // NOTE: Task completion is NOT handled here intentionally.
      // The runner wrapper (src/commands/runner.ts) handles ensuring tasks are
      // marked as completed/failed when a Claude process exits. This approach is
      // more reliable because:
      // 1. It happens outside the Claude Code loop, so it runs even if Claude crashes
      // 2. The runner knows the process exit code to determine success/failure
      // 3. The API is idempotent - if the agent already called store-progress, no change
      // See: ensureTaskFinished() in runner.ts and POST /api/tasks/:id/finish
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
