import type { WebClient } from "@slack/web-api";
import { getAgentById } from "../be/db";
import type { Agent, AgentTask } from "../types";
import { getSlackApp } from "./app";

const isDev = process.env.ENV === "development";
const appUrl = process.env.APP_URL || "";

/**
 * Convert GitHub-flavored markdown to Slack mrkdwn format.
 */
function markdownToSlack(text: string): string {
  return (
    text
      // Headers to bold (# Header -> *Header*)
      .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
      // Bold **text** -> *text*
      .replace(/\*\*(.+?)\*\*/g, "*$1*")
      // Links [text](url) -> <url|text>
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>")
      // Inline code already works the same
      // Bullet points already work the same
      // Remove excessive blank lines
      .replace(/\n{3,}/g, "\n\n")
  );
}

/**
 * Get the display name for an agent, with (dev) prefix if in development mode.
 */
function getAgentDisplayName(agent: Agent): string {
  return isDev ? `(dev) ${agent.name}` : agent.name;
}

/**
 * Get a link to the task in the dashboard, or just the task ID if no APP_URL.
 */
function getTaskLink(taskId: string): string {
  const shortId = taskId.slice(0, 8);
  if (appUrl) {
    return `<${appUrl}?tab=tasks&task=${taskId}&expand=true|\`${shortId}\`>`;
  }
  return `\`${shortId}\``;
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
  const taskLink = getTaskLink(task.id);
  const footer = `_Check the full logs at ${taskLink}_`;

  try {
    if (task.status === "completed") {
      const output = task.output || "_Task completed._";
      const slackOutput = markdownToSlack(output);
      await sendWithPersona(client, {
        channel: task.slackChannelId,
        thread_ts: task.slackThreadTs,
        text: `${slackOutput}\n\n${footer}`,
        username: getAgentDisplayName(agent),
        icon_emoji: getAgentEmoji(agent),
      });
    } else if (task.status === "failed") {
      const reason = task.failureReason || "Unknown error";
      await sendWithPersona(client, {
        channel: task.slackChannelId,
        thread_ts: task.slackThreadTs,
        text: `:x: *Task failed*\n\`\`\`${reason}\`\`\`\n${footer}`,
        username: getAgentDisplayName(agent),
        icon_emoji: getAgentEmoji(agent),
      });
    }

    return true;
  } catch (error) {
    console.error(`[Slack] Failed to send response for task ${task.id}:`, error);
    return false;
  }
}

/**
 * Send a progress update to Slack.
 */
export async function sendProgressUpdate(task: AgentTask, progress: string): Promise<boolean> {
  const app = getSlackApp();
  if (!app || !task.slackChannelId || !task.slackThreadTs) {
    return false;
  }

  if (!task.agentId) return false;

  const agent = getAgentById(task.agentId);
  if (!agent) return false;

  const taskLink = getTaskLink(task.id);
  const footer = `_Check progress at ${taskLink}_`;

  try {
    await sendWithPersona(app.client, {
      channel: task.slackChannelId,
      thread_ts: task.slackThreadTs,
      text: `:hourglass_flowing_sand: _${progress}_\n\n${footer}`,
      username: getAgentDisplayName(agent),
      icon_emoji: getAgentEmoji(agent),
    });
    return true;
  } catch (error) {
    console.error(`[Slack] Failed to send progress update:`, error);
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
  },
): Promise<void> {
  await client.chat.postMessage({
    channel: options.channel,
    thread_ts: options.thread_ts,
    text: options.text, // Fallback for notifications
    username: options.username,
    icon_emoji: options.icon_emoji,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: options.text,
        },
      },
    ],
  });
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
