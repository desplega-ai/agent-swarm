import { getLatestActiveTaskInThread, getLeadAgent, getMostRecentTaskInThread } from "../be/db";
import { createAdditiveBuffer } from "../tasks/additive-buffer";
import { slackContextKey } from "../tasks/context-key";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import { getSlackApp } from "./app";
import { buildBufferFlushBlocks } from "./blocks";
import { registerTreeMessage } from "./watcher";

interface BufferedMessage {
  text: string;
  userId: string;
  ts: string;
  channelId: string;
  threadTs: string;
}

const BUFFER_TIMEOUT_MS = Number(process.env.ADDITIVE_SLACK_BUFFER_MS) || 10_000;

function makeKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

function splitKey(key: string): { channelId: string; threadTs: string } | null {
  const idx = key.indexOf(":");
  if (idx === -1) return null;
  return { channelId: key.slice(0, idx), threadTs: key.slice(idx + 1) };
}

const slackBuffer = createAdditiveBuffer<BufferedMessage>({
  timeoutMs: BUFFER_TIMEOUT_MS,
  label: "slack-thread",
  onFlush: async (items, key, reason) => {
    await slackFlush(items, key, reason === "manual");
  },
});

/**
 * Add a message to the thread buffer. Resets the debounce timer.
 */
export function bufferThreadMessage(
  channelId: string,
  threadTs: string,
  text: string,
  userId: string,
  ts: string,
): void {
  slackBuffer.enqueue(makeKey(channelId, threadTs), {
    text,
    userId,
    ts,
    channelId,
    threadTs,
  });
}

/**
 * Check if a thread currently has a pending buffer.
 */
export function isThreadBuffered(channelId: string, threadTs: string): boolean {
  return slackBuffer.isBuffered(makeKey(channelId, threadTs));
}

/**
 * Get the number of messages currently in the buffer for a thread key.
 */
export function getBufferMessageCount(key: string): number {
  return slackBuffer.count(key);
}

/**
 * Instantly flush the buffer (used by !now command). Clears the debounce timer
 * and flushes with immediate=true (no dependsOn).
 */
export async function instantFlush(key: string): Promise<void> {
  await slackBuffer.instantFlush(key);
}

/**
 * Fetch thread context from Slack for the buffer flush task description.
 */
async function getThreadContextForBuffer(channelId: string, threadTs: string): Promise<string> {
  const app = getSlackApp();
  if (!app) return "";

  try {
    const result = await app.client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: 20,
    });

    const messages = result.messages || [];
    if (messages.length === 0) return "";

    const formatted = messages
      .filter((m) => m.text)
      .map((m) => {
        const msg = m as Record<string, unknown>;
        const isBotMessage = msg.bot_id !== undefined || msg.subtype === "bot_message";
        if (isBotMessage) {
          const truncated = m.text && m.text.length > 500 ? `${m.text.slice(0, 500)}...` : m.text;
          return `[Agent]: ${truncated}`;
        }
        return `<@${m.user}>: ${m.text}`;
      })
      .join("\n");

    return formatted;
  } catch (error) {
    console.error("[Slack] Failed to fetch thread context for buffer:", error);
    return "";
  }
}

/**
 * Flush the Slack thread buffer: concatenate messages, create task with optional
 * dependency chaining.
 */
async function slackFlush(
  items: BufferedMessage[],
  key: string,
  immediate: boolean,
): Promise<void> {
  if (items.length === 0) return;

  const split = splitKey(key);
  if (!split) {
    console.warn(`[Slack] Buffer flush: malformed key ${key}`);
    return;
  }
  const { channelId, threadTs } = split;
  // Buffer is guaranteed to have at least one item — the first carries the
  // original requester's userId (same semantics as the pre-refactor version).
  const originalRequesterId = items[0]!.userId;

  console.log(`[Slack] Flushing buffer: ${key} (${items.length} messages, immediate=${immediate})`);

  // Build combined task description
  const combinedText = items.map((m) => m.text).join("\n---\n");
  const description = `[Thread follow-up — ${items.length} message(s) buffered]\n\n${combinedText}`;

  // Find the latest active task in this thread for dependency chaining
  const latestActiveTask = getLatestActiveTaskInThread(channelId, threadTs);
  if (latestActiveTask) {
    console.log(
      `[Slack] Dependency chaining: latest active task ${latestActiveTask.id} (status: ${latestActiveTask.status})`,
    );
  }

  const lead = getLeadAgent();

  // Thread context for the task
  const threadContext = await getThreadContextForBuffer(channelId, threadTs);
  const fullDescription = threadContext
    ? `<thread_context>\n${threadContext}\n</thread_context>\n\n${description}`
    : description;

  // Always pending. If !now was used (immediate=true), no dependency.
  // Otherwise, depend on the latest active task so it queues naturally.
  const dependsOn = !immediate && latestActiveTask ? [latestActiveTask.id] : undefined;

  const mostRecentTask = getMostRecentTaskInThread(channelId, threadTs);
  const task = createTaskWithSiblingAwareness(fullDescription, {
    agentId: lead?.id,
    source: "slack",
    slackChannelId: channelId,
    slackThreadTs: threadTs,
    slackUserId: originalRequesterId,
    dependsOn,
    parentTaskId: mostRecentTask?.id,
    contextKey: slackContextKey({ channelId, threadTs }),
  });

  console.log(
    `[Slack] Buffer flushed → task ${task.id} (dependsOn: ${dependsOn ? dependsOn.join(", ") : "none"})`,
  );

  // Slack feedback with Block Kit
  const app = getSlackApp();
  if (app) {
    const hasDependency = !immediate && !!latestActiveTask;
    const blocks = buildBufferFlushBlocks({
      messageCount: items.length,
      taskId: task.id,
      hasDependency,
    });
    const fallbackText = hasDependency
      ? `${items.length} follow-up message(s) queued pending completion of current task`
      : `${items.length} follow-up message(s) batched into task`;

    try {
      const result = await app.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: fallbackText,
        // biome-ignore lint/suspicious/noExplicitAny: Block Kit objects
        blocks: blocks as any,
      });

      // Register the batching message as the tree message for this task
      if (result.ts && task) {
        registerTreeMessage(task.id, channelId, threadTs, result.ts);
        console.log(
          `[Slack] Registered batched task ${task.id.slice(0, 8)} tree message from buffer flush`,
        );
      }
    } catch (error) {
      console.error("[Slack] Failed to post buffer flush feedback:", error);
    }
  }
}
