import {
  createTaskExtended,
  getLatestActiveTaskInThread,
  getLeadAgent,
  getMostRecentTaskInThread,
} from "../be/db";
import { getSlackApp } from "./app";
import { buildBufferFlushBlocks } from "./blocks";
import { registerTreeMessage } from "./watcher";

interface BufferedMessage {
  text: string;
  userId: string;
  ts: string;
}

interface BufferedThread {
  channelId: string;
  threadTs: string;
  messages: BufferedMessage[];
  timer: Timer;
  slackUserId: string; // original requester (first message sender)
}

const threadBuffers = new Map<string, BufferedThread>();

const BUFFER_TIMEOUT_MS = Number(process.env.ADDITIVE_SLACK_BUFFER_MS) || 10_000;

function makeKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

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
  const key = makeKey(channelId, threadTs);
  const existing = threadBuffers.get(key);

  if (existing) {
    // Append to existing buffer, reset timer
    existing.messages.push({ text, userId, ts });
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => flushBuffer(key, false), BUFFER_TIMEOUT_MS);
    console.log(
      `[Slack] Buffer append: ${key} (${existing.messages.length} messages, timer reset to ${BUFFER_TIMEOUT_MS}ms)`,
    );
  } else {
    // Create new buffer entry
    const timer = setTimeout(() => flushBuffer(key, false), BUFFER_TIMEOUT_MS);
    threadBuffers.set(key, {
      channelId,
      threadTs,
      messages: [{ text, userId, ts }],
      timer,
      slackUserId: userId,
    });
    console.log(`[Slack] Buffer created: ${key} (timer set to ${BUFFER_TIMEOUT_MS}ms)`);
  }
}

/**
 * Check if a thread currently has a pending buffer.
 */
export function isThreadBuffered(channelId: string, threadTs: string): boolean {
  return threadBuffers.has(makeKey(channelId, threadTs));
}

/**
 * Get the number of messages currently in the buffer for a thread key.
 */
export function getBufferMessageCount(key: string): number {
  return threadBuffers.get(key)?.messages.length ?? 0;
}

/**
 * Instantly flush the buffer (used by !now command). Clears the debounce timer
 * and flushes with immediate=true (no dependsOn).
 */
export async function instantFlush(key: string): Promise<void> {
  const buffer = threadBuffers.get(key);
  if (buffer) {
    clearTimeout(buffer.timer);
    console.log(`[Slack] Instant flush triggered: ${key}`);
  }
  await flushBuffer(key, true);
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
 * Flush the buffer: concatenate messages, create task with optional dependency chaining.
 * @param key - The buffer key (channelId:threadTs)
 * @param immediate - If true, skip dependency chaining (used by !now)
 */
async function flushBuffer(key: string, immediate = false): Promise<void> {
  const buffer = threadBuffers.get(key);
  if (!buffer || buffer.messages.length === 0) {
    threadBuffers.delete(key);
    return;
  }

  console.log(
    `[Slack] Flushing buffer: ${key} (${buffer.messages.length} messages, immediate=${immediate})`,
  );

  // Build combined task description
  const combinedText = buffer.messages.map((m) => m.text).join("\n---\n");
  const description = `[Thread follow-up — ${buffer.messages.length} message(s) buffered]\n\n${combinedText}`;

  // Find the latest active task in this thread for dependency chaining
  const latestActiveTask = getLatestActiveTaskInThread(buffer.channelId, buffer.threadTs);
  if (latestActiveTask) {
    console.log(
      `[Slack] Dependency chaining: latest active task ${latestActiveTask.id} (status: ${latestActiveTask.status})`,
    );
  }

  const lead = getLeadAgent();

  // Thread context for the task
  const threadContext = await getThreadContextForBuffer(buffer.channelId, buffer.threadTs);
  const fullDescription = threadContext
    ? `<thread_context>\n${threadContext}\n</thread_context>\n\n${description}`
    : description;

  // Always pending. If !now was used (immediate=true), no dependency.
  // Otherwise, depend on the latest active task so it queues naturally.
  const dependsOn = !immediate && latestActiveTask ? [latestActiveTask.id] : undefined;

  const mostRecentTask = getMostRecentTaskInThread(buffer.channelId, buffer.threadTs);
  const task = createTaskExtended(fullDescription, {
    agentId: lead?.id,
    source: "slack",
    slackChannelId: buffer.channelId,
    slackThreadTs: buffer.threadTs,
    slackUserId: buffer.slackUserId,
    dependsOn,
    parentTaskId: mostRecentTask?.id,
  });

  console.log(
    `[Slack] Buffer flushed → task ${task.id} (dependsOn: ${dependsOn ? dependsOn.join(", ") : "none"})`,
  );

  // Slack feedback with Block Kit
  const app = getSlackApp();
  if (app) {
    const hasDependency = !immediate && !!latestActiveTask;
    const blocks = buildBufferFlushBlocks({
      messageCount: buffer.messages.length,
      taskId: task.id,
      hasDependency,
    });
    const fallbackText = hasDependency
      ? `${buffer.messages.length} follow-up message(s) queued pending completion of current task`
      : `${buffer.messages.length} follow-up message(s) batched into task`;

    try {
      const result = await app.client.chat.postMessage({
        channel: buffer.channelId,
        thread_ts: buffer.threadTs,
        text: fallbackText,
        // biome-ignore lint/suspicious/noExplicitAny: Block Kit objects
        blocks: blocks as any,
      });

      // Register the batching message as the tree message for this task
      if (result.ts && task) {
        registerTreeMessage(task.id, buffer.channelId, buffer.threadTs, result.ts);
        console.log(
          `[Slack] Registered batched task ${task.id.slice(0, 8)} tree message from buffer flush`,
        );
      }
    } catch (error) {
      console.error("[Slack] Failed to post buffer flush feedback:", error);
    }
  }

  threadBuffers.delete(key);
}
