import type { ChatUpdateArguments, WebClient } from "@slack/web-api";
import { getAgentById, getTaskAttachments, markTaskSlackReplySent } from "../be/db";
import type { Agent, AgentTask } from "../types";
import { getSlackApp } from "./app";
import {
  buildCancelledBlocks,
  buildCompletedBlockBatches,
  buildCompletedBlocks,
  buildFailedBlocks,
  buildProgressBlocks,
  formatAttachmentsBlockForSlack,
  formatDuration,
  getTaskLink,
  isTreeOutputTruncated,
  markdownToSlack,
  splitSlackSectionText,
} from "./blocks";

// Re-export for backward compatibility
export { markdownToSlack } from "./blocks";

export type SlackUpdateResult = "ok" | "not_found" | "failed";

type ChatUpdatePayload = ChatUpdateArguments & {
  unfurl_links: false;
  unfurl_media: false;
};

function classifySlackUpdateError(error: unknown): SlackUpdateResult {
  const errorCode = (error as { data?: { error?: string } } | undefined)?.data?.error;
  if (
    errorCode === "message_not_found" ||
    errorCode === "channel_not_found" ||
    errorCode === "thread_not_found"
  ) {
    return "not_found";
  }
  return "failed";
}

const isDev = process.env.ENV === "development";

// Ten 2,900-char sections keep each message's fallback text below Slack's
// 40,000-char message cap while allowing arbitrarily long output in batches.
const MAX_INLINE_OUTPUT_BLOCKS_PER_MESSAGE = 10;

/**
 * Get the display name for an agent, with (dev) prefix if in development mode.
 */
export function getAgentDisplayName(agent: Agent): string {
  return isDev ? `(dev) ${agent.name}` : agent.name;
}

export function shouldPostInlineCompletionOutput(task: AgentTask): boolean {
  if (task.status !== "completed") return false;
  if (!task.slackChannelId || !task.slackThreadTs) return false;
  if (task.slackReplySent) return false;

  const output = task.output?.trim();
  return !!output && isTreeOutputTruncated(markdownToSlack(output));
}

export function formatInlineCompletionOutputChunks(opts: {
  agentName: string;
  taskId: string;
  output: string;
}): string[] {
  const header = `✅ *${opts.agentName}* completed with output (${getTaskLink(opts.taskId)}):\n\n`;
  const slackOutput = markdownToSlack(opts.output.trim());
  return splitSlackSectionText(header + slackOutput);
}

export async function sendInlineTaskOutput(task: AgentTask): Promise<boolean> {
  const app = getSlackApp();
  if (!app || !task.slackChannelId || !task.slackThreadTs || !task.agentId || !task.output) {
    return false;
  }

  const agent = getAgentById(task.agentId);
  if (!agent) {
    console.error(`[Slack] Agent not found for task ${task.id}`);
    return false;
  }

  const chunks = formatInlineCompletionOutputChunks({
    agentName: agent.name,
    taskId: task.id,
    output: task.output,
  });

  try {
    for (let i = 0; i < chunks.length; i += MAX_INLINE_OUTPUT_BLOCKS_PER_MESSAGE) {
      const batch = chunks.slice(i, i + MAX_INLINE_OUTPUT_BLOCKS_PER_MESSAGE);
      await sendWithPersona(app.client, {
        channel: task.slackChannelId,
        thread_ts: task.slackThreadTs,
        text: batch.join("\n\n"),
        username: getAgentDisplayName(agent),
        icon_emoji: getAgentEmoji(agent),
        blocks: batch.map((chunk) => ({
          type: "section",
          text: { type: "mrkdwn", text: chunk },
        })),
      });
    }
    markTaskSlackReplySent(task.id);
    return true;
  } catch (error) {
    console.error(`[Slack] Failed to send inline output for task ${task.id}:`, error);
    return false;
  }
}

/**
 * Send a task completion message to Slack with the agent's persona.
 */
export async function sendTaskResponse(task: AgentTask): Promise<boolean> {
  const app = getSlackApp();
  if (!app || !task.slackChannelId || !task.slackThreadTs) {
    return false;
  }

  if (!task.agentId) {
    console.error(`[Slack] Task ${task.id} has no assigned agent`);
    return false;
  }

  const agent = getAgentById(task.agentId);
  if (!agent) {
    console.error(`[Slack] Agent not found for task ${task.id}`);
    return false;
  }

  const client = app.client;
  const agentName = agent.name;

  try {
    if (task.status === "completed") {
      const output = task.output || "Task completed.";
      const slackOutput = markdownToSlack(output);
      const attachmentsBlock = formatAttachmentsBlockForSlack(getTaskAttachments(task.id));
      const body = slackOutput + attachmentsBlock;
      const duration =
        task.finishedAt && task.createdAt
          ? formatDuration(new Date(task.createdAt), new Date(task.finishedAt))
          : undefined;
      console.log(
        `[Slack] sendTaskResponse: task=${task.id} slackReplySent=${!!task.slackReplySent} minimal=${!!task.slackReplySent}`,
      );
      const completionOpts = {
        agentName,
        taskId: task.id,
        body,
        duration,
        // When the agent already posted output via slack-reply, the header
        // card stays minimal. We still surface the attachments block as a
        // trailing addendum so links are visible without expanding the card.
        minimal: !!task.slackReplySent,
        trailer: task.slackReplySent ? attachmentsBlock : undefined,
      };
      const blockBatches = buildCompletedBlockBatches(completionOpts);
      for (let i = 0; i < blockBatches.length; i++) {
        await sendWithPersona(client, {
          channel: task.slackChannelId,
          thread_ts: task.slackThreadTs,
          text:
            task.slackReplySent || i > 0
              ? `✅ ${agentName} completed${i > 0 ? ` (continued ${i + 1}/${blockBatches.length})` : ""}`
              : body,
          username: getAgentDisplayName(agent),
          icon_emoji: getAgentEmoji(agent),
          blocks: blockBatches[i],
        });
      }
    } else if (task.status === "failed") {
      const reason = task.failureReason || "Unknown error";
      const blocks = buildFailedBlocks({ agentName, taskId: task.id, reason });
      await sendWithPersona(client, {
        channel: task.slackChannelId,
        thread_ts: task.slackThreadTs,
        text: `Task failed: ${reason}`,
        username: getAgentDisplayName(agent),
        icon_emoji: getAgentEmoji(agent),
        blocks,
      });
    }

    return true;
  } catch (error) {
    console.error(`[Slack] Failed to send response for task ${task.id}:`, error);
    return false;
  }
}

/**
 * Send a progress update to Slack. Returns the message ts for chat.update tracking.
 */
export async function sendProgressUpdate(
  task: AgentTask,
  progress: string,
): Promise<string | undefined> {
  const app = getSlackApp();
  if (!app || !task.slackChannelId || !task.slackThreadTs) {
    return undefined;
  }

  if (!task.agentId) return undefined;

  const agent = getAgentById(task.agentId);
  if (!agent) return undefined;

  const blocks = buildProgressBlocks({ agentName: agent.name, taskId: task.id, progress });

  try {
    return await sendWithPersona(app.client, {
      channel: task.slackChannelId,
      thread_ts: task.slackThreadTs,
      text: progress,
      username: getAgentDisplayName(agent),
      icon_emoji: getAgentEmoji(agent),
      blocks,
    });
  } catch (error) {
    console.error(`[Slack] Failed to send progress update:`, error);
    return undefined;
  }
}

/**
 * Update an existing progress message in-place via chat.update.
 */
export async function updateProgressInPlace(
  task: AgentTask,
  progress: string,
  messageTs: string,
): Promise<SlackUpdateResult> {
  const app = getSlackApp();
  if (!app || !task.slackChannelId || !task.agentId) return "failed";

  const agent = getAgentById(task.agentId);
  if (!agent) return "failed";

  const blocks = buildProgressBlocks({ agentName: agent.name, taskId: task.id, progress });

  try {
    const updatePayload = {
      channel: task.slackChannelId,
      ts: messageTs,
      text: progress,
      unfurl_links: false,
      unfurl_media: false,
      // biome-ignore lint/suspicious/noExplicitAny: Block Kit objects
      blocks: blocks as any,
    } satisfies ChatUpdatePayload;
    await app.client.chat.update(updatePayload);
    return "ok";
  } catch (error) {
    const result = classifySlackUpdateError(error);
    if (result === "not_found") {
      console.warn(
        `[Slack] Progress message missing for task ${task.id} ts=${messageTs}; will repost`,
      );
    } else {
      console.error(`[Slack] Failed to update progress in-place:`, error);
    }
    return result;
  }
}

/**
 * Update the task message to its final state (completed/failed) via chat.update.
 * Uses full blocks (not compact) since this is the only message for the task.
 */
export async function updateToFinal(task: AgentTask, messageTs: string): Promise<boolean> {
  const app = getSlackApp();
  if (!app || !task.slackChannelId || !task.agentId) return false;

  const agent = getAgentById(task.agentId);
  if (!agent) return false;

  const agentName = agent.name;
  let blocks: unknown[];
  let text: string;
  let completionBlockBatches: unknown[][] | undefined;

  if (task.status === "completed") {
    const output = task.output || "Task completed.";
    const slackOutput = markdownToSlack(output);
    const attachmentsBlock = formatAttachmentsBlockForSlack(getTaskAttachments(task.id));
    const body = slackOutput + attachmentsBlock;
    const duration =
      task.finishedAt && task.createdAt
        ? formatDuration(new Date(task.createdAt), new Date(task.finishedAt))
        : undefined;
    console.log(
      `[Slack] updateToFinal: task=${task.id} slackReplySent=${!!task.slackReplySent} minimal=${!!task.slackReplySent}`,
    );
    const completionOpts = {
      agentName,
      taskId: task.id,
      body,
      duration,
      minimal: !!task.slackReplySent,
      trailer: task.slackReplySent ? attachmentsBlock : undefined,
    };
    completionBlockBatches = buildCompletedBlockBatches(completionOpts);
    blocks = completionBlockBatches[0] ?? buildCompletedBlocks(completionOpts);
    text = task.slackReplySent ? `✅ ${agentName} completed` : body;
  } else if (task.status === "cancelled") {
    blocks = buildCancelledBlocks({ agentName, taskId: task.id });
    text = "Task cancelled";
  } else {
    const reason = task.failureReason || "Unknown error";
    blocks = buildFailedBlocks({ agentName, taskId: task.id, reason });
    text = `Task failed: ${reason}`;
  }

  try {
    const updatePayload = {
      channel: task.slackChannelId,
      ts: messageTs,
      text,
      unfurl_links: false,
      unfurl_media: false,
      // biome-ignore lint/suspicious/noExplicitAny: Block Kit objects
      blocks: blocks as any,
    } satisfies ChatUpdatePayload;
    await app.client.chat.update(updatePayload);

    if (completionBlockBatches) {
      for (let i = 1; i < completionBlockBatches.length; i++) {
        await sendWithPersona(app.client, {
          channel: task.slackChannelId,
          thread_ts: task.slackThreadTs ?? messageTs,
          text: `✅ ${agentName} completed (continued ${i + 1}/${completionBlockBatches.length})`,
          username: getAgentDisplayName(agent),
          icon_emoji: getAgentEmoji(agent),
          blocks: completionBlockBatches[i],
        });
      }
    }
    return true;
  } catch (error) {
    console.error(`[Slack] Failed to update task message to final state:`, error);
    return false;
  }
}

/**
 * Update a tree message directly with pre-built blocks via chat.update.
 * Used by the watcher's tree rendering loop (Phase 5).
 */
export async function updateTreeMessage(
  channelId: string,
  messageTs: string,
  blocks: unknown[],
  fallbackText: string,
): Promise<SlackUpdateResult> {
  const app = getSlackApp();
  if (!app) return "failed";

  try {
    const updatePayload = {
      channel: channelId,
      ts: messageTs,
      text: fallbackText,
      unfurl_links: false,
      unfurl_media: false,
      // biome-ignore lint/suspicious/noExplicitAny: Block Kit objects
      blocks: blocks as any,
    } satisfies ChatUpdatePayload;
    await app.client.chat.update(updatePayload);
    return "ok";
  } catch (error) {
    const result = classifySlackUpdateError(error);
    if (result === "not_found") {
      console.warn(
        `[Slack] Tree message missing for channel=${channelId} ts=${messageTs}; will repost`,
      );
    } else {
      console.error(`[Slack] Failed to update tree message:`, error);
    }
    return result;
  }
}

export async function sendWithPersona(
  client: WebClient,
  options: {
    channel: string;
    thread_ts: string;
    text: string;
    username: string;
    icon_emoji: string;
    blocks?: unknown[];
  },
): Promise<string | undefined> {
  const blocks = options.blocks ?? [
    { type: "section", text: { type: "mrkdwn", text: options.text } },
  ];

  const result = await client.chat.postMessage({
    channel: options.channel,
    thread_ts: options.thread_ts,
    text: options.text, // Fallback for notifications
    unfurl_links: false,
    unfurl_media: false,
    username: options.username,
    icon_emoji: options.icon_emoji,
    // biome-ignore lint/suspicious/noExplicitAny: Block Kit objects are typed as plain JSON
    blocks: blocks as any,
  });

  return result.ts;
}

export function getAgentEmoji(agent: Agent): string {
  if (agent.isLead) return ":crown:";

  // Generate consistent emoji based on agent name hash
  const emojis = [
    ":robot_face:",
    ":gear:",
    ":zap:",
    ":rocket:",
    ":star:",
    ":crystal_ball:",
    ":bulb:",
    ":wrench:",
  ];
  const hash = agent.name.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return emojis[hash % emojis.length] ?? ":robot_face:";
}
