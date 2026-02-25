#!/usr/bin/env bun

import pkg from "../../package.json";
import type { Agent } from "../types";
import { checkToolLoop, clearToolHistory } from "./tool-loop-detection";

const SERVER_NAME = pkg.config?.name ?? "agent-swarm";

// CLAUDE.md file paths
const CLAUDE_MD_PATH = `${process.env.HOME}/.claude/CLAUDE.md`;
const CLAUDE_MD_BACKUP_PATH = `${process.env.HOME}/.claude/CLAUDE.md.bak`;

// Identity and workspace file paths
const SOUL_MD_PATH = "/workspace/SOUL.md";
const IDENTITY_MD_PATH = "/workspace/IDENTITY.md";
const TOOLS_MD_PATH = "/workspace/TOOLS.md";
const SETUP_SCRIPT_PATH = "/workspace/start-up.sh";

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

  interface ConcurrentContextResponse {
    processingInboxMessages: Array<{
      id: string;
      content: string;
      source: string;
      slackChannelId: string | null;
      slackThreadTs: string | null;
      createdAt: string;
    }>;
    recentTaskDelegations: Array<{
      id: string;
      task: string;
      agentId: string | null;
      agentName: string | null;
      creatorAgentId: string | null;
      status: string;
      createdAt: string;
    }>;
    activeSwarmTasks: Array<{
      id: string;
      task: string;
      agentId: string | null;
      agentName: string | null;
      status: string;
      createdAt: string;
      progress: string | null;
    }>;
  }

  const fetchConcurrentContext = async (): Promise<ConcurrentContextResponse | undefined> => {
    if (!mcpConfig) return undefined;

    try {
      const resp = await fetch(`${getBaseUrl()}/api/concurrent-context`, {
        method: "GET",
        headers: mcpConfig.headers,
      });
      if (!resp.ok) return undefined;
      return (await resp.json()) as ConcurrentContextResponse;
    } catch {
      return undefined;
    }
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
        body: JSON.stringify({ claudeMd: content, changeSource: "session_sync" }),
      });
    } catch {
      // Silently fail - don't block shutdown
    }
  };

  /**
   * Sync SOUL.md and IDENTITY.md content back to the server
   */
  const syncIdentityFilesToServer = async (
    agentId: string,
    changeSource: "self_edit" | "session_sync" = "session_sync",
  ): Promise<void> => {
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

    const toolsMdFile = Bun.file(TOOLS_MD_PATH);
    if (await toolsMdFile.exists()) {
      const content = await toolsMdFile.text();
      if (content.trim() && content.length <= 65536) {
        updates.toolsMd = content;
      }
    }

    if (Object.keys(updates).length === 0) return;

    try {
      await fetch(`${getBaseUrl()}/api/agents/${agentId}/profile`, {
        method: "PUT",
        headers: {
          ...mcpConfig.headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...updates, changeSource }),
      });
    } catch {
      // Silently fail
    }
  };

  /**
   * Sync setup script content back to the server.
   * Extracts only agent-managed content between markers to avoid duplicating operator content.
   */
  const syncSetupScriptToServer = async (
    agentId: string,
    changeSource: "self_edit" | "session_sync" = "session_sync",
  ): Promise<void> => {
    if (!mcpConfig) return;

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
        body: JSON.stringify({ setupScript: content, changeSource }),
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

      // For lead agents: inject concurrent session context
      if (agentInfo.isLead) {
        try {
          const concurrentCtx = await fetchConcurrentContext();
          if (concurrentCtx) {
            const lines: string[] = [];

            if (concurrentCtx.processingInboxMessages.length > 0) {
              lines.push("=== CONCURRENT SESSION AWARENESS ===");
              lines.push("");
              lines.push("**Other sessions are currently processing these inbox messages:**");
              for (const msg of concurrentCtx.processingInboxMessages) {
                const preview =
                  msg.content.length > 120 ? `${msg.content.slice(0, 120)}...` : msg.content;
                lines.push(`- [${msg.source}] "${preview}" (received ${msg.createdAt})`);
              }
            }

            if (concurrentCtx.recentTaskDelegations.length > 0) {
              if (lines.length === 0) lines.push("=== CONCURRENT SESSION AWARENESS ===");
              lines.push("");
              lines.push("**Recent task delegations (last 5 min):**");
              for (const task of concurrentCtx.recentTaskDelegations) {
                const preview =
                  task.task.length > 120 ? `${task.task.slice(0, 120)}...` : task.task;
                lines.push(`- "${preview}" → ${task.agentName ?? "unassigned"} [${task.status}]`);
              }
            }

            if (concurrentCtx.activeSwarmTasks.length > 0) {
              if (lines.length === 0) lines.push("=== CONCURRENT SESSION AWARENESS ===");
              lines.push("");
              lines.push("**Currently active tasks across the swarm:**");
              for (const task of concurrentCtx.activeSwarmTasks) {
                const preview =
                  task.task.length > 100 ? `${task.task.slice(0, 100)}...` : task.task;
                lines.push(`- ${task.agentName ?? "unassigned"}: "${preview}" [${task.status}]`);
              }
            }

            if (lines.length > 0) {
              lines.push("");
              lines.push(
                "IMPORTANT: Avoid duplicating work that is already being handled by other sessions or agents.",
              );
              lines.push("=== END CONCURRENT SESSION AWARENESS ===");
              console.log(lines.join("\n"));
            }
          }
        } catch {
          // Don't block session start if concurrent context fetch fails
        }
      }

      // Clear stale tool loop history for this session
      {
        const startTaskFile = await readTaskFile();
        if (startTaskFile?.taskId) {
          await clearToolHistory(startTaskFile.taskId);
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

      // Tool loop detection (workers only, when processing a task)
      if (agentInfo && !agentInfo.isLead && agentInfo.status === "busy") {
        const loopTaskFile = await readTaskFile();
        if (loopTaskFile?.taskId && msg.tool_name && msg.tool_input) {
          const loopResult = await checkToolLoop(
            loopTaskFile.taskId,
            msg.tool_name,
            msg.tool_input as Record<string, unknown>,
          );

          if (loopResult.blocked) {
            outputBlockResponse(
              `LOOP DETECTED: ${loopResult.reason} ` +
                "Stop repeating this action and try a fundamentally different approach. " +
                "If you're truly stuck, use store-progress to report the blocker.",
            );
            return;
          }

          if (loopResult.severity === "warning" && loopResult.reason) {
            console.log(`Warning: ${loopResult.reason}`);
          }
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
      // Active session heartbeat (workers only, fire-and-forget)
      if (agentInfo && !agentInfo.isLead) {
        const heartbeatTaskFile = await readTaskFile();
        if (heartbeatTaskFile?.taskId) {
          void fetch(`${getBaseUrl()}/api/active-sessions/heartbeat/${heartbeatTaskFile.taskId}`, {
            method: "PUT",
            headers: mcpConfig!.headers,
          }).catch(() => {});
        }
      }

      if (agentInfo) {
        // Sync workspace file edits back to DB
        const toolName = msg.tool_name;
        const toolInput = msg.tool_input as { file_path?: string } | undefined;
        const editedPath = toolInput?.file_path;

        if ((toolName === "Write" || toolName === "Edit") && editedPath) {
          try {
            // Identity files: SOUL.md, IDENTITY.md, TOOLS.md
            if (
              editedPath === SOUL_MD_PATH ||
              editedPath === IDENTITY_MD_PATH ||
              editedPath === TOOLS_MD_PATH
            ) {
              await syncIdentityFilesToServer(agentInfo.id, "self_edit");
            }

            // Setup script: start-up.sh (or start-up.*)
            if (editedPath.startsWith("/workspace/start-up")) {
              await syncSetupScriptToServer(agentInfo.id, "self_edit");
            }
          } catch {
            // Non-blocking — don't interrupt the agent's workflow
          }
        }

        // Auto-index files written to memory directories
        if (
          (toolName === "Write" || toolName === "Edit") &&
          editedPath &&
          (editedPath.startsWith("/workspace/personal/memory/") ||
            editedPath.startsWith("/workspace/shared/memory/"))
        ) {
          try {
            const apiUrl = process.env.MCP_BASE_URL || "http://localhost:3013";
            const apiKey = process.env.API_KEY || "";
            const fileContent = await Bun.file(editedPath).text();
            const isShared = editedPath.startsWith("/workspace/shared/");
            const fileName = editedPath.split("/").pop() ?? "unnamed";

            await fetch(`${apiUrl}/api/memory/index`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                "X-Agent-ID": agentInfo.id,
              },
              body: JSON.stringify({
                agentId: agentInfo.id,
                content: fileContent,
                name: fileName.replace(/\.\w+$/, ""),
                scope: isShared ? "swarm" : "agent",
                source: "file_index",
                sourcePath: editedPath,
              }),
            });
          } catch {
            // Non-blocking — don't interrupt the agent's workflow
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

      // Session summarization via Claude Haiku
      // Skip if this is a child session spawned by the summarization itself (prevents recursion)
      if (agentInfo?.id && msg.transcript_path && !process.env.SKIP_SESSION_SUMMARY) {
        try {
          let transcript = "";
          try {
            const fullTranscript = await Bun.file(msg.transcript_path).text();
            transcript =
              fullTranscript.length > 20000 ? fullTranscript.slice(-20000) : fullTranscript;
          } catch {
            /* no transcript */
          }

          if (transcript.length > 100) {
            // Read task context if available
            let taskContext = "";
            let taskId: string | undefined;
            const taskFile = process.env.TASK_FILE;
            if (taskFile) {
              try {
                const taskData = JSON.parse(await Bun.file(taskFile).text());
                taskContext = `Task: ${taskData.task || "Unknown"}`;
                taskId = taskData.id;
              } catch {
                /* no task file */
              }
            }

            // Summarize with Claude Haiku — extract only high-value learnings
            const summarizePrompt = `You are summarizing an AI agent's work session. Extract ONLY high-value learnings.

DO NOT include:
- Generic descriptions of what was done ("worked on task X")
- Tool calls or file reads
- Routine progress updates

DO include (if present):
- **Mistakes made and corrections** — what went wrong and what fixed it
- **Discovered patterns** — reusable approaches, APIs, or codebase conventions
- **Codebase knowledge** — important file paths, architecture decisions, gotchas
- **Environment knowledge** — service URLs, config details, tool quirks
- **Failed approaches** — what was tried and didn't work (and why)

Format as a bulleted list of concrete, reusable facts. If the session was routine with no significant learnings, respond with exactly: "No significant learnings."
${taskContext ? `\nTask context: ${taskContext}` : ""}
Transcript:
${transcript}`;

            const tmpFile = `/tmp/session-summary-${Date.now()}.txt`;
            await Bun.write(tmpFile, summarizePrompt);
            const proc = Bun.spawn(
              ["bash", "-c", `cat "${tmpFile}" | claude -p --model haiku --output-format json`],
              {
                stdout: "pipe",
                stderr: "pipe",
                env: { ...process.env, SKIP_SESSION_SUMMARY: "1" },
              },
            );
            const timeoutId = setTimeout(() => proc.kill(), 30000);
            const result = { stdout: await new Response(proc.stdout).text() };
            clearTimeout(timeoutId);
            await Bun.$`rm -f ${tmpFile}`.quiet();

            let summary: string;
            try {
              const summaryOutput = JSON.parse(result.stdout);
              summary = summaryOutput.result ?? result.stdout;
            } catch {
              summary = result.stdout;
            }

            // Skip indexing if the session had no significant learnings
            if (
              summary &&
              summary.length > 20 &&
              !summary.trim().toLowerCase().includes("no significant learnings")
            ) {
              const apiUrl = process.env.MCP_BASE_URL || "http://localhost:3013";
              const apiKey = process.env.API_KEY || "";

              await fetch(`${apiUrl}/api/memory/index`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                  "X-Agent-ID": agentInfo.id,
                },
                body: JSON.stringify({
                  agentId: agentInfo.id,
                  content: summary,
                  name: taskContext
                    ? `Session: ${taskContext.slice(0, 80)}`
                    : `Session: ${new Date().toISOString().slice(0, 16)}`,
                  scope: "agent",
                  source: "session_summary",
                  ...(taskId ? { sourceTaskId: taskId } : {}),
                }),
              });
            }
          }
        } catch {
          // Non-blocking — session summarization failure should never block shutdown
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
