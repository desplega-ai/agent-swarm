import { getTrackerSync, updateTrackerSync } from "../be/db-queries/tracker";
import { workflowEventBus } from "../workflows/event-bus";
import { jiraFetch } from "./client";

let subscribed = false;

const LOOP_PREVENTION_WINDOW_MS = 5_000;
const OUTPUT_TRUNCATE_CHARS = 4000;

/**
 * Subscribe Jira outbound sync to swarm task lifecycle events.
 *
 * For each event, looks up the `tracker_sync` row keyed on
 * `(provider="jira", entityType="task", swarmId=<taskId>)`. If the task
 * originated from a Jira issue, posts a plaintext comment via REST v2 to that
 * issue, then flips `lastSyncOrigin → "swarm"` so the inbound webhook can
 * skip the just-posted comment.
 *
 * Tasks WITHOUT a `tracker_sync` row (most swarm tasks) are silently ignored —
 * the sync row's existence is the gate for "this task came from Jira and should
 * post lifecycle updates back".
 *
 * Idempotent — calling twice is a no-op.
 *
 * Rate-limiting (v1): we rely on `jiraFetch`'s built-in 429 retry-with-
 * `Retry-After` (single retry). If 100+ tasks complete simultaneously across
 * many issues we may exhaust the retry budget and lose comments. Documented
 * as a known v1 limitation; a per-issue debounce / bounded outbound queue
 * could be added in v2 if it becomes a real problem.
 */
export function initJiraOutboundSync(): void {
  if (subscribed) return;
  subscribed = true;

  workflowEventBus.on("task.created", handleTaskCreated);
  workflowEventBus.on("task.completed", handleTaskCompleted);
  workflowEventBus.on("task.failed", handleTaskFailed);
  workflowEventBus.on("task.cancelled", handleTaskCancelled);
  console.log("[Jira] Outbound sync subscribed to event bus");
}

export function teardownJiraOutboundSync(): void {
  if (!subscribed) return;
  subscribed = false;

  workflowEventBus.off("task.created", handleTaskCreated);
  workflowEventBus.off("task.completed", handleTaskCompleted);
  workflowEventBus.off("task.failed", handleTaskFailed);
  workflowEventBus.off("task.cancelled", handleTaskCancelled);
  console.log("[Jira] Outbound sync unsubscribed from event bus");
}

async function handleTaskCreated(data: unknown): Promise<void> {
  const { taskId, task } = data as { taskId?: string; task?: string };
  if (!taskId) return;

  const summary = (task ?? "").trim();
  // Use Unicode emoji directly — Jira REST v2 plaintext bodies do NOT expand
  // shortcode forms like `:rocket:` (verified in Phase 3 manual testing).
  const body = summary ? `🚀 Swarm task started: ${summary}` : "🚀 Swarm task started.";

  await postLifecycleComment(taskId, "task.created", body);
}

async function handleTaskCompleted(data: unknown): Promise<void> {
  const { taskId, output } = data as { taskId?: string; output?: string };
  if (!taskId) return;

  const trimmed = (output ?? "").slice(0, OUTPUT_TRUNCATE_CHARS);
  const ellipsized = output && output.length > OUTPUT_TRUNCATE_CHARS ? `${trimmed}…` : trimmed;
  const body = ellipsized
    ? `✅ Swarm task completed.\n\n${ellipsized}`
    : "✅ Swarm task completed.";

  await postLifecycleComment(taskId, "task.completed", body);
}

async function handleTaskFailed(data: unknown): Promise<void> {
  const { taskId, failureReason } = data as {
    taskId?: string;
    failureReason?: string;
  };
  if (!taskId) return;

  const reason = failureReason ?? "(no failure reason recorded)";
  const body = `❌ Swarm task failed.\n\n${reason}`;

  await postLifecycleComment(taskId, "task.failed", body);
}

async function handleTaskCancelled(data: unknown): Promise<void> {
  const { taskId } = data as { taskId?: string };
  if (!taskId) return;

  await postLifecycleComment(taskId, "task.cancelled", "⛔ Swarm task cancelled.");
}

async function postLifecycleComment(
  taskId: string,
  eventName: string,
  body: string,
): Promise<void> {
  const sync = getTrackerSync("jira", "task", taskId);
  if (!sync) return;

  if (shouldSkipForLoopPrevention(sync)) {
    console.log(
      `[Jira Outbound] Skipping ${eventName} for task ${taskId} — recent external sync (loop prevention)`,
    );
    return;
  }

  // Prefer the readable key (e.g. "KAN-1") over the numeric issue id; both
  // work with the REST v2 comment endpoint, but the key is what users see in
  // logs.
  const issueRef = sync.externalIdentifier ?? sync.externalId;

  try {
    const response = await jiraFetch(`/rest/api/2/issue/${issueRef}/comment`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "<unreadable body>");
      console.error(
        `[Jira Outbound] Failed to post ${eventName} comment for task ${taskId} → ${issueRef}: HTTP ${response.status} ${text}`,
      );
      // Don't update tracker_sync on failure — leave the prior origin/timestamp
      // intact so a subsequent event isn't loop-suppressed by a partial write.
      return;
    }

    updateTrackerSync(sync.id, {
      lastSyncOrigin: "swarm",
      lastSyncedAt: new Date().toISOString(),
    });
    console.log(`[Jira Outbound] Posted ${eventName} comment for task ${taskId} → ${issueRef}`);
  } catch (error) {
    console.error(
      `[Jira Outbound] Error posting ${eventName} comment for task ${taskId} → ${issueRef}:`,
      error instanceof Error ? error.message : error,
    );
  }
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
