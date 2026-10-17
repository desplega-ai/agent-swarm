import type { Adapter, Message, Thread } from "chat";
import { z } from "zod";
import {
  getAgentById,
  getAllAgents,
  getLatestActiveTaskByContextKey,
  getLatestTaskByContextKey,
  getLeadAgent,
  isExtensionAgent,
} from "@/be/db";
import { dispatchPre } from "@/extensions/dispatcher";
import { resolveTemplate } from "@/prompts/resolver";
import { chatSdkContextKey } from "@/tasks/context-key";
import { TaskCreationBlockedError } from "@/tasks/errors";
import type { CreateTaskOptions } from "@/types";
import { scrubSecrets } from "@/utils/secret-scrubber";
import { getExecutorRegistry } from "@/workflows";
import { workflowEventBus } from "@/workflows/event-bus";
import { handleWebhookTrigger } from "@/workflows/triggers";
import {
  buildChatAttachmentText,
  createChatTaskWithFiles,
  fetchChatFiles,
  toChatFiles,
} from "./attachments";
import { getChatThreadResetAt } from "./commands";
import { errorMessage } from "./logger";
import { emitChatMessageSent } from "./outbound";
import {
  type ChatAgentMatch,
  type ChatRouteTarget,
  routeChatMessage,
  stripRoutingTokens,
} from "./router";
import { getChatInstance } from "./runtime";
import { readPersistedThreadHistory } from "./state";
import { formatChatSteeringAck, requestChatThreadSteering } from "./steering";
import {
  bufferChatMessage,
  type ChatBufferedMessage,
  instantFlushChat,
  isChatThreadBuffered,
} from "./thread-buffer";
import { startTypingKeepalive, stopTypingKeepalive } from "./typing";
// Side-effect import: registers the Chat SDK prompt templates.
import "./templates";

export type ChatInboundKind = "mention" | "dm" | "subscribed";

/** Runtime check for `pre.chat.route` modifications (mirrors `ChatRouteModify`). */
export const ChatRouteModifySchema = z
  .object({
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("agent"), agentId: z.string().min(1) }).strict(),
      z.object({ kind: z.literal("lead") }).strict(),
      z.object({ kind: z.literal("broadcast") }).strict(),
      z.object({ kind: z.literal("workflow"), workflowId: z.string().min(1) }).strict(),
    ]),
  })
  .strict();

const THREAD_CONTEXT_LIMIT = 20;
const AGENT_MESSAGE_TRUNCATE = 500;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Remove the bot's own `@name` / `<@id>` mention; other mentions stay. */
function stripBotMention(text: string, adapter: Adapter): string {
  let out = text;
  if (adapter.userName) {
    out = out.replace(new RegExp(`(?<!\\w)@${escapeRegex(adapter.userName)}(?![\\w-])`, "gi"), "");
  }
  if (adapter.botUserId) {
    out = out.replace(new RegExp(`<@${escapeRegex(adapter.botUserId)}>`, "g"), "");
  }
  return out.trim();
}

/** The adapter name is the thread id's first segment; the rest of the id is opaque. */
function adapterOf(threadId: string): string {
  const i = threadId.indexOf(":");
  return i === -1 ? threadId : threadId.slice(0, i);
}

/**
 * Entry point for every human message the SDK hands to the swarm. Steering is
 * tried whatever the handler kind: the SDK routes a DM to `onDirectMessage`
 * even when its thread is subscribed. Everything else goes through the buffer.
 */
export async function handleChatInbound(
  thread: Thread,
  message: Message,
  kind: ChatInboundKind,
): Promise<void> {
  const adapter = thread.adapter.name;
  workflowEventBus.emit("chat.message.received", {
    adapter,
    channelId: thread.channelId,
    threadId: thread.id,
    userId: message.author.userId,
    text: message.text,
    messageId: message.id,
  });

  let text = stripBotMention(message.text ?? "", thread.adapter);
  const immediate = /^!now\b/i.test(text);
  if (immediate) text = text.replace(/^!now\s*/i, "").trim();
  const attachments = message.attachments ?? [];

  // A thread with messages already waiting keeps its order: append, do not steer past them.
  if (!immediate && attachments.length === 0 && text && !isChatThreadBuffered(thread.id)) {
    const steering = await requestChatThreadSteering({
      contextKey: chatSdkContextKey(thread.id),
      message: text,
    });
    if (steering) {
      console.log(
        `[chat-sdk] ${adapter} message steered task ${steering.task.id} (${steering.result.outcome})`,
      );
      try {
        const ack = formatChatSteeringAck(steering.result);
        // Telegram threads the ack under the steering message; other adapters post it.
        const sent = thread.adapter.reply
          ? await thread.reply(message, { markdown: ack })
          : await thread.post({ markdown: ack });
        emitChatMessageSent({
          adapter,
          channelId: thread.channelId,
          threadId: thread.id,
          text: ack,
          taskId: steering.task.id,
          messageId: sent.id,
        });
        // The acknowledgement is the reply to this message.
        stopTypingKeepalive(thread.id);
      } catch (error) {
        console.warn(
          `[chat-sdk] Could not post the steering acknowledgement: ${errorMessage(error)}`,
        );
      }
      return;
    }
  }

  if (text || attachments.length > 0) {
    bufferChatMessage(thread.id, {
      messageId: message.id,
      channelId: thread.channelId,
      text,
      userId: message.author.userId,
      userName: message.author.userName || undefined,
      botMentioned: kind === "mention" || message.isMention === true,
      isDirectMessage: kind === "dm" || thread.isDM,
      attachments,
    });
    // Subscribed-thread messages may be dropped by the router at flush time;
    // they get typing once a task exists (see flushChatThread).
    if (kind !== "subscribed") startTypingKeepalive(adapter, thread.id);
  }
  if (immediate) await instantFlushChat(thread.id);
}

/**
 * Earlier messages of the thread for the task description, minus the flushed
 * ones and anything before the last `/reset`. The adapter's view is merged with
 * the history the SDK persisted: Telegram answers from process memory, which an
 * adapter restart (API restart, config reload) empties.
 */
async function getChatThreadContext(
  thread: Thread,
  exclude: ReadonlySet<string>,
  since: Date | null,
): Promise<string> {
  try {
    await thread.refresh();
    const byId = new Map<string, Message>();
    for (const m of await readPersistedThreadHistory(thread.id)) byId.set(m.id, m);
    for (const m of thread.recentMessages) byId.set(m.id, m);
    return [...byId.values()]
      .sort((a, b) => a.metadata.dateSent.getTime() - b.metadata.dateSent.getTime())
      .filter((m) => !exclude.has(m.id) && m.text.trim() !== "")
      .filter((m) => since === null || m.metadata.dateSent.getTime() > since.getTime())
      .slice(-THREAD_CONTEXT_LIMIT)
      .map((m) => {
        if (m.author.isMe || m.author.isBot === true) {
          const truncated =
            m.text.length > AGENT_MESSAGE_TRUNCATE
              ? `${m.text.slice(0, AGENT_MESSAGE_TRUNCATE)}...`
              : m.text;
          return `[Agent]: ${truncated}`;
        }
        return `${m.author.userName || m.author.fullName || m.author.userId}: ${m.text}`;
      })
      .join("\n");
  } catch (error) {
    console.warn(`[chat-sdk] Could not read thread context: ${errorMessage(error)}`);
    return "";
  }
}

/** Apply a `pre.chat.route` modification, or null to fall back to the built-in router. */
async function targetFromExtension(
  target: z.infer<typeof ChatRouteModifySchema>["target"],
): Promise<ChatRouteTarget | null> {
  switch (target.kind) {
    case "workflow":
      return { kind: "workflow", workflowId: target.workflowId };
    case "broadcast": {
      const matches = (await getAllAgents())
        .filter((agent) => !agent.isLead)
        .map(
          (agent): ChatAgentMatch => ({ agent, reason: "human_pinned", matchedText: "extension" }),
        );
      if (matches.length === 0) {
        console.warn("[chat-sdk] Extension broadcast target matched no agents; message dropped");
      }
      return { kind: "agents", matches };
    }
    case "lead": {
      const lead = await getLeadAgent();
      if (lead) {
        return {
          kind: "agents",
          matches: [{ agent: lead, reason: "human_pinned", matchedText: "extension" }],
        };
      }
      console.warn("[chat-sdk] Extension selected the lead, but no lead exists. Using the router.");
      return null;
    }
    case "agent": {
      const agent = await getAgentById(target.agentId);
      if (agent && !isExtensionAgent(agent)) {
        return {
          kind: "agents",
          matches: [{ agent, reason: "human_pinned", matchedText: "extension" }],
        };
      }
      console.warn(
        scrubSecrets(
          `[chat-sdk] Extension selected ${agent ? "an extension-identity" : "an unknown"} agent ${target.agentId}. Using the router.`,
        ),
      );
      return null;
    }
  }
}

/**
 * Buffer flush: one routed decision for every message the thread collected.
 * Runs outside any transaction, so `pre.chat.route` is dispatched here, after
 * the flush and before any task exists.
 */
export async function flushChatThread(
  threadId: string,
  items: ChatBufferedMessage[],
  immediate: boolean,
): Promise<void> {
  const first = items[0];
  if (!first) return;
  const adapter = adapterOf(threadId);
  const contextKey = chatSdkContextKey(threadId);
  const thread = getChatInstance(adapter)?.thread(threadId);
  const rawText = items
    .map((item) => item.text)
    .filter(Boolean)
    .join("\n---\n");
  const botMentioned = items.some((item) => item.botMentioned);
  const isDirectMessage = items.some((item) => item.isDirectMessage);

  // After `/reset` the thread's earlier tasks are not context: the new task gets
  // no parent and no thread history older than the reset.
  const resetAt = await getChatThreadResetAt(threadId);
  const previousTask = await getLatestTaskByContextKey(contextKey);
  const mostRecentTask =
    previousTask && resetAt && new Date(previousTask.createdAt).getTime() <= resetAt.getTime()
      ? null
      : previousTask;
  const routeResult = await dispatchPre(
    "pre.chat.route",
    {
      adapter,
      channelId: first.channelId,
      threadId,
      userId: first.userId,
      ...(first.userName ? { userName: first.userName } : {}),
      text: rawText,
      botMentioned,
      isDirectMessage,
      ...(mostRecentTask ? { threadContext: { adapter, threadId } } : {}),
    },
    {
      // A runtime-invalid target is an extension failure, not a routing input.
      validateModify: (data) => {
        const parsed = ChatRouteModifySchema.safeParse(data);
        return parsed.success
          ? { success: true, data: parsed.data }
          : { success: false, error: new Error(parsed.error.message) };
      },
    },
  );
  if (routeResult.action === "block") {
    console.info(
      `[chat-sdk] Extension blocked routing for ${threadId}:`,
      scrubSecrets(routeResult.reason),
    );
    stopTypingKeepalive(threadId);
    return;
  }

  let target: ChatRouteTarget | null = null;
  if (routeResult.action === "modify") target = await targetFromExtension(routeResult.data.target);
  target ??= await routeChatMessage(rawText, {
    adapter,
    channelId: first.channelId,
    threadId,
    botMentioned,
    isDirectMessage,
  });
  if (!target) {
    console.log(`[chat-sdk] ${threadId}: message not addressed to the swarm, ignored`);
    stopTypingKeepalive(threadId);
    return;
  }

  if (target.kind === "workflow") {
    // A workflow run has no relay that would stop the indicator.
    stopTypingKeepalive(threadId);
    try {
      // The adapter verified the platform signature, and the workflow id comes
      // from an operator mapping or an extension, never from the message.
      const { runId } = await handleWebhookTrigger(
        target.workflowId,
        {
          adapter,
          channelId: first.channelId,
          threadId,
          contextKey,
          userId: first.userId,
          userName: first.userName,
          text: rawText,
          messageIds: items.map((item) => item.messageId),
        },
        {},
        getExecutorRegistry(),
        { alreadyAuthenticated: true },
      );
      console.log(`[chat-sdk] ${threadId}: started workflow run ${runId}`);
      await subscribe(thread);
    } catch (error) {
      console.error(`[chat-sdk] ${threadId}: workflow dispatch failed: ${errorMessage(error)}`);
    }
    return;
  }

  const body = stripRoutingTokens(rawText);
  const files = items.flatMap((item) => toChatFiles(adapter, item.messageId, item.attachments));
  await using inbound = await fetchChatFiles(files);
  const fileText = buildChatAttachmentText(inbound.files, inbound.failed);
  const combined = [body, fileText].filter(Boolean).join("\n\n");
  const marked =
    items.length > 1
      ? `[Thread follow-up: ${items.length} message(s) buffered]\n\n${combined}`
      : combined;
  const threadContext =
    mostRecentTask && thread
      ? await getChatThreadContext(thread, new Set(items.map((item) => item.messageId)), resetAt)
      : "";
  const description = threadContext
    ? `${resolveTemplate("chat.message.thread_context", { thread_messages: threadContext }).text}\n\n${marked}`
    : marked;

  const latestActive = await getLatestActiveTaskByContextKey(contextKey, "chat");
  const dependsOn = !immediate && latestActive ? [latestActive.id] : undefined;
  let created = 0;
  for (const match of target.matches) {
    const options: CreateTaskOptions = {
      agentId: match.agent?.id ?? null,
      routingReason: match.agent ? match.reason : undefined,
      routingSource: match.agent ? "engine_default" : undefined,
      source: "chat",
      taskType: "chat-inbound",
      tags: ["chat-sdk", adapter],
      priority: 70,
      contextKey,
      dependsOn,
      parentTaskId: mostRecentTask?.id,
      // A human message in the thread: never answer it in the previous task's
      // structured-output contract.
      inheritParentOutputSchema: false,
      // The relay answers as a reply to the newest buffered message. Always set
      // explicitly: `createTask` copies the parent's anchor into a child that
      // has none, and that would point at an older ask.
      mentionMessageId: items.at(-1)?.messageId ?? first.messageId,
      mentionChannelId: first.channelId,
    };
    try {
      const { task, unattached } = await createChatTaskWithFiles(description, options, inbound);
      created++;
      console.log(
        `[chat-sdk] ${threadId}: task ${task.id} for ${match.agent ? `agent ${match.agent.id}` : "no agent (queued)"} (${match.matchedText}, dependsOn: ${dependsOn?.join(", ") ?? "none"}${unattached.length ? `, ${unattached.length} file(s) not attached` : ""})`,
      );
    } catch (error) {
      if (error instanceof TaskCreationBlockedError) {
        console.info(
          `[chat-sdk] ${threadId}: task creation blocked: ${scrubSecrets(error.reason)}`,
        );
      } else {
        console.error(`[chat-sdk] ${threadId}: task creation failed: ${errorMessage(error)}`);
      }
    }
  }
  if (created > 0) {
    await subscribe(thread);
    // Subscribed-thread messages start typing only here, once a task exists.
    startTypingKeepalive(adapter, threadId);
  } else {
    stopTypingKeepalive(threadId);
  }
}

/**
 * Subscribe so plain replies reach `onSubscribedMessage`. Threads stay
 * subscribed after a terminal task: a later reply is a follow-up.
 */
async function subscribe(thread: Thread | undefined): Promise<void> {
  if (!thread) return;
  try {
    if (!(await thread.isSubscribed())) await thread.subscribe();
  } catch (error) {
    console.warn(`[chat-sdk] Could not subscribe to ${thread.id}: ${errorMessage(error)}`);
  }
}
