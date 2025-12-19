import { getCompletedSlackTasks, getInProgressSlackTasks } from "../be/db";
import { getSlackApp } from "./app";
import { sendProgressUpdate, sendTaskResponse } from "./responses";

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

        const lastSentProgress = sentProgress.get(task.id);
        // Only send if progress exists and is different from last sent
        if (task.progress && task.progress !== lastSentProgress) {
          // Mark as pending and sent BEFORE sending
          pendingSends.add(progressKey);
          sentProgress.set(task.id, task.progress);
          lastSendTime.set(progressKey, now);
          try {
            await sendProgressUpdate(task, task.progress);
            console.log(`[Slack] Sent progress update for task ${task.id.slice(0, 8)}`);
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
          await sendTaskResponse(task);
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
