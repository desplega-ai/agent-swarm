import { getTrackerSync, updateTrackerSync } from "../be/db-queries/tracker";
import { workflowEventBus } from "../workflows/event-bus";
import { getLinearClient } from "./client";
import { endAgentSession, taskSessionMap } from "./sync";

let subscribed = false;

const LOOP_PREVENTION_WINDOW_MS = 5_000;

export function initLinearOutboundSync(): void {
  if (subscribed) return;
  subscribed = true;

  workflowEventBus.on("task.completed", handleTaskCompleted);
  workflowEventBus.on("task.failed", handleTaskFailed);
  console.log("[Linear] Outbound sync subscribed to event bus");
}

export function teardownLinearOutboundSync(): void {
  if (!subscribed) return;
  subscribed = false;

  workflowEventBus.off("task.completed", handleTaskCompleted);
  workflowEventBus.off("task.failed", handleTaskFailed);
  console.log("[Linear] Outbound sync unsubscribed from event bus");
}

async function handleTaskCompleted(data: unknown): Promise<void> {
  const { taskId, output } = data as { taskId: string; output?: string };
  if (!taskId) return;

  const sync = getTrackerSync("linear", "task", taskId);
  if (!sync) return;

  if (shouldSkipForLoopPrevention(sync)) return;

  try {
    const client = getLinearClient();
    if (!client) {
      console.log("[Linear Outbound] No Linear client available, skipping sync for", taskId);
      return;
    }

    const comment = output
      ? `Task completed by swarm agent.\n\nOutput:\n${output.slice(0, 2000)}`
      : "Task completed by swarm agent.";

    await client.createComment({ issueId: sync.externalId, body: comment });

    updateTrackerSync(sync.id, {
      lastSyncOrigin: "swarm",
      lastSyncedAt: new Date().toISOString(),
    });

    console.log(`[Linear Outbound] Posted completion comment for task ${taskId}`);
  } catch (error) {
    console.error(
      `[Linear Outbound] Failed to sync task completion for ${taskId}:`,
      error instanceof Error ? error.message : error,
    );
  }

  // Post to AgentSession if one exists for this task
  const sessionId = taskSessionMap.get(taskId);
  if (sessionId) {
    const body = output ? `Task completed.\n\n${output.slice(0, 2000)}` : "Task completed.";
    endAgentSession(sessionId, body, "response").catch((err) => {
      console.error(`[Linear Outbound] Failed to end AgentSession for task ${taskId}:`, err);
    });
    taskSessionMap.delete(taskId);
  }
}

async function handleTaskFailed(data: unknown): Promise<void> {
  const { taskId, failureReason } = data as { taskId: string; failureReason?: string };
  if (!taskId) return;

  const sync = getTrackerSync("linear", "task", taskId);
  if (!sync) return;

  if (shouldSkipForLoopPrevention(sync)) return;

  try {
    const client = getLinearClient();
    if (!client) {
      console.log("[Linear Outbound] No Linear client available, skipping sync for", taskId);
      return;
    }

    const comment = failureReason
      ? `Task failed.\n\nReason:\n${failureReason.slice(0, 2000)}`
      : "Task failed.";

    await client.createComment({ issueId: sync.externalId, body: comment });

    updateTrackerSync(sync.id, {
      lastSyncOrigin: "swarm",
      lastSyncedAt: new Date().toISOString(),
    });

    console.log(`[Linear Outbound] Posted failure comment for task ${taskId}`);
  } catch (error) {
    console.error(
      `[Linear Outbound] Failed to sync task failure for ${taskId}:`,
      error instanceof Error ? error.message : error,
    );
  }

  // Post error to AgentSession if one exists for this task
  const sessionId = taskSessionMap.get(taskId);
  if (sessionId) {
    const body = failureReason ? `Task failed.\n\n${failureReason.slice(0, 2000)}` : "Task failed.";
    endAgentSession(sessionId, body, "error").catch((err) => {
      console.error(`[Linear Outbound] Failed to end AgentSession for task ${taskId}:`, err);
    });
    taskSessionMap.delete(taskId);
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
