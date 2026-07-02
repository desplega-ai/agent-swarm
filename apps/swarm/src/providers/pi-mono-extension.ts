/**
 * Swarm hooks as a pi-mono extension.
 *
 * Maps agent-swarm hook events (SessionStart, PreToolUse, PostToolUse,
 * PreCompact, UserPromptSubmit, Stop) to pi-mono extension event handlers
 * with full behavioral parity.
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { buildRatingsFromLlm, fetchRetrievalsForTask, postRatings } from "../be/memory/raters/llm";
import { checkToolLoop, clearToolHistory } from "../hooks/tool-loop-detection";
import { summarizeSession as runSummarize } from "../utils/internal-ai";

export interface SwarmHooksConfig {
  apiUrl: string;
  apiKey: string;
  agentId: string;
  taskId: string;
  isLead: boolean;
}

/** Standard headers for swarm API requests */
function apiHeaders(config: SwarmHooksConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    "X-Agent-ID": config.agentId,
  };
}

/** Fire-and-forget fetch — logs nothing, swallows errors */
function fireAndForget(url: string, init: RequestInit): void {
  void fetch(url, init).catch(() => {});
}

/** Check if a task has been cancelled */
async function isTaskCancelled(
  config: SwarmHooksConfig,
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
async function checkShouldBlockPolling(config: SwarmHooksConfig): Promise<boolean> {
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
  config: SwarmHooksConfig,
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
  config: SwarmHooksConfig,
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

/** Sync setup script to server */
async function syncSetupScriptToServer(
  config: SwarmHooksConfig,
  changeSource: "self_edit" | "session_sync" = "session_sync",
): Promise<void> {
  try {
    const file = Bun.file("/workspace/start-up.sh");
    if (!(await file.exists())) return;

    const raw = await file.text();
    if (!raw.trim()) return;

    const markerStart = "# === Agent-managed setup (from DB) ===";
    const markerEnd = "# === End agent-managed setup ===";
    const startIdx = raw.indexOf(markerStart);
    const endIdx = raw.indexOf(markerEnd);

    let content: string;
    if (startIdx !== -1 && endIdx !== -1) {
      content = raw.substring(startIdx + markerStart.length, endIdx).trim();
    } else {
      content = raw.replace(/^#!\/bin\/bash\n/, "").trim();
    }

    if (!content || content.length > 65536) return;

    await fetch(`${config.apiUrl}/api/agents/${config.agentId}/profile`, {
      method: "PUT",
      headers: apiHeaders(config),
      body: JSON.stringify({ setupScript: content, changeSource }),
    });
  } catch {
    /* silently fail */
  }
}

/**
 * Check if a path is under the agent's own subdirectory on the shared disk.
 * Shared disk categories: thoughts, memory, downloads, misc.
 * Each agent can only write to /workspace/shared/{category}/{agentId}/
 */
function isOwnedSharedPath(path: string, agentId: string): boolean {
  const sharedCategories = ["thoughts", "memory", "downloads", "misc"];
  return sharedCategories.some((cat) => path.startsWith(`/workspace/shared/${cat}/${agentId}/`));
}

/**
 * Build the shared disk write warning message for a given agent ID.
 */
function sharedDiskWriteWarning(agentId: string): string {
  return (
    `⚠️ This write will fail: You don't have write access to this directory.\n\n` +
    `On shared workspaces, each agent can only write to their own directories:\n` +
    `- /workspace/shared/thoughts/${agentId}/\n` +
    `- /workspace/shared/memory/${agentId}/\n` +
    `- /workspace/shared/downloads/${agentId}/\n` +
    `- /workspace/shared/misc/${agentId}/\n\n` +
    `You CAN read any file on the shared disk. For writes, use your own subdirectory.`
  );
}

/** Auto-index a file written to memory directory */
async function autoIndexMemoryFile(config: SwarmHooksConfig, editedPath: string): Promise<void> {
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
async function fetchConcurrentContext(config: SwarmHooksConfig): Promise<string | null> {
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

/**
 * Test-injection points for `summarizeSessionForPi`. Production callers omit
 * `deps` entirely — pi-mono-extension's `session_shutdown` handler uses the
 * default implementations bound via `import` at the top of this file.
 *
 * Why this exists: `bun:test`'s `mock.module()` is process-wide and leaks
 * across test files, so the pi-mono-extension test cannot stub out
 * `runSummarize`/`postRatings` via module mocking without breaking siblings
 * that import the real symbols (e.g. `buildRatingsFromLlm` step-6 tests,
 * `summarize-session.test.ts`). Explicit DI is the safer pattern.
 */
export interface SummarizeSessionForPiDeps {
  runSummarize?: typeof runSummarize;
  fetchRetrievalsForTask?: typeof fetchRetrievalsForTask;
  postRatings?: typeof postRatings;
  buildRatingsFromLlm?: typeof buildRatingsFromLlm;
}

/**
 * Run session summarization via the shared `internal-ai` abstraction on
 * shutdown. Replaces the previous `Bun.spawn(claude -p ...)` shellout
 * (which silently failed in production because pi sessions typically don't
 * have Anthropic CLI auth).
 *
 * Flow:
 *   1. Read tail of session transcript file.
 *   2. Fetch task details + (optionally) memory retrievals for ratings.
 *   3. Call `runSummarize` from `src/utils/internal-ai` — picks credentials
 *      out of env / codex OAuth, returns structured `{summary, ratings}`.
 *   4. Apply length/quality gate; POST summary to `/api/memory/index`.
 *   5. If `MEMORY_RATERS` includes `llm` AND ratings came back, POST them
 *      via `postRatings` (events-based; mirrors the claude Stop hook).
 *
 * All catches log via `console.error(..., err)` — silent-fail behavior is
 * gone.
 */
export async function summarizeSessionForPi(
  config: SwarmHooksConfig,
  sessionFile: string | undefined,
  deps: SummarizeSessionForPiDeps = {},
): Promise<void> {
  if (!sessionFile) return;

  const _runSummarize = deps.runSummarize ?? runSummarize;
  const _fetchRetrievals = deps.fetchRetrievalsForTask ?? fetchRetrievalsForTask;
  const _postRatings = deps.postRatings ?? postRatings;
  const _buildRatings = deps.buildRatingsFromLlm ?? buildRatingsFromLlm;

  try {
    let transcript = "";
    try {
      const fullTranscript = await Bun.file(sessionFile).text();
      transcript = fullTranscript.length > 20000 ? fullTranscript.slice(-20000) : fullTranscript;
    } catch {
      return;
    }

    if (transcript.length <= 100) return;

    const sourceTaskId = config.taskId;
    const agentId = config.agentId;
    if (!sourceTaskId || !agentId) return;

    const taskDetails = await fetchTaskDetails(config).catch(() => null);

    const memoryRaters = (process.env.MEMORY_RATERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const wantRatings = memoryRaters.includes("llm");
    const retrievals = wantRatings
      ? await _fetchRetrievals({
          apiUrl: config.apiUrl,
          apiKey: config.apiKey,
          agentId,
          taskId: sourceTaskId,
        }).catch(() => [])
      : [];

    const result = await _runSummarize({
      harness: "pi",
      transcript,
      retrievals,
      taskContext: {
        sourceTaskId,
        agentId,
        prompt: taskDetails?.task,
      },
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
    });
    // null = no auth resolved or wrapper exhausted retries (already logged inside)
    if (!result) return;

    const summary = result.summary.trim();
    if (summary.length <= 20 || summary.toLowerCase().includes("no significant learnings")) {
      return;
    }

    const indexResp = await fetch(`${config.apiUrl}/api/memory/index`, {
      method: "POST",
      headers: apiHeaders(config),
      body: JSON.stringify({
        scope: "agent",
        source: "session_summary",
        sourceTaskId,
        content: summary,
        name: "session-summary",
        agentId,
      }),
    });
    if (!indexResp.ok) {
      const text = await indexResp.text().catch(() => "");
      console.error("session_summary: /api/memory/index POST failed (pi):", indexResp.status, text);
      return;
    }

    if (wantRatings && result.ratings && result.ratings.length > 0) {
      const ratingEvents = _buildRatings(result.ratings, retrievals);
      if (ratingEvents.length > 0) {
        await _postRatings({
          apiUrl: config.apiUrl,
          apiKey: config.apiKey,
          agentId,
          taskId: sourceTaskId,
          events: ratingEvents,
        }).catch((err) => console.error("session_summary: postRatings failed (pi):", err));
      }
    }
  } catch (err) {
    console.error("session_summary failed (pi):", err);
  }
}

/**
 * Create the swarm hooks extension factory for pi-mono.
 *
 * This maps all agent-swarm hook behaviors to pi-mono extension events
 * with full behavioral parity to src/hooks/hook.ts.
 */
export function createSwarmHooksExtension(config: SwarmHooksConfig): ExtensionFactory {
  return (pi) => {
    let lastContextPostTime = 0;

    // === session_start → SessionStart ===
    pi.on("session_start", async (_event, _ctx) => {
      // Ping server
      fireAndForget(`${config.apiUrl}/ping`, {
        method: "POST",
        headers: apiHeaders(config),
      });

      // Clear stale tool loop history
      if (config.taskId) {
        await clearToolHistory(config.taskId);
      }

      // Lead agents: inject concurrent context
      if (config.isLead) {
        const ctx = await fetchConcurrentContext(config);
        if (ctx) {
          console.log(ctx);
        }
      }
    });

    // === tool_call → PreToolUse ===
    pi.on("tool_call", async (event, _ctx) => {
      // Workers only: check task cancellation
      if (!config.isLead && config.taskId) {
        const { cancelled, reason } = await isTaskCancelled(config);
        if (cancelled) {
          const cancelReason = reason || "Task cancelled by lead or creator";
          return {
            block: true,
            reason:
              `🛑 TASK CANCELLED: Your current task (${config.taskId.slice(0, 8)}) has been cancelled. Reason: "${cancelReason}". ` +
              `Stop working on this task immediately. Do NOT continue making tool calls. ` +
              `Use store-progress to acknowledge the cancellation and mark the task as failed, then wait for new tasks.`,
          };
        }
      }

      // Workers only: tool loop detection
      if (!config.isLead && config.taskId) {
        const toolName = event.toolName;
        const toolInput = "input" in event ? (event.input as Record<string, unknown>) : {};

        const loopResult = await checkToolLoop(config.taskId, toolName, toolInput);

        if (loopResult.blocked) {
          return {
            block: true,
            reason:
              `LOOP DETECTED: ${loopResult.reason} ` +
              "Stop repeating this action and try a fundamentally different approach. " +
              "If you're truly stuck, use store-progress to report the blocker.",
          };
        }

        if (loopResult.severity === "warning" && loopResult.reason) {
          console.log(`Warning: ${loopResult.reason}`);
        }
      }

      // Block poll-task when polling limit reached
      if (event.toolName?.endsWith("poll-task")) {
        const shouldBlock = await checkShouldBlockPolling(config);
        if (shouldBlock) {
          return {
            block: true,
            reason:
              "🛑 POLLING LIMIT REACHED: You have exceeded the maximum empty poll attempts. " +
              "EXIT NOW - do not make any more tool calls.",
          };
        }
      }

      // Shared disk write prevention (Archil only — skip in local dev)
      if (process.env.ARCHIL_MOUNT_TOKEN) {
        // Pi-mono uses lowercase tool names: "write", "edit"
        if (event.toolName === "write" || event.toolName === "edit") {
          const toolInput =
            "input" in event
              ? (event.input as { file_path?: string; path?: string } | undefined)
              : undefined;
          const targetPath = toolInput?.file_path || toolInput?.path || "";
          if (
            targetPath.startsWith("/workspace/shared/") &&
            !isOwnedSharedPath(targetPath, config.agentId)
          ) {
            console.log(sharedDiskWriteWarning(config.agentId));
          }
        }
      }

      return undefined;
    });

    // === tool_result → PostToolUse ===
    pi.on("tool_result", async (event, ctx) => {
      // Heartbeat (workers only, fire-and-forget)
      if (!config.isLead && config.taskId) {
        fireAndForget(`${config.apiUrl}/api/active-sessions/heartbeat/${config.taskId}`, {
          method: "PUT",
          headers: apiHeaders(config),
        });
      }

      // Activity timestamp (fire-and-forget)
      fireAndForget(`${config.apiUrl}/api/agents/${config.agentId}/activity`, {
        method: "PUT",
        headers: apiHeaders(config),
      });

      // Throttled context usage reporting (every 30s)
      const usage = ctx.getContextUsage?.();
      if (config.taskId && usage?.tokens != null) {
        const now = Date.now();
        if (now - lastContextPostTime >= 30_000) {
          lastContextPostTime = now;
          fireAndForget(`${config.apiUrl}/api/tasks/${config.taskId}/context`, {
            method: "POST",
            headers: apiHeaders(config),
            body: JSON.stringify({
              eventType: "progress",
              sessionId: `pi-${config.taskId}`,
              contextUsedTokens: usage.tokens,
              contextTotalTokens: usage.contextWindow,
              contextPercent: usage.percent,
            }),
          });
        }
      }

      // Shared disk write failure detection (Archil only — safety net)
      if (process.env.ARCHIL_MOUNT_TOKEN) {
        // Pi-mono uses lowercase tool names
        if (event.toolName === "write" || event.toolName === "edit" || event.toolName === "bash") {
          const resultStr = JSON.stringify(event.content ?? []);
          if (resultStr.includes("Read-only file system")) {
            const resultInput = event.input as { file_path?: string; path?: string } | undefined;
            const resultPath = resultInput?.file_path || resultInput?.path || "";
            if (
              resultPath.startsWith("/workspace/shared/") &&
              !isOwnedSharedPath(resultPath, config.agentId)
            ) {
              console.log(sharedDiskWriteWarning(config.agentId));
            } else if (!resultPath) {
              // Bash tool — no file_path, just warn generically
              console.log(sharedDiskWriteWarning(config.agentId));
            }
          }
        }
      }

      // File sync: check if tool wrote to identity files or memory dirs
      // Pi-mono uses tool names: "write", "edit" (lowercase, unlike Claude's "Write", "Edit")
      const toolName = event.toolName;
      const input = event.input as { file_path?: string; path?: string } | undefined;
      const editedPath = input?.file_path || input?.path;

      if ((toolName === "write" || toolName === "edit") && editedPath) {
        // Identity files
        if (
          editedPath === "/workspace/SOUL.md" ||
          editedPath === "/workspace/IDENTITY.md" ||
          editedPath === "/workspace/TOOLS.md"
        ) {
          void syncIdentityFilesToServer(config, "self_edit");
        }

        // Setup script
        if (editedPath.startsWith("/workspace/start-up")) {
          void syncSetupScriptToServer(config, "self_edit");
        }

        // Memory auto-index
        if (
          editedPath.startsWith("/workspace/personal/memory/") ||
          editedPath.startsWith("/workspace/shared/memory/")
        ) {
          void autoIndexMemoryFile(config, editedPath);
        }
      }

      // Reminders
      if (config.isLead && event.toolName?.endsWith("send-task")) {
        console.log(
          "Task sent successfully. Monitor progress using the get-task-details tool periodically.",
        );
      }

      return undefined;
    });

    // === context → PreCompact ===
    // The context event allows injecting messages before compaction.
    // We log the goal reminder to console (it gets captured in context).
    pi.on("context", async (_event, ctx) => {
      if (!config.taskId) return undefined;

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
          console.log(reminder.join("\n"));
        }
      } catch {
        /* don't block compaction */
      }

      // Report context usage as a compaction event
      const usage = ctx.getContextUsage?.();
      if (usage) {
        fireAndForget(`${config.apiUrl}/api/tasks/${config.taskId}/context`, {
          method: "POST",
          headers: apiHeaders(config),
          body: JSON.stringify({
            eventType: "compaction",
            sessionId: `pi-${config.taskId}`,
            contextUsedTokens: usage.tokens ?? undefined,
            contextTotalTokens: usage.contextWindow,
            contextPercent: usage.percent ?? undefined,
          }),
        });
      }

      return undefined;
    });

    // === input → UserPromptSubmit ===
    pi.on("input", async (_event, _ctx) => {
      // Workers only: check task cancellation at start of new iteration
      if (!config.isLead && config.taskId) {
        const { cancelled, reason } = await isTaskCancelled(config);
        if (cancelled) {
          const cancelReason = reason || "Task cancelled by lead or creator";
          console.log(
            `🛑 TASK CANCELLED: ${cancelReason}. Stop working and use store-progress to acknowledge.`,
          );
          return { action: "handled" as const };
        }
      }
      return undefined;
    });

    // === session_shutdown → Stop ===
    pi.on("session_shutdown", async (_event, ctx) => {
      // Post final context usage before shutdown
      const usage = ctx.getContextUsage?.();
      if (config.taskId && usage) {
        await fetch(`${config.apiUrl}/api/tasks/${config.taskId}/context`, {
          method: "POST",
          headers: apiHeaders(config),
          body: JSON.stringify({
            eventType: "completion",
            sessionId: `pi-${config.taskId}`,
            contextTotalTokens: usage.contextWindow,
            contextPercent: usage.percent ?? undefined,
            contextUsedTokens: usage.tokens ?? undefined,
          }),
        }).catch(() => {});
      }

      // Sync identity files and setup script
      await syncIdentityFilesToServer(config);
      await syncSetupScriptToServer(config);

      // Session summarization — get session file from context's session manager
      const sessionFile = ctx.sessionManager.getSessionFile?.();
      if (!process.env.SKIP_SESSION_SUMMARY) {
        await summarizeSessionForPi(config, sessionFile);
      }

      // Mark agent offline
      fireAndForget(`${config.apiUrl}/close`, {
        method: "POST",
        headers: apiHeaders(config),
      });
    });
  };
}
