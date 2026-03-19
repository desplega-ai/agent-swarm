import { getTrackerSync, updateTrackerSync } from "../be/db-queries/tracker";
import { workflowEventBus } from "../workflows/event-bus";
import { getLinearClient } from "./client";
import {
  endAgentSession,
  postAgentSessionAction,
  postAgentSessionThought,
  taskSessionMap,
} from "./sync";

let subscribed = false;

const LOOP_PREVENTION_WINDOW_MS = 5_000;

export function initLinearOutboundSync(): void {
  if (subscribed) return;
  subscribed = true;

  workflowEventBus.on("task.created", handleTaskCreated);
  workflowEventBus.on("task.completed", handleTaskCompleted);
  workflowEventBus.on("task.failed", handleTaskFailed);
  workflowEventBus.on("task.cancelled", handleTaskCancelled);
  workflowEventBus.on("task.progress", handleTaskProgress);
  console.log("[Linear] Outbound sync subscribed to event bus");
}

export function teardownLinearOutboundSync(): void {
  if (!subscribed) return;
  subscribed = false;

  workflowEventBus.off("task.created", handleTaskCreated);
  workflowEventBus.off("task.completed", handleTaskCompleted);
  workflowEventBus.off("task.failed", handleTaskFailed);
  workflowEventBus.off("task.cancelled", handleTaskCancelled);
  workflowEventBus.off("task.progress", handleTaskProgress);
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

async function handleTaskProgress(data: unknown): Promise<void> {
  const { taskId, progress } = data as { taskId: string; progress?: string };
  if (!taskId || !progress) return;

  const sessionId = taskSessionMap.get(taskId);
  if (!sessionId) return;

  postAgentSessionThought(sessionId, progress).catch((err) => {
    console.error(`[Linear Outbound] Failed to post progress thought for task ${taskId}:`, err);
  });
}

async function handleTaskCompleted(data: unknown): Promise<void> {
  const { taskId, output } = data as { taskId: string; output?: string };
  if (!taskId) return;

  const sync = getTrackerSync("linear", "task", taskId);
  if (!sync) return;

  if (shouldSkipForLoopPrevention(sync)) return;

  const sessionId = taskSessionMap.get(taskId);
  const body = output ? `Task completed.\n\n${output.slice(0, 2000)}` : "Task completed.";

  // Prefer AgentSession activity (shows in the agent panel) over issue comment (avoids duplication)
  if (sessionId) {
    endAgentSession(sessionId, body, "response").catch((err) => {
      console.error(`[Linear Outbound] Failed to end AgentSession for task ${taskId}:`, err);
    });
    taskSessionMap.delete(taskId);
    console.log(`[Linear Outbound] Posted completion response to AgentSession for task ${taskId}`);
  } else {
    // No session — fall back to issue comment
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
      console.log(`[Linear Outbound] Posted completion comment for task ${taskId}`);
    } catch (error) {
      console.error(
        `[Linear Outbound] Failed to sync task completion for ${taskId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  updateTrackerSync(sync.id, {
    lastSyncOrigin: "swarm",
    lastSyncedAt: new Date().toISOString(),
  });
}

async function handleTaskFailed(data: unknown): Promise<void> {
  const { taskId, failureReason } = data as { taskId: string; failureReason?: string };
  if (!taskId) return;

  const sync = getTrackerSync("linear", "task", taskId);
  if (!sync) return;

  if (shouldSkipForLoopPrevention(sync)) return;

  const sessionId = taskSessionMap.get(taskId);
  const body = failureReason ? `Task failed.\n\n${failureReason.slice(0, 2000)}` : "Task failed.";

  // Prefer AgentSession error activity over issue comment (avoids duplication)
  if (sessionId) {
    endAgentSession(sessionId, body, "error").catch((err) => {
      console.error(`[Linear Outbound] Failed to end AgentSession for task ${taskId}:`, err);
    });
    taskSessionMap.delete(taskId);
    console.log(`[Linear Outbound] Posted failure error to AgentSession for task ${taskId}`);
  } else {
    // No session — fall back to issue comment
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
      console.log(`[Linear Outbound] Posted failure comment for task ${taskId}`);
    } catch (error) {
      console.error(
        `[Linear Outbound] Failed to sync task failure for ${taskId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  updateTrackerSync(sync.id, {
    lastSyncOrigin: "swarm",
    lastSyncedAt: new Date().toISOString(),
  });
}

async function handleTaskCancelled(data: unknown): Promise<void> {
  const { taskId } = data as { taskId: string };
  if (!taskId) return;

  const sync = getTrackerSync("linear", "task", taskId);
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
      const client = getLinearClient();
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

  updateTrackerSync(sync.id, {
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
