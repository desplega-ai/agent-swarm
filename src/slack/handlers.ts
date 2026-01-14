import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { createInboxMessage, createTask, getAgentById, getTasksByAgentId } from "../be/db";
import { extractTaskFromMessage, routeMessage } from "./router";

interface MessageEvent {
  type: string;
  subtype?: string;
  text?: string;
  user?: string;
  channel: string;
  ts: string;
  thread_ts?: string;
}

interface ThreadMessage {
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  ts: string;
}

// Cache for user display names
const userNameCache = new Map<string, string>();

async function getUserDisplayName(client: WebClient, userId: string): Promise<string> {
  if (userNameCache.has(userId)) {
    return userNameCache.get(userId)!;
  }
  try {
    const result = await client.users.info({ user: userId });
    const name = result.user?.profile?.display_name || result.user?.real_name || userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

/**
 * Fetch thread history and format as context for the task.
 * Returns empty string if not in a thread or no previous messages.
 */
async function getThreadContext(
  client: WebClient,
  channel: string,
  threadTs: string | undefined,
  currentTs: string,
  botUserId: string,
): Promise<string> {
  // Not in a thread - no context needed
  if (!threadTs) return "";

  try {
    const result = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 20, // Last 20 messages max
    });

    const messages = (result.messages || []) as ThreadMessage[];
    // Filter out the current message only (keep bot messages for context)
    const previousMessages = messages.filter((m) => m.ts !== currentTs && m.text);

    if (previousMessages.length === 0) return "";

    // Format messages with user names or [Agent] for bot messages
    const formattedMessages: string[] = [];
    for (const m of previousMessages) {
      // Check if this is a bot/agent message (multiple ways to identify)
      const isBotMessage =
        m.user === botUserId || m.bot_id !== undefined || m.subtype === "bot_message";

      if (isBotMessage) {
        // Bot/agent message - truncate if too long
        const truncatedText = m.text && m.text.length > 500 ? `${m.text.slice(0, 500)}...` : m.text;
        formattedMessages.push(`[Agent]: ${truncatedText}`);
      } else {
        const userName = m.user ? await getUserDisplayName(client, m.user) : "Unknown";
        formattedMessages.push(`${userName}: ${m.text}`);
      }
    }

    return formattedMessages.join("\n");
  } catch (error) {
    console.error("[Slack] Failed to fetch thread context:", error);
    return "";
  }
}

const appUrl = process.env.APP_URL || "";

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

// Message deduplication (prevents duplicate event processing)
const processedMessages = new Set<string>();
const MESSAGE_DEDUP_TTL = 60_000; // 1 minute

function isMessageProcessed(messageKey: string): boolean {
  if (processedMessages.has(messageKey)) {
    console.log(`[Slack] Duplicate event detected: ${messageKey}`);
    return true;
  }
  processedMessages.add(messageKey);
  setTimeout(() => processedMessages.delete(messageKey), MESSAGE_DEDUP_TTL);
  console.log(`[Slack] Processing new message: ${messageKey}`);
  return false;
}

// Rate limiting
const rateLimitMap = new Map<string, number>();
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 10;

function checkRateLimit(userId: string): boolean {
  const userRequests = rateLimitMap.get(userId) || 0;

  if (userRequests >= MAX_REQUESTS_PER_WINDOW) {
    return false;
  }

  rateLimitMap.set(userId, userRequests + 1);

  // Decrement after window
  setTimeout(() => {
    const current = rateLimitMap.get(userId) || 0;
    if (current > 0) {
      rateLimitMap.set(userId, current - 1);
    }
  }, RATE_LIMIT_WINDOW);

  return true;
}

export function registerMessageHandler(app: App): void {
  // Handle all message events
  app.event("message", async ({ event, client, say }) => {
    // Ignore bot messages and message_changed events
    if (
      "subtype" in event &&
      (event.subtype === "bot_message" || event.subtype === "message_changed")
    ) {
      return;
    }

    const msg = event as MessageEvent;
    if (!msg.text || !msg.user) return;

    // Deduplicate events (Slack can send same event twice)
    const messageKey = `${msg.channel}:${msg.ts}`;
    if (isMessageProcessed(messageKey)) {
      return;
    }

    // Get bot's user ID
    const authResult = await client.auth.test();
    const botUserId = authResult.user_id as string;

    // Check if bot was mentioned
    const botMentioned = msg.text.includes(`<@${botUserId}>`);

    // Build thread context for routing (if we're in a thread)
    const routingThreadContext = msg.thread_ts
      ? { channelId: msg.channel, threadTs: msg.thread_ts }
      : undefined;

    // Route message to agents
    const matches = routeMessage(msg.text, botUserId, botMentioned, routingThreadContext);

    if (matches.length === 0) {
      // No agents matched - ignore message unless bot was directly mentioned
      if (botMentioned) {
        await say({
          text: ":satellite: _No agents are currently available. Use `/agent-swarm-status` to check the swarm._",
          thread_ts: msg.thread_ts || msg.ts,
        });
      }
      return;
    }

    // Rate limit check
    if (!checkRateLimit(msg.user)) {
      await say({
        text: ":satellite: _You're sending too many requests. Please slow down._",
        thread_ts: msg.thread_ts || msg.ts,
      });
      return;
    }

    // Extract task description
    const taskDescription = extractTaskFromMessage(msg.text, botUserId);
    if (!taskDescription) {
      await say({
        text: ":satellite: _Please provide a task description after mentioning an agent._",
        thread_ts: msg.thread_ts || msg.ts,
      });
      return;
    }

    // Create tasks for each matched agent
    const threadTs = msg.thread_ts || msg.ts;

    // Fetch thread context if in a thread
    const threadContext = await getThreadContext(
      client,
      msg.channel,
      msg.thread_ts,
      msg.ts,
      botUserId,
    );
    // Structure content with clear separation for inbox messages
    const structuredContent = threadContext
      ? `<new_message>\n${taskDescription}\n</new_message>\n\n<thread_history>\n${threadContext}\n</thread_history>`
      : taskDescription;
    // For workers (tasks), keep using the old format for backwards compatibility
    const fullTaskDescription = threadContext
      ? `<thread_context>\n${threadContext}\n</thread_context>\n\n${taskDescription}`
      : taskDescription;
    const results: { assigned: string[]; queued: string[]; failed: string[] } = {
      assigned: [],
      queued: [],
      failed: [],
    };

    for (const match of matches) {
      const agent = getAgentById(match.agent.id);

      if (!agent) {
        results.failed.push(`\`${match.agent.name}\` (not found)`);
        continue;
      }

      try {
        // Lead agents receive inbox messages, not tasks
        if (agent.isLead) {
          createInboxMessage(agent.id, structuredContent, {
            source: "slack",
            slackChannelId: msg.channel,
            slackThreadTs: threadTs,
            slackUserId: msg.user,
            matchedText: match.matchedText,
          });
          results.assigned.push(`*${agent.name}* (inbox)`);
          continue;
        }

        // Workers receive tasks as before
        const task = createTask(agent.id, fullTaskDescription, {
          source: "slack",
          slackChannelId: msg.channel,
          slackThreadTs: threadTs,
          slackUserId: msg.user,
        });

        // Check if agent has an in-progress task in this thread (queued follow-up)
        const agentTasks = getTasksByAgentId(agent.id);
        const inProgressInThread = agentTasks.find(
          (t) => t.id !== task.id && t.status === "in_progress" && t.slackThreadTs === threadTs,
        );

        if (inProgressInThread) {
          results.queued.push(`*${agent.name}* (${getTaskLink(task.id)})`);
        } else {
          results.assigned.push(`*${agent.name}* (${getTaskLink(task.id)})`);
        }
      } catch {
        results.failed.push(`\`${agent.name}\` (error)`);
      }
    }

    // Send consolidated summary
    const parts: string[] = [];
    if (results.assigned.length > 0) {
      parts.push(`:satellite: _Task assigned to: ${results.assigned.join(", ")}_`);
    }
    if (results.queued.length > 0) {
      parts.push(`:satellite: _Task queued for: ${results.queued.join(", ")}_`);
    }
    if (results.failed.length > 0) {
      parts.push(`:satellite: _Could not assign to: ${results.failed.join(", ")}_`);
    }

    if (parts.length > 0) {
      await say({
        text: parts.join("\n"),
        thread_ts: msg.thread_ts || msg.ts,
      });
    }
  });

  // Handle app_mention events specifically
  app.event("app_mention", async ({ event }) => {
    // app_mention is already handled by the message event above
    // but we can add specific behavior here if needed
    console.log(`[Slack] App mentioned in channel ${event.channel}`);
  });
}
