import type { WebClient } from "@slack/web-api";
import { getAgentById } from "../be/db";
import type { Agent, AgentTask } from "../types";
import { getSlackApp } from "./app";
import {
  buildCancelledBlocks,
  buildCompletedBlocks,
  buildFailedBlocks,
  buildProgressBlocks,
  markdownToSlack,
} from "./blocks";

// Re-export for backward compatibility
export { markdownToSlack } from "./blocks";

const isDev = process.env.ENV === "development";

/**
 * Get the display name for an agent, with (dev) prefix if in development mode.
 */
function getAgentDisplayName(agent: Agent): string {
  return isDev ? `(dev) ${agent.name}` : agent.name;
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
      const blocks = buildCompletedBlocks({ agentName, taskId: task.id, body: slackOutput });
      await sendWithPersona(client, {
        channel: task.slackChannelId,
        thread_ts: task.slackThreadTs,
        text: slackOutput,
        username: getAgentDisplayName(agent),
        icon_emoji: getAgentEmoji(agent),
        blocks,
      });
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
): Promise<boolean> {
  const app = getSlackApp();
  if (!app || !task.slackChannelId || !task.agentId) return false;

  const agent = getAgentById(task.agentId);
  if (!agent) return false;

  const blocks = buildProgressBlocks({ agentName: agent.name, taskId: task.id, progress });

  try {
    await app.client.chat.update({
      channel: task.slackChannelId,
      ts: messageTs,
      text: progress,
      // biome-ignore lint/suspicious/noExplicitAny: Block Kit objects
      blocks: blocks as any,
    });
    return true;
  } catch (error) {
    console.error(`[Slack] Failed to update progress in-place:`, error);
    return false;
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

  if (task.status === "completed") {
    const output = task.output || "Task completed.";
    const slackOutput = markdownToSlack(output);
    blocks = buildCompletedBlocks({ agentName, taskId: task.id, body: slackOutput });
    text = slackOutput;
  } else if (task.status === "cancelled") {
    blocks = buildCancelledBlocks({ agentName, taskId: task.id });
    text = "Task cancelled";
  } else {
    const reason = task.failureReason || "Unknown error";
    blocks = buildFailedBlocks({ agentName, taskId: task.id, reason });
    text = `Task failed: ${reason}`;
  }

  try {
    await app.client.chat.update({
      channel: task.slackChannelId,
      ts: messageTs,
      text,
      // biome-ignore lint/suspicious/noExplicitAny: Block Kit objects
      blocks: blocks as any,
    });
    return true;
  } catch (error) {
    console.error(`[Slack] Failed to update task message to final state:`, error);
    return false;
  }
}

async function sendWithPersona(
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

  // Skip persona overrides in DM channels (assistant threads use the app's own identity)
  const isDM = options.channel.startsWith("D");

  const result = await client.chat.postMessage({
    channel: options.channel,
    thread_ts: options.thread_ts,
    text: options.text, // Fallback for notifications
    ...(isDM ? {} : { username: options.username, icon_emoji: options.icon_emoji }),
    // biome-ignore lint/suspicious/noExplicitAny: Block Kit objects are typed as plain JSON
    blocks: blocks as any,
  });

  return result.ts;
}

function getAgentEmoji(agent: Agent): string {
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
