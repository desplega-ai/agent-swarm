import { getTrackerSync, updateTrackerSync } from "../be/db-queries/tracker";
import { ensureToken } from "../oauth/ensure-token";
import { scrubSecrets } from "../utils/secret-scrubber";
import { workflowEventBus } from "../workflows/event-bus";
import { getLinearClient, resetLinearClient } from "./client";
import { endAgentSession, postAgentSessionAction, taskSessionMap } from "./sync";

let subscribed = false;

const LOOP_PREVENTION_WINDOW_MS = 5_000;

/**
 * `EventEmitter.emit()` calls listeners synchronously and discards whatever
 * they return, so a rejected async handler is never seen by the emitting side
 * — it escapes to the process-level `unhandledRejection` handler with no
 * subsystem context. These wrappers observe the *complete* handler body,
 * including work that runs before any internal `try` (e.g. `getTrackerSync`)
 * and the `updateTrackerSync` write that runs after it.
 *
 * Each wrapper is created once at module scope so `off()` is passed the exact
 * reference `on()` registered; building them inside `init` would leave the
 * listeners attached after teardown.
 */
function observed(
  eventName: string,
  handler: (data: unknown) => Promise<void>,
): (data: unknown) => void {
  return (data: unknown): void => {
    handler(data).catch((error) => {
      console.error(
        `[Linear Outbound] ${eventName} handler failed:`,
        scrubSecrets(error instanceof Error ? error.message : String(error)),
      );
    });
  };
}

const onTaskCreated = observed("task.created", handleTaskCreated);
const onTaskCompleted = observed("task.completed", handleTaskCompleted);
const onTaskFailed = observed("task.failed", handleTaskFailed);
const onTaskCancelled = observed("task.cancelled", handleTaskCancelled);
const onTaskProgress = observed("task.progress", handleTaskProgress);

export function initLinearOutboundSync(): void {
  if (subscribed) return;
  subscribed = true;

  workflowEventBus.on("task.created", onTaskCreated);
  workflowEventBus.on("task.completed", onTaskCompleted);
  workflowEventBus.on("task.failed", onTaskFailed);
  workflowEventBus.on("task.cancelled", onTaskCancelled);
  workflowEventBus.on("task.progress", onTaskProgress);
  console.log("[Linear] Outbound sync subscribed to event bus");
}

export function teardownLinearOutboundSync(): void {
  if (!subscribed) return;
  subscribed = false;

  workflowEventBus.off("task.created", onTaskCreated);
  workflowEventBus.off("task.completed", onTaskCompleted);
  workflowEventBus.off("task.failed", onTaskFailed);
  workflowEventBus.off("task.cancelled", onTaskCancelled);
  workflowEventBus.off("task.progress", onTaskProgress);
  console.log("[Linear] Outbound sync unsubscribed from event bus");
}

async function handleTaskCreated(data: unknown): Promise<void> {
  const { taskId, source } = data as { taskId: string; source?: string };
  if (!taskId) return;

  // Only post action activities for Linear-sourced tasks that have an AgentSession
  if (source !== "linear") return;

  const sessionId = taskSessionMap.get(taskId);
  if (!sessionId) return;

  postAgentSessionAction(sessionId, "Processing", `Task ${taskId} assigned to agent`).catch(
    (err) => {
      console.error(`[Linear Outbound] Failed to post action activity for task ${taskId}:`, err);
    },
  );
}

// Cap parameter length to avoid oversized Linear GraphQL payloads. Linear renders this in the
// AgentSession panel; 2000 chars is plenty for a progress update.
const PROGRESS_PARAMETER_MAX = 2000;

async function handleTaskProgress(data: unknown): Promise<void> {
  const { taskId, progress } = data as { taskId: string; progress?: string };
  if (!taskId || !progress) return;

  const sessionId = taskSessionMap.get(taskId);
  if (!sessionId) return;

  // Post as `action` activity (renders as a structured card in Linear's AgentSession panel).
  // Per Linear's agentActivityCreate spec, `action` requires BOTH `action` AND `parameter`;
  // the original bug here was passing `progress` as `action` with `parameter` undefined.
  const parameter = progress.slice(0, PROGRESS_PARAMETER_MAX);
  postAgentSessionAction(sessionId, "Progress update", parameter).catch((err) => {
    console.error(`[Linear Outbound] Failed to post progress action for task ${taskId}:`, err);
  });
}

// Linear documents no size limit for a comment or an AgentActivity body. 30k chars stays under
// the 32,767 figure other Linear integrations use, and fits any realistic task output.
export const LINEAR_BODY_MAX = 30_000;

/**
 * Build the body of the single Linear comment that carries a task's outcome.
 *
 * The text goes in as-is: no `+++ Title … +++` wrapper (Linear renders that as a
 * collapsed section) and no boilerplate. A body over `LINEAR_BODY_MAX` is cut and ends
 * with a visible note that points at the swarm task for the full text.
 */
export function formatLinearOutcomeBody(text: string, taskId: string): string {
  if (text.length <= LINEAR_BODY_MAX) return text;

  const dashboardUrl = (process.env.SWARM_DASHBOARD_URL || process.env.APP_URL)?.replace(
    /\/+$/,
    "",
  );
  const where = dashboardUrl ? `${dashboardUrl}/tasks/${taskId}` : `swarm task \`${taskId}\``;
  const note = (shown: number) =>
    `\n\n---\n_Truncated: showing ${shown} of ${text.length} characters. Full text: ${where}_`;
  const shown = LINEAR_BODY_MAX - note(LINEAR_BODY_MAX).length;
  return `${text.slice(0, shown).trimEnd()}${note(shown)}`;
}

async function handleTaskCompleted(data: unknown): Promise<void> {
  const { taskId, output } = data as { taskId: string; output?: string };
  if (!taskId) return;

  const sync = await getTrackerSync("linear", "task", taskId);
  if (!sync) return;

  if (shouldSkipForLoopPrevention(sync)) return;

  const sessionId = taskSessionMap.get(taskId);
  const body = output?.trim() ? formatLinearOutcomeBody(output, taskId) : "Task completed.";

  // One comment only. A `response` activity ends the AgentSession and Linear renders it as a
  // comment on the issue, so it carries the output itself. The plain comment below runs only
  // when there is no session to end.
  if (sessionId) {
    endAgentSession(sessionId, body, "response").catch((err) => {
      console.error(`[Linear Outbound] Failed to end AgentSession for task ${taskId}:`, err);
    });
    taskSessionMap.delete(taskId);
    console.log(`[Linear Outbound] Posted completion response to AgentSession for task ${taskId}`);
  } else {
    // No session — fall back to issue comment
    try {
      await ensureToken("linear");
      resetLinearClient(); // Clear cached client so it picks up refreshed token
      const client = await getLinearClient();
      if (!client) {
        console.log("[Linear Outbound] No Linear client available, skipping sync for", taskId);
        return;
      }
      await client.createComment({ issueId: sync.externalId, body });
      console.log(`[Linear Outbound] Posted completion comment for task ${taskId}`);
    } catch (error) {
      console.error(
        `[Linear Outbound] Failed to sync task completion for ${taskId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  await updateTrackerSync(sync.id, {
    lastSyncOrigin: "swarm",
    lastSyncedAt: new Date().toISOString(),
  });
}

async function handleTaskFailed(data: unknown): Promise<void> {
  const { taskId, failureReason } = data as { taskId: string; failureReason?: string };
  if (!taskId) return;

  const sync = await getTrackerSync("linear", "task", taskId);
  if (!sync) return;

  if (shouldSkipForLoopPrevention(sync)) return;

  const sessionId = taskSessionMap.get(taskId);
  // Keep the one-line "Task failed." lead: without it a plain fallback comment reads like
  // a normal answer.
  const body = failureReason?.trim()
    ? formatLinearOutcomeBody(`Task failed.\n\n${failureReason}`, taskId)
    : "Task failed.";

  // One comment only: the `error` activity ends the AgentSession and carries the reason.
  // The plain comment below runs only when there is no session to end.
  if (sessionId) {
    endAgentSession(sessionId, body, "error").catch((err) => {
      console.error(`[Linear Outbound] Failed to end AgentSession for task ${taskId}:`, err);
    });
    taskSessionMap.delete(taskId);
    console.log(`[Linear Outbound] Posted failure error to AgentSession for task ${taskId}`);
  } else {
    // No session — fall back to issue comment
    try {
      await ensureToken("linear");
      resetLinearClient(); // Clear cached client so it picks up refreshed token
      const client = await getLinearClient();
      if (!client) {
        console.log("[Linear Outbound] No Linear client available, skipping sync for", taskId);
        return;
      }
      await client.createComment({ issueId: sync.externalId, body });
      console.log(`[Linear Outbound] Posted failure comment for task ${taskId}`);
    } catch (error) {
      console.error(
        `[Linear Outbound] Failed to sync task failure for ${taskId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  await updateTrackerSync(sync.id, {
    lastSyncOrigin: "swarm",
    lastSyncedAt: new Date().toISOString(),
  });
}

async function handleTaskCancelled(data: unknown): Promise<void> {
  const { taskId } = data as { taskId: string };
  if (!taskId) return;

  const sync = await getTrackerSync("linear", "task", taskId);
  if (!sync) return;

  if (shouldSkipForLoopPrevention(sync)) return;

  const sessionId = taskSessionMap.get(taskId);
  const body = "Task cancelled.";

  if (sessionId) {
    endAgentSession(sessionId, body, "error").catch((err) => {
      console.error(
        `[Linear Outbound] Failed to end AgentSession for cancelled task ${taskId}:`,
        err,
      );
    });
    taskSessionMap.delete(taskId);
    console.log(`[Linear Outbound] Posted cancellation to AgentSession for task ${taskId}`);
  } else {
    try {
      await ensureToken("linear");
      resetLinearClient(); // Clear cached client so it picks up refreshed token
      const client = await getLinearClient();
      if (!client) {
        console.log("[Linear Outbound] No Linear client available, skipping sync for", taskId);
        return;
      }
      await client.createComment({ issueId: sync.externalId, body: "Task cancelled by swarm." });
      console.log(`[Linear Outbound] Posted cancellation comment for task ${taskId}`);
    } catch (error) {
      console.error(
        `[Linear Outbound] Failed to sync task cancellation for ${taskId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  await updateTrackerSync(sync.id, {
    lastSyncOrigin: "swarm",
    lastSyncedAt: new Date().toISOString(),
  });
}

function shouldSkipForLoopPrevention(sync: {
  lastSyncOrigin: string | null;
  lastSyncedAt: string;
}): boolean {
  if (sync.lastSyncOrigin !== "external") return false;
  const lastSyncTime = new Date(sync.lastSyncedAt).getTime();
  if (Number.isNaN(lastSyncTime)) return false;
  return Date.now() - lastSyncTime < LOOP_PREVENTION_WINDOW_MS;
}
