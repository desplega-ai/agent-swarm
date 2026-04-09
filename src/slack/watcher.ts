import {
  getAgentById,
  getChildTasks,
  getCompletedSlackTasks,
  getInProgressSlackTasks,
  getTaskById,
} from "../be/db";
import type { AgentTask } from "../types";
import { getSlackApp } from "./app";
import type { TreeNode } from "./blocks";
import { buildTreeBlocks, formatDuration } from "./blocks";
import {
  sendProgressUpdate,
  sendTaskResponse,
  updateProgressInPlace,
  updateToFinal,
  updateTreeMessage,
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

// --- Tree-aware tracking (Phase 4) ---

// Per-round tree state (one tree message per user interaction round)
interface TreeMessageState {
  channelId: string;
  threadTs: string;
  messageTs: string;
  rootTaskIds: Set<string>; // Tasks directly assigned from this round
}

// messageTs → tree state
const treeMessages = new Map<string, TreeMessageState>();

// taskId → messageTs (reverse lookup — includes both root and discovered children)
const taskToTree = new Map<string, string>();

// Legacy flat map kept for backward compatibility.
// Used by flat processing for tasks NOT tracked in a tree (e.g. non-tree tasks, server restarts).
const taskMessages = new Map<string, { channelId: string; threadTs: string; messageTs: string }>();

/**
 * Register a task in a tree message (called by handlers.ts after posting assignment).
 * Creates or extends a tree for the given Slack message, and also populates the
 * legacy taskMessages map so that the existing flat watcher processing still works.
 */
export function registerTreeMessage(
  taskId: string,
  channelId: string,
  threadTs: string,
  messageTs: string,
): void {
  let tree = treeMessages.get(messageTs);
  if (!tree) {
    tree = { channelId, threadTs, messageTs, rootTaskIds: new Set() };
    treeMessages.set(messageTs, tree);
  }
  tree.rootTaskIds.add(taskId);
  taskToTree.set(taskId, messageTs);

  // Also register in legacy flat map so existing watcher processing still works
  taskMessages.set(taskId, { channelId, threadTs, messageTs });

  console.log(`[Slack] Registered task ${taskId.slice(0, 8)} in tree message ${messageTs}`);
}

// Backward-compatible alias — handlers.ts imports registerTaskMessage
export const registerTaskMessage = registerTreeMessage;

/**
 * Build TreeNode[] for a tree's root tasks and their children.
 * Used by the tree rendering loop (Phase 5) to construct the data for buildTreeBlocks().
 */
export function buildTreeNodes(tree: TreeMessageState): TreeNode[] {
  const nodes: TreeNode[] = [];

  for (const rootTaskId of tree.rootTaskIds) {
    const task = getTaskById(rootTaskId);
    if (!task) {
      console.log(`[Slack] Tree root task ${rootTaskId.slice(0, 8)} not found, skipping`);
      continue;
    }

    const agent = task.agentId ? getAgentById(task.agentId) : null;
    const agentName = agent?.name ?? "Unknown";

    // Compute duration for completed/failed tasks
    let duration: string | undefined;
    if (task.finishedAt && task.createdAt) {
      duration = formatDuration(new Date(task.createdAt), new Date(task.finishedAt));
    }

    // Discover all descendants (children + grandchildren) and flatten as children of root
    const childNodes: TreeNode[] = [];
    const taskQueue = [rootTaskId];
    const seen = new Set<string>([rootTaskId]);

    while (taskQueue.length > 0) {
      const parentId = taskQueue.shift()!;
      const childTasks = getChildTasks(parentId);

      for (const child of childTasks) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);

        // Register discovered descendants in taskToTree so they're skipped in flat processing
        if (!taskToTree.has(child.id)) {
          taskToTree.set(child.id, tree.messageTs);
          console.log(
            `[Slack] Discovered descendant task ${child.id.slice(0, 8)} under root ${rootTaskId.slice(0, 8)}`,
          );
        }

        const childAgent = child.agentId ? getAgentById(child.agentId) : null;
        const childAgentName = childAgent?.name ?? "Unknown";

        let childDuration: string | undefined;
        if (child.finishedAt && child.createdAt) {
          childDuration = formatDuration(new Date(child.createdAt), new Date(child.finishedAt));
        }

        childNodes.push({
          taskId: child.id,
          agentName: childAgentName,
          status: child.status as TreeNode["status"],
          progress: child.progress ?? undefined,
          duration: childDuration,
          slackReplySent: child.slackReplySent,
          output: child.output ?? undefined,
          failureReason: child.failureReason ?? undefined,
          children: [],
        });

        // Queue this child to discover its children (grandchildren of root)
        taskQueue.push(child.id);
      }
    }

    nodes.push({
      taskId: task.id,
      agentName,
      status: task.status as TreeNode["status"],
      progress: task.progress ?? undefined,
      duration,
      slackReplySent: task.slackReplySent,
      output: task.output ?? undefined,
      failureReason: task.failureReason ?? undefined,
      children: childNodes,
    });
  }

  return nodes;
}

// --- Tree rendering state ---

// messageTs → last serialized tree output (for no-op detection)
const lastRenderedTree = new Map<string, string>();

// messageTs → last update timestamp (for rate limiting)
const treeLastUpdateTime = new Map<string, number>();

// Expose tree data structures for testing
export function _getTreeMessages(): Map<string, TreeMessageState> {
  return treeMessages;
}
export function _getTaskToTree(): Map<string, string> {
  return taskToTree;
}
export function _getLastRenderedTree(): Map<string, string> {
  return lastRenderedTree;
}
export function _getTreeLastUpdateTime(): Map<string, number> {
  return treeLastUpdateTime;
}

// Expose DM helpers for testing
export const _isDMChannel = isDMChannel;
export const _postInitialDMTreeMessage = postInitialDMTreeMessage;

/**
 * Check if ALL tasks in a tree are terminal (completed/failed/cancelled).
 */
function isTreeFullyTerminal(nodes: TreeNode[]): boolean {
  for (const node of nodes) {
    if (node.status === "pending" || node.status === "in_progress") return false;
    for (const child of node.children) {
      if (child.status === "pending" || child.status === "in_progress") return false;
    }
  }
  return true;
}

/**
 * Clean up tracking for a completed tree.
 * Removes tree from treeMessages, removes all task IDs from taskToTree,
 * adds root task IDs to notifiedCompletions, and cleans up rendering state.
 */
function cleanupCompletedTree(messageTs: string, _tree: TreeMessageState, nodes: TreeNode[]): void {
  const now = Date.now();

  // Collect all task IDs in this tree (roots + children)
  const allTaskIds: string[] = [];
  for (const node of nodes) {
    allTaskIds.push(node.taskId);
    for (const child of node.children) {
      allTaskIds.push(child.taskId);
    }
  }

  // Add all to notifiedCompletions so flat processing doesn't re-process
  for (const taskId of allTaskIds) {
    notifiedCompletions.set(taskId, now);
  }

  // Remove from tree tracking
  for (const taskId of allTaskIds) {
    taskToTree.delete(taskId);
    taskMessages.delete(taskId);
    sentProgress.delete(taskId);
  }

  treeMessages.delete(messageTs);
  lastRenderedTree.delete(messageTs);
  treeLastUpdateTime.delete(messageTs);

  console.log(`[Slack] Tree ${messageTs} fully terminal, cleaned up ${allTaskIds.length} task(s)`);
}

/**
 * Process all active tree messages: re-render and update via chat.update.
 * Called from the main polling interval.
 */
export async function processTreeMessages(): Promise<void> {
  const now = Date.now();

  for (const [messageTs, tree] of treeMessages) {
    // Rate limit: don't update the same tree more than once per MIN_SEND_INTERVAL
    const lastUpdate = treeLastUpdateTime.get(messageTs);
    if (lastUpdate && now - lastUpdate < MIN_SEND_INTERVAL) continue;

    let nodes: TreeNode[];
    try {
      nodes = buildTreeNodes(tree);
    } catch (error) {
      console.error(`[Slack] Tree render failed for ${messageTs}, skipping:`, error);
      continue;
    }

    if (nodes.length === 0) continue;

    // Check if tree is fully terminal — do one final render then clean up
    const fullyTerminal = isTreeFullyTerminal(nodes);

    // Build blocks
    let blocks: unknown[];
    try {
      blocks = buildTreeBlocks(nodes);
    } catch (error) {
      console.error(`[Slack] Tree render failed, falling back to flat message:`, error);
      continue;
    }

    // Serialize for no-op detection
    const serialized = JSON.stringify(blocks);
    const lastSerialized = lastRenderedTree.get(messageTs);
    if (serialized === lastSerialized) {
      // No changes — skip update
      if (fullyTerminal) {
        // Even though nothing changed visually, clean up if terminal
        cleanupCompletedTree(messageTs, tree, nodes);
      }
      continue;
    }

    // Build fallback text
    const rootNames = nodes.map((n) => `${n.agentName}`).join(", ");
    const fallbackText = fullyTerminal
      ? `Tasks completed: ${rootNames}`
      : `Tasks in progress: ${rootNames}`;

    // Update the Slack message
    const success = await updateTreeMessage(tree.channelId, messageTs, blocks, fallbackText);
    if (success) {
      lastRenderedTree.set(messageTs, serialized);
      treeLastUpdateTime.set(messageTs, now);
      console.log(
        `[Slack] Updated tree message ${messageTs} (${nodes.length} root(s), terminal=${fullyTerminal})`,
      );
    }

    // DM channels: set assistant status in parallel for typing indicator UX
    if (isDMChannel(tree.channelId) && !fullyTerminal) {
      // Find the first in-progress node to use its progress text
      const activeNode =
        nodes.find((n) => n.status === "in_progress") ??
        nodes.flatMap((n) => n.children).find((c) => c.status === "in_progress");
      const statusText = activeNode?.progress || "Processing your request...";
      setAssistantStatus(tree.channelId, tree.threadTs, statusText).catch((error) =>
        console.error(`[Slack] Failed to set DM assistant status for tree ${messageTs}:`, error),
      );
    }

    // Clear assistant status when DM tree is fully terminal
    if (isDMChannel(tree.channelId) && fullyTerminal) {
      setAssistantStatus(tree.channelId, tree.threadTs, "").catch((error) =>
        console.error(`[Slack] Failed to clear DM assistant status for tree ${messageTs}:`, error),
      );
    }

    // Clean up fully terminal trees after final render
    if (fullyTerminal && success) {
      cleanupCompletedTree(messageTs, tree, nodes);
    }
  }
}

/**
 * Check if a channel is a DM (assistant thread). DM channels start with "D".
 */
function isDMChannel(channelId: string): boolean {
  return channelId.startsWith("D");
}

/**
 * Set the assistant thread status (typing indicator) for DM channels.
 */
async function setAssistantStatus(channelId: string, threadTs: string, status: string) {
  const app = getSlackApp();
  if (!app) return;

  try {
    await app.client.assistant.threads.setStatus({
      channel_id: channelId,
      thread_ts: threadTs,
      status,
    });
  } catch (error) {
    console.error(`[Slack] Failed to set assistant status:`, error);
  }
}

/**
 * Post an initial tree message for a DM task that is in_progress but not yet
 * tracked in a tree. Returns the messageTs of the posted message, or undefined
 * if posting failed.
 */
async function postInitialDMTreeMessage(task: AgentTask): Promise<string | undefined> {
  const app = getSlackApp();
  if (!app || !task.slackChannelId || !task.slackThreadTs || !task.agentId) return undefined;

  const agent = getAgentById(task.agentId);
  if (!agent) return undefined;

  // Build an initial tree with this single task
  const initialNode: TreeNode = {
    taskId: task.id,
    agentName: agent.name,
    status: task.status as TreeNode["status"],
    progress: task.progress ?? undefined,
    children: [],
  };

  let blocks: unknown[];
  try {
    blocks = buildTreeBlocks([initialNode]);
  } catch (error) {
    console.error(`[Slack] Failed to build initial DM tree blocks:`, error);
    return undefined;
  }

  const fallbackText = `Task in progress: ${agent.name}`;

  try {
    // DM channels skip persona overrides (handled by sendWithPersona / postMessage)
    const result = await app.client.chat.postMessage({
      channel: task.slackChannelId,
      thread_ts: task.slackThreadTs,
      text: fallbackText,
      // biome-ignore lint/suspicious/noExplicitAny: Block Kit objects
      blocks: blocks as any,
    });

    if (result.ts) {
      console.log(
        `[Slack] Posted initial DM tree message for task ${task.id.slice(0, 8)} (messageTs=${result.ts})`,
      );
      return result.ts;
    }
  } catch (error) {
    console.error(`[Slack] Failed to post initial DM tree message:`, error);
  }

  return undefined;
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
      // Process tree messages first (renders all tracked trees via chat.update)
      await processTreeMessages();

      // Check for progress updates on in-progress tasks
      const inProgressTasks = getInProgressSlackTasks();
      const now = Date.now();
      for (const task of inProgressTasks) {
        // Late-register descendant tasks into their ancestor's tree (walk up parent chain)
        if (!taskToTree.has(task.id) && task.parentTaskId) {
          let ancestorId: string | undefined = task.parentTaskId;
          while (ancestorId) {
            const treeMs = taskToTree.get(ancestorId);
            if (treeMs) {
              taskToTree.set(task.id, treeMs);
              console.log(
                `[Slack] Late-registered in-progress descendant ${task.id.slice(0, 8)} into ancestor tree`,
              );
              break;
            }
            const ancestor = getTaskById(ancestorId);
            ancestorId = ancestor?.parentTaskId ?? undefined;
          }
        }

        // Skip tasks tracked in a tree — they're rendered by processTreeMessages()
        if (taskToTree.has(task.id)) continue;
        const progressKey = `progress:${task.id}`;

        // Skip if already sending or sent recently (throttle)
        if (pendingSends.has(progressKey)) continue;
        const lastSent = lastSendTime.get(progressKey);
        if (lastSent && now - lastSent < MIN_SEND_INTERVAL) continue;

        const isDM = task.slackChannelId && isDMChannel(task.slackChannelId);

        // DM tasks: post initial tree message if not yet tracked, and set assistant status in parallel
        if (isDM && task.slackChannelId && task.slackThreadTs && !taskToTree.has(task.id)) {
          pendingSends.add(progressKey);
          lastSendTime.set(progressKey, now);
          try {
            // Post initial tree message and register it
            const dmMessageTs = await postInitialDMTreeMessage(task);
            if (dmMessageTs) {
              registerTreeMessage(task.id, task.slackChannelId, task.slackThreadTs, dmMessageTs);
              console.log(
                `[Slack] DM task ${task.id.slice(0, 8)} registered in tree, will be updated by processTreeMessages()`,
              );
            }
            // Set assistant status in parallel for typing indicator UX
            const progressText = task.progress || "Processing your request...";
            await setAssistantStatus(task.slackChannelId, task.slackThreadTs, progressText);
            sentProgress.set(task.id, progressText);
            console.log(`[Slack] Set assistant status for DM task ${task.id.slice(0, 8)}`);
          } catch (error) {
            lastSendTime.delete(progressKey);
            console.error(`[Slack] Failed to initialize DM tree message:`, error);
          } finally {
            pendingSends.delete(progressKey);
          }
          continue;
        }

        // Channel thread: use chat.update on the evolving message
        const tracked = taskMessages.get(task.id);

        // If we have a tracked message but haven't sent any progress yet,
        // update assignment message to "In Progress" state immediately
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
        // Late-register descendant tasks into their ancestor's tree (walk up parent chain)
        if (!taskToTree.has(task.id) && task.parentTaskId) {
          let ancestorId: string | undefined = task.parentTaskId;
          while (ancestorId) {
            const treeMs = taskToTree.get(ancestorId);
            if (treeMs) {
              taskToTree.set(task.id, treeMs);
              console.log(
                `[Slack] Late-registered completed descendant ${task.id.slice(0, 8)} into ancestor tree`,
              );
              break;
            }
            const ancestor = getTaskById(ancestorId);
            ancestorId = ancestor?.parentTaskId ?? undefined;
          }
        }

        // Skip tasks tracked in a tree — they're rendered by processTreeMessages()
        // But mark as notified to prevent re-processing if tree is cleaned up
        if (taskToTree.has(task.id)) {
          notifiedCompletions.set(task.id, now);
          continue;
        }

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
            // Channel thread: update the same message to its final state
            await updateToFinal(task, tracked.messageTs);
            taskMessages.delete(task.id);
          } else {
            // DM or untracked: post completion as a new message
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
