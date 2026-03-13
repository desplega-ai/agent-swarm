import { getCompletedSlackTasks, getInProgressSlackTasks } from "../be/db";
import { getSlackApp } from "./app";
import {
  sendProgressUpdate,
  sendTaskResponse,
  updateProgressInPlace,
  updateToFinal,
} from "./responses";

let watcherInterval: ReturnType<typeof setInterval> | null = null;
let isProcessing = false;

// Track notified completion tasks (taskId -> timestamp)
const notifiedCompletions = new Map<string, number>();

// Track sent progress messages (taskId -> last progress text)
const sentProgress = new Map<string, string>();

// Track in-flight sends to prevent race conditions
const pendingSends = new Set<string>();

// Track last send time per task to throttle (taskId -> timestamp)
const lastSendTime = new Map<string, number>();
const MIN_SEND_INTERVAL = 1000; // Don't send for same task within 1 second

// Track task message timestamps for chat.update (taskId -> message info)
// This is THE message that evolves: assignment → progress → completion
const taskMessages = new Map<string, { channelId: string; threadTs: string; messageTs: string }>();

/**
 * Register the initial message ts for a task (called by handlers.ts after posting assignment).
 * This allows the watcher to update the same message through the task lifecycle.
 */
export function registerTaskMessage(
  taskId: string,
  channelId: string,
  threadTs: string,
  messageTs: string,
): void {
  taskMessages.set(taskId, { channelId, threadTs, messageTs });
}

/**
 * Start watching for Slack task updates and sending responses.
 */
export function startTaskWatcher(intervalMs = 3000): void {
  if (watcherInterval) {
    console.log("[Slack] Task watcher already running");
    return;
  }

  // Initialize with existing completed tasks to avoid re-notifying on restart
  const existingCompleted = getCompletedSlackTasks();
  const now = Date.now();
  for (const task of existingCompleted) {
    notifiedCompletions.set(task.id, now);
  }
  console.log(`[Slack] Initialized with ${existingCompleted.length} existing completed tasks`);

  watcherInterval = setInterval(async () => {
    // Prevent overlapping processing cycles
    if (isProcessing || !getSlackApp()) return;
    isProcessing = true;

    try {
      // Check for progress updates on in-progress tasks
      const inProgressTasks = getInProgressSlackTasks();
      const now = Date.now();
      for (const task of inProgressTasks) {
        const progressKey = `progress:${task.id}`;

        // Skip if already sending or sent recently (throttle)
        if (pendingSends.has(progressKey)) continue;
        const lastSent = lastSendTime.get(progressKey);
        if (lastSent && now - lastSent < MIN_SEND_INTERVAL) continue;

        // If we have a tracked message but haven't sent any progress yet,
        // update assignment message to "In Progress" state immediately
        const tracked = taskMessages.get(task.id);
        if (tracked && !sentProgress.has(task.id) && !task.progress) {
          pendingSends.add(progressKey);
          sentProgress.set(task.id, "__in_progress__");
          lastSendTime.set(progressKey, now);
          try {
            await updateProgressInPlace(task, "Starting...", tracked.messageTs);
            console.log(`[Slack] Updated to in-progress for task ${task.id.slice(0, 8)}`);
          } catch (error) {
            sentProgress.delete(task.id);
            lastSendTime.delete(progressKey);
            console.error(`[Slack] Failed to update to in-progress:`, error);
          } finally {
            pendingSends.delete(progressKey);
          }
          continue;
        }

        const lastSentProgress = sentProgress.get(task.id);
        // Only send if progress exists and is different from last sent
        if (task.progress && task.progress !== lastSentProgress) {
          // Mark as pending and sent BEFORE sending
          pendingSends.add(progressKey);
          sentProgress.set(task.id, task.progress);
          lastSendTime.set(progressKey, now);
          try {
            if (tracked) {
              // Update the existing message in-place via chat.update
              await updateProgressInPlace(task, task.progress, tracked.messageTs);
              console.log(`[Slack] Updated progress in-place for task ${task.id.slice(0, 8)}`);
            } else {
              // No tracked message (e.g., multi-task assignment or server restart)
              // Post a new progress message and track its ts
              const messageTs = await sendProgressUpdate(task, task.progress);
              if (messageTs && task.slackChannelId && task.slackThreadTs) {
                taskMessages.set(task.id, {
                  channelId: task.slackChannelId,
                  threadTs: task.slackThreadTs,
                  messageTs,
                });
              }
              console.log(`[Slack] Sent initial progress for task ${task.id.slice(0, 8)}`);
            }
          } catch (error) {
            // If send fails, clear markers so we can retry
            sentProgress.delete(task.id);
            lastSendTime.delete(progressKey);
            console.error(`[Slack] Failed to send progress:`, error);
          } finally {
            pendingSends.delete(progressKey);
          }
        }
      }

      // Check for completed tasks
      const completedTasks = getCompletedSlackTasks();
      for (const task of completedTasks) {
        const completionKey = `completion:${task.id}`;

        // Skip if already notified or currently sending or sent recently
        if (notifiedCompletions.has(task.id) || pendingSends.has(completionKey)) continue;
        const lastSent = lastSendTime.get(completionKey);
        if (lastSent && now - lastSent < MIN_SEND_INTERVAL) continue;

        // Mark as pending and notified BEFORE sending
        pendingSends.add(completionKey);
        notifiedCompletions.set(task.id, now);
        lastSendTime.set(completionKey, now);
        try {
          const tracked = taskMessages.get(task.id);
          if (tracked) {
            // Update the same message to its final state (full output)
            await updateToFinal(task, tracked.messageTs);
            taskMessages.delete(task.id);
          } else {
            // No tracked message — post completion as a new message
            await sendTaskResponse(task);
          }
          // Clean up progress tracking
          sentProgress.delete(task.id);
          console.log(`[Slack] Sent ${task.status} response for task ${task.id.slice(0, 8)}`);
        } catch (error) {
          // If send fails, remove from notified so we can retry
          notifiedCompletions.delete(task.id);
          lastSendTime.delete(completionKey);
          console.error(`[Slack] Failed to send completion:`, error);
        } finally {
          pendingSends.delete(completionKey);
        }
      }
    } finally {
      isProcessing = false;
    }
  }, intervalMs);

  console.log(`[Slack] Task watcher started (interval: ${intervalMs}ms)`);
}

export function stopTaskWatcher(): void {
  if (watcherInterval) {
    clearInterval(watcherInterval);
    watcherInterval = null;
    isProcessing = false;
    console.log("[Slack] Task watcher stopped");
  }
}
