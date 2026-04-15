import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import {
  createTaskExtended,
  getAgentById,
  getAgentWorkingOnThread,
  getLeadAgent,
  getMostRecentTaskInThread,
  getTasksByAgentId,
  resolveUser,
} from "../be/db";
import { resolveTemplate } from "../prompts/resolver";
import { workflowEventBus } from "../workflows/event-bus";
import { buildTreeBlocks, type TreeNode } from "./blocks";
import type { SlackFile } from "./files";
import { extractTaskFromMessage, routeMessage } from "./router";
// Side-effect import: registers all Slack event templates in the in-memory registry
import "./templates";
import { bufferThreadMessage, getBufferMessageCount, instantFlush } from "./thread-buffer";
import { registerTreeMessage } from "./watcher";

// User filtering configuration from environment variables
const allowedEmailDomains = (process.env.SLACK_ALLOWED_EMAIL_DOMAINS || "")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

const allowedUserIds = (process.env.SLACK_ALLOWED_USER_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const filteringEnabled = allowedEmailDomains.length > 0 || allowedUserIds.length > 0;

// Cache for user email lookups (to avoid repeated API calls)
const userEmailCache = new Map<string, string | null>();

/**
 * Configuration for user filtering.
 */
export interface UserFilterConfig {
  allowedEmailDomains: string[];
  allowedUserIds: string[];
}

/**
 * Core logic for checking if a user is allowed based on email and/or user ID.
 * Exported for testing.
 *
 * @param userId - The Slack user ID to check
 * @param email - The user's email address (or null if unknown)
 * @param config - The filtering configuration
 * @returns true if the user is allowed, false otherwise
 */
export function checkUserAccess(
  userId: string,
  email: string | null,
  config: UserFilterConfig,
): boolean {
  const { allowedEmailDomains: domains, allowedUserIds: userIds } = config;

  // If no filtering configured, allow all users (backwards compatible)
  if (domains.length === 0 && userIds.length === 0) {
    return true;
  }

  // Check user ID whitelist first (fast path)
  if (userIds.includes(userId)) {
    return true;
  }

  // No email domains configured and not in user whitelist
  if (domains.length === 0) {
    return false;
  }

  // No email available
  if (!email) {
    return false;
  }

  // Extract and validate domain
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) {
    return false;
  }

  return domains.includes(domain);
}

/**
 * Check if a user is allowed to interact with the swarm.
 * Returns true if filtering is disabled, user is in whitelist, or user's email domain is allowed.
 */
async function isUserAllowed(client: WebClient, userId: string): Promise<boolean> {
  // If no filtering configured, allow all users (backwards compatible)
  if (!filteringEnabled) {
    return true;
  }

  // Check user ID whitelist first (fast path)
  if (allowedUserIds.includes(userId)) {
    return true;
  }

  // No email domains configured and not in user whitelist
  if (allowedEmailDomains.length === 0) {
    return false;
  }

  // Check email domain
  let email = userEmailCache.get(userId);
  if (email === undefined) {
    try {
      const result = await client.users.info({ user: userId });
      email = result.user?.profile?.email || null;
      userEmailCache.set(userId, email);
    } catch (error) {
      console.error(`[Slack] Failed to fetch user email for ${userId}:`, error);
      userEmailCache.set(userId, null);
      email = null;
    }
  }

  if (!email) {
    console.log(`[Slack] User ${userId} has no email, denying access`);
    return false;
  }

  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) {
    console.log(`[Slack] User ${userId} has invalid email format, denying access`);
    return false;
  }

  const allowed = allowedEmailDomains.includes(domain);
  if (!allowed) {
    console.log(`[Slack] User ${userId} email domain "${domain}" not in allowed list`);
  }
  return allowed;
}

interface MessageEvent {
  type: string;
  subtype?: string;
  bot_id?: string;
  text?: string;
  user?: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  files?: SlackFile[];
  assistant_thread?: Record<string, unknown>;
}

/**
 * Check if a Slack message event is from a bot/agent.
 * Exported for testing.
 *
 * Bot messages can be identified by:
 * - `subtype === "bot_message"` (traditional Slack API)
 * - `bot_id` present (newer Slack API, may lack subtype)
 * - `user` matches the bot's own user ID (catches edge cases where
 *    messages posted with `username` override lack `bot_id`)
 */
export function isBotMessage(
  event: { subtype?: string; bot_id?: string; user?: string },
  botUserId?: string | null,
): boolean {
  if (event.subtype === "bot_message") return true;
  if (event.bot_id) return true;
  if (botUserId && event.user === botUserId) return true;
  return false;
}

interface ThreadMessage {
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  ts: string;
}

// Cache for bot's own user ID (avoids redundant auth.test calls)
let cachedBotUserId: string | null = null;

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

/**
 * Format a file size in bytes to a human-readable string.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Build a text representation of file attachments for inclusion in messages.
 * Each file is formatted as: [File: filename.ext (mimetype, size) id=FILE_ID]
 */
export function buildAttachmentText(files: SlackFile[]): string {
  return files
    .map((f) => `[File: ${f.name} (${f.mimetype}, ${formatFileSize(f.size)}) id=${f.id}]`)
    .join("\n");
}

/**
 * Build the effective message text from the original text and any file attachments.
 * - Text only: returns the text as-is
 * - Files only: returns the attachment metadata
 * - Both: returns text followed by attachment metadata
 */
export function buildEffectiveText(text: string | undefined, files?: SlackFile[]): string {
  const hasText = !!text?.trim();
  const hasFiles = files && files.length > 0;

  if (hasText && hasFiles) {
    return `${text}\n\n${buildAttachmentText(files)}`;
  }
  if (hasFiles) {
    return buildAttachmentText(files);
  }
  return text || "";
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
    const msg = event as MessageEvent;

    // Ignore message_changed events
    if (msg.subtype === "message_changed") return;

    // Cache bot user ID on first message (avoids calling auth.test on every event)
    if (!cachedBotUserId) {
      try {
        const authResult = await client.auth.test();
        cachedBotUserId = authResult.user_id as string;
      } catch (error) {
        console.error("[Slack] Failed to cache bot user ID:", error);
      }
    }

    // Ignore bot messages — checks subtype, bot_id, AND bot user ID.
    // The user ID check is critical: messages posted with `username` override
    // (e.g., via slack-reply tool) may not include bot_id in the event,
    // causing agent completion messages to be misidentified as human messages
    // and triggering duplicate task creation.
    if (isBotMessage(msg, cachedBotUserId)) {
      return;
    }
    const hasText = !!msg.text?.trim();
    const hasFiles = !!(msg.files && msg.files.length > 0);

    // Require either text or files, and always require a user
    if ((!hasText && !hasFiles) || !msg.user) return;

    // Deduplicate events (Slack can send same event twice)
    const messageKey = `${msg.channel}:${msg.ts}`;
    if (isMessageProcessed(messageKey)) {
      return;
    }

    // Check user authorization
    if (!(await isUserAllowed(client, msg.user))) {
      console.log(`[Slack] Ignoring message from unauthorized user ${msg.user}`);
      return;
    }

    // Resolve canonical user identity (graceful — null if not found)
    const requestedByUserId = resolveUser({ slackUserId: msg.user })?.id;

    // Emit workflow trigger event for Slack messages
    workflowEventBus.emit("slack.message", {
      channel: msg.channel,
      text: msg.text,
      user: msg.user,
      ts: msg.ts,
      threadTs: msg.thread_ts,
    });

    // Build effective text that includes attachment metadata
    const effectiveText = buildEffectiveText(msg.text, msg.files);

    // Bot user ID (already cached from the bot message check above)
    if (!cachedBotUserId) {
      console.error(
        "[Slack] Bot user ID unavailable — skipping message to avoid silent misbehavior",
      );
      return;
    }
    const botUserId = cachedBotUserId;

    // Check if bot was mentioned (in original text only)
    const botMentioned = !!msg.text?.includes(`<@${botUserId}>`);

    // Detect assistant thread context — file_share messages in DM assistant threads
    // bypass the assistant handler and land here instead. Treat them as implicit mentions
    // so they route to the lead agent rather than being silently dropped.
    const isAssistantThread = !!msg.assistant_thread;
    const isImplicitMention = isAssistantThread && !botMentioned;

    // ADDITIVE_SLACK: Check for !now command in threads
    const additiveSlack = process.env.ADDITIVE_SLACK === "true";
    const requireMentionForThreadFollowup =
      process.env.SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION === "true";
    if (additiveSlack && msg.thread_ts) {
      const stripped = effectiveText.replace(/<@[A-Z0-9]+>/g, "").trim();
      if (stripped.startsWith("!now")) {
        const nowMessage = stripped.replace(/^!now\s*/, "").trim();
        const threadKey = `${msg.channel}:${msg.thread_ts}`;

        console.log(
          `[Slack] !now command detected in thread ${threadKey}${nowMessage ? ` with message: "${nowMessage}"` : ""}`,
        );

        if (nowMessage) {
          bufferThreadMessage(msg.channel, msg.thread_ts, nowMessage, msg.user, msg.ts);
        }

        // Instant flush — no dependency
        await instantFlush(threadKey);

        try {
          await client.reactions.add({ channel: msg.channel, name: "zap", timestamp: msg.ts });
        } catch (e) {
          console.log(`[Slack] Reaction failed: ${e instanceof Error ? e.message : e}`);
        }

        return;
      }
    }

    // ADDITIVE_SLACK: Buffer non-mention thread messages
    if (additiveSlack && !botMentioned && msg.thread_ts && !requireMentionForThreadFollowup) {
      // Check if this thread has any swarm activity (existing tasks)
      const hasSwarmActivity = getAgentWorkingOnThread(msg.channel, msg.thread_ts) !== null;

      if (hasSwarmActivity) {
        const threadKey = `${msg.channel}:${msg.thread_ts}`;
        bufferThreadMessage(msg.channel, msg.thread_ts, effectiveText, msg.user, msg.ts);

        // Slack feedback: react with :eyes: on first buffer, :heavy_plus_sign: on appends
        const count = getBufferMessageCount(threadKey);
        console.log(
          `[Slack] Additive buffer: ${threadKey} (message #${count}, reaction: ${count === 1 ? "eyes" : "heavy_plus_sign"})`,
        );
        try {
          await client.reactions.add({
            channel: msg.channel,
            name: count === 1 ? "eyes" : "heavy_plus_sign",
            timestamp: msg.ts,
          });
        } catch (e) {
          console.log(`[Slack] Reaction failed: ${e instanceof Error ? e.message : e}`);
        }

        return; // Don't process further — buffer will flush
      }
    }

    // Route message to agents (use original text for routing to preserve mention/name matching)
    const routingText = msg.text || effectiveText;
    const routingThreadContext = msg.thread_ts
      ? { channelId: msg.channel, threadTs: msg.thread_ts }
      : undefined;
    const matches = routeMessage(
      routingText,
      botUserId,
      botMentioned || isImplicitMention,
      routingThreadContext,
    );

    if (matches.length === 0) {
      if (!botMentioned && !isImplicitMention) return;

      // Bot was mentioned (or message is in assistant thread) but no online agents matched — queue the request
      if (!checkRateLimit(msg.user)) {
        await say({
          text: ":satellite: _You're sending too many requests. Please slow down._",
          thread_ts: msg.thread_ts || msg.ts,
        });
        return;
      }

      const taskDescription = isImplicitMention
        ? effectiveText
        : extractTaskFromMessage(effectiveText, botUserId);
      if (!taskDescription) {
        if (!isImplicitMention) {
          await say({
            text: ":satellite: _Please provide a task description after mentioning an agent._",
            thread_ts: msg.thread_ts || msg.ts,
          });
        }
        return;
      }

      const threadTs = msg.thread_ts || msg.ts;
      const threadContext = await getThreadContext(
        client,
        msg.channel,
        msg.thread_ts,
        msg.ts,
        botUserId,
      );
      let fullTaskDescription: string;
      if (threadContext) {
        const ctxResult = resolveTemplate("slack.message.thread_context", {
          thread_messages: threadContext,
        });
        fullTaskDescription = `${ctxResult.text}\n\n${taskDescription}`;
      } else {
        fullTaskDescription = taskDescription;
      }

      const lead = getLeadAgent();
      createTaskExtended(fullTaskDescription, {
        agentId: lead?.id,
        source: "slack",
        slackChannelId: msg.channel,
        slackThreadTs: threadTs,
        slackUserId: msg.user,
        requestedByUserId,
      });

      await say({
        text: ":satellite: _No agents are online right now. Your request has been queued and will be processed when agents come back up._",
        thread_ts: threadTs,
      });
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

    // Extract task description (using effective text which includes attachment metadata)
    const taskDescription = extractTaskFromMessage(effectiveText, botUserId);
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
    let fullTaskDescription: string;
    if (threadContext) {
      const ctxResult = resolveTemplate("slack.message.thread_context", {
        thread_messages: threadContext,
      });
      fullTaskDescription = `${ctxResult.text}\n\n${taskDescription}`;
    } else {
      fullTaskDescription = taskDescription;
    }
    const results: {
      assigned: Array<{ agentName: string; taskId: string }>;
      queued: Array<{ agentName: string; taskId: string }>;
      failed: Array<{ agentName: string; reason: string }>;
    } = { assigned: [], queued: [], failed: [] };

    for (const match of matches) {
      const agent = getAgentById(match.agent.id);

      if (!agent) {
        results.failed.push({ agentName: match.agent.name, reason: "not found" });
        continue;
      }

      try {
        const latestTask = getMostRecentTaskInThread(msg.channel, threadTs);
        if (agent.isLead) {
          const task = createTaskExtended(fullTaskDescription, {
            agentId: agent.id,
            source: "slack",
            slackChannelId: msg.channel,
            slackThreadTs: threadTs,
            slackUserId: msg.user,
            parentTaskId: latestTask?.id,
            requestedByUserId,
          });
          results.assigned.push({ agentName: agent.name, taskId: task.id });
          continue;
        }

        // Workers receive tasks as before
        const task = createTaskExtended(fullTaskDescription, {
          agentId: agent.id,
          source: "slack",
          slackChannelId: msg.channel,
          slackThreadTs: threadTs,
          slackUserId: msg.user,
          requestedByUserId,
        });

        // Check if agent has an in-progress task in this thread (queued follow-up)
        const agentTasks = getTasksByAgentId(agent.id);
        const inProgressInThread = agentTasks.find(
          (t) => t.id !== task.id && t.status === "in_progress" && t.slackThreadTs === threadTs,
        );

        if (inProgressInThread) {
          results.queued.push({ agentName: agent.name, taskId: task.id });
        } else {
          results.assigned.push({ agentName: agent.name, taskId: task.id });
        }
      } catch {
        results.failed.push({ agentName: agent.name, reason: "error" });
      }
    }

    // Send consolidated summary as initial tree with Block Kit
    const totalResults = results.assigned.length + results.queued.length + results.failed.length;
    if (totalResults > 0) {
      // Build initial tree nodes from assignment results
      const initialNodes: TreeNode[] = results.assigned.map(({ agentName, taskId }) => ({
        taskId,
        agentName,
        status: "in_progress" as const,
        children: [],
      }));

      // Add queued tasks
      for (const q of results.queued) {
        initialNodes.push({
          taskId: q.taskId,
          agentName: q.agentName,
          status: "pending" as const,
          children: [],
        });
      }

      const blocks = buildTreeBlocks(initialNodes);

      // Append failed assignment lines as context below the tree
      if (results.failed.length > 0) {
        const failedLines = results.failed
          .map((f) => `⚠️ Could not assign to: *${f.agentName}* — ${f.reason}`)
          .join("\n");
        blocks.push({
          type: "context",
          elements: [{ type: "mrkdwn", text: failedLines }],
        });
      }

      // Build plain-text fallback
      const parts: string[] = [];
      if (results.assigned.length > 0) {
        const names = results.assigned.map((a) => `${a.agentName}`).join(", ");
        parts.push(`Task assigned to: ${names}`);
      }
      if (results.queued.length > 0) {
        const names = results.queued.map((q) => `${q.agentName}`).join(", ");
        parts.push(`Task queued for: ${names}`);
      }
      if (results.failed.length > 0) {
        const names = results.failed.map((f) => `${f.agentName}`).join(", ");
        parts.push(`Could not assign to: ${names}`);
      }

      console.log(
        `[Slack] Posting initial tree message with ${initialNodes.length} node(s)${results.failed.length > 0 ? ` and ${results.failed.length} failed assignment(s)` : ""}`,
      );

      const resp = await say({
        text: parts.join(". "),
        blocks,
        thread_ts: msg.thread_ts || msg.ts,
      });

      // Register the tree message so the watcher can update it in-place
      // (assignment → progress → completion all in one evolving tree message)
      if (resp?.ts) {
        for (const { taskId } of results.assigned) {
          registerTreeMessage(taskId, msg.channel, threadTs, resp.ts);
        }
        // Also register queued tasks so they appear in the tree when they start
        for (const { taskId } of results.queued) {
          registerTreeMessage(taskId, msg.channel, threadTs, resp.ts);
        }
      }
    }
  });

  // Handle app_mention events specifically
  app.event("app_mention", async ({ event }) => {
    // app_mention is already handled by the message event above
    // but we can add specific behavior here if needed
    console.log(`[Slack] App mentioned in channel ${event.channel}`);
  });
}
