import type { Adapter, Message, Thread } from "chat";
import { z } from "zod";
import {
  getAgentById,
  getAgentWorkingOnContextKey,
  getAllAgents,
  getLatestActiveTaskByContextKey,
  getLatestTaskByContextKey,
  getLeadAgent,
  isExtensionAgent,
} from "@/be/db";
import { resolveIdentity } from "@/be/identity";
import { recordUnmappedIdentity } from "@/be/unmapped-identities";
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
  formatTooLargeReply,
  toChatFiles,
  transcribeChatAudio,
} from "./attachments";
import { getChatThreadResetAt } from "./commands";
import { type ChatAddressedReason, formatChatHeaderFacts, readChatMessageFacts } from "./facts";
import { errorMessage } from "./logger";
import { emitChatMessageSent, postChatMessage } from "./outbound";
import {
  chatAdapterReacts,
  clearChatMessageReactions,
  setChatMessageReaction,
  wantsChatTextAck,
} from "./reactions";
import {
  type ChatAgentMatch,
  type ChatRouteTarget,
  chatOwnerWindowStart,
  getChatChannelMapping,
  hasRoutingToken,
  routeChatMessage,
  stripRoutingTokens,
} from "./router";
import { getChatInstance } from "./runtime";
import { readPersistedThreadHistory, SqliteChatState } from "./state";
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

  const facts = readChatMessageFacts(thread, message);
  const isDirectMessage = kind === "dm" || thread.isDM;
  const mentioned = kind === "mention" || message.isMention === true;
  let addressed: ChatAddressedReason = isDirectMessage
    ? "dm"
    : facts.replyToBot
      ? "reply-to-bot"
      : mentioned
        ? "mention"
        : "none";
  // A Telegram group is one shared conversation, not a thread about the task:
  // an unaddressed message there is side chatter unless its sender asked for
  // the thread's open task. Chatter neither steers nor reaches the router.
  if (addressed === "none" && (facts.chatType === "group" || facts.chatType === "supergroup")) {
    const unaddressed = await classifyUnaddressedGroupMessage(thread, message.author.userId, text);
    if (unaddressed === "chatter") {
      console.log(
        `[chat-sdk] ${thread.id}: unaddressed group message from a non-requester, ignored`,
      );
      return;
    }
    if (unaddressed === "requester-follow-up") addressed = unaddressed;
  }

  // A thread with messages already waiting keeps its order: append, do not steer past them.
  // Another sender's message takes the buffer, so it gets its own header and requester.
  if (!immediate && attachments.length === 0 && text && !isChatThreadBuffered(thread.id)) {
    const steering = await requestChatThreadSteering({
      contextKey: chatSdkContextKey(thread.id),
      message: text,
      resolveSender: () => resolveChatSender(adapter, message.author.userId),
    });
    if (steering) {
      console.log(
        `[chat-sdk] ${adapter} message steered task ${steering.task.id} (${steering.result.outcome})`,
      );
      await setChatMessageReaction(adapter, thread.id, message.id, "steered");
      if (!(await wantsChatTextAck(adapter, thread.channelId))) return;
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
    // An unaddressed subscribed-thread message may be dropped by the router at
    // flush time; it gets typing and a reaction once a task exists (see
    // flushChatThread). A mention, reply to the bot, or DM is acknowledged now.
    const acknowledge = kind !== "subscribed" || isDirectMessage || mentioned || facts.replyToBot;
    bufferChatMessage(thread.id, {
      messageId: message.id,
      channelId: thread.channelId,
      text,
      userId: message.author.userId,
      userName: message.author.userName || undefined,
      botMentioned: mentioned || facts.replyToBot,
      isDirectMessage,
      addressed,
      reacted: acknowledge && chatAdapterReacts(adapter),
      facts,
      attachments,
    });
    if (acknowledge) {
      startTypingKeepalive(adapter, thread.id);
      await setChatMessageReaction(adapter, thread.id, message.id, immediate ? "now" : "accepted");
    }
  }
  if (immediate) await instantFlushChat(thread.id);
}

const REQUESTER_KEY_PREFIX = "swarm:requester:";
const REQUESTER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Platform user id of whoever asked for the thread's latest task. */
async function rememberChatThreadRequester(threadId: string, userId: string): Promise<void> {
  try {
    await new SqliteChatState().set(`${REQUESTER_KEY_PREFIX}${threadId}`, userId, REQUESTER_TTL_MS);
  } catch (error) {
    console.warn(`[chat-sdk] Could not store the thread requester: ${errorMessage(error)}`);
  }
}

/**
 * An unaddressed message outside a DM. `routable`: a routing token or an
 * agent channel mapping routes it whoever sent it. `requester-follow-up`: its
 * sender asked for the thread's task and the owner window is open. Anything
 * else is `chatter`.
 */
async function classifyUnaddressedGroupMessage(
  thread: Thread,
  senderId: string,
  text: string,
): Promise<"routable" | "requester-follow-up" | "chatter"> {
  if (hasRoutingToken(text)) return "routable";
  if ((await getChatChannelMapping(thread.adapter.name, thread.channelId))?.agentId) {
    return "routable";
  }
  const owner = await getAgentWorkingOnContextKey(
    chatSdkContextKey(thread.id),
    "chat",
    chatOwnerWindowStart(),
  );
  if (!owner) return "chatter";
  const requester = await new SqliteChatState().get<string>(`${REQUESTER_KEY_PREFIX}${thread.id}`);
  return requester === senderId ? "requester-follow-up" : "chatter";
}

/**
 * Canonical user behind a chat sender, through the same identity registry as
 * Slack: `(<adapter>, <platform user id>)` in `user_external_ids`. An unknown
 * sender goes to the Unmapped tracker and the task has no requester.
 */
async function resolveChatRequester(
  adapter: string,
  item: ChatBufferedMessage,
): Promise<string | undefined> {
  return resolveChatSender(adapter, item.userId, {
    sampleEventType: "chat.message",
    sampleContext: `${item.facts.from}: ${item.text}`,
  });
}

/** {@link resolveChatRequester} for a bare sender id; records it as unmapped only when `sample` is set. */
async function resolveChatSender(
  adapter: string,
  userId: string,
  sample?: { sampleEventType: string; sampleContext: string },
): Promise<string | undefined> {
  // Telegram `sender_chat` posts (anonymous admins, linked channels) are no person.
  if (!userId || userId.startsWith("chat:")) return undefined;
  try {
    const resolution = await resolveIdentity(adapter, userId);
    if (resolution.status === "resolved") return resolution.userId;
    if (sample) await recordUnmappedIdentity(adapter, userId, sample);
  } catch (error) {
    console.warn(`[chat-sdk] Could not resolve the requester: ${errorMessage(error)}`);
  }
  return undefined;
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
  // The task's requester: the first sender who addressed the swarm.
  const requester = items.find((item) => item.addressed !== "none") ?? first;
  // One task carries every sender's text, so a batch from several people
  // gets no requester: one sender's identity must not vouch for another's words.
  const otherSenders = new Set(items.map((item) => item.userId)).size - 1;
  // The task answers the newest message; it alone carries the reaction lifecycle.
  const answered = items.at(-1) ?? first;
  const reacted = items.filter((item) => item.reacted).map((item) => item.messageId);

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
      ...(first.facts.chatType ? { chatType: first.facts.chatType } : {}),
      ...(first.facts.isForum ? { isForum: true } : {}),
      replyToBot: items.some((item) => item.facts.replyToBot),
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
    await clearChatMessageReactions(adapter, threadId, reacted);
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
    await clearChatMessageReactions(adapter, threadId, reacted);
    return;
  }

  if (target.kind === "workflow") {
    // A workflow run has no relay that would stop the indicator or end the reaction.
    stopTypingKeepalive(threadId);
    await clearChatMessageReactions(adapter, threadId, reacted);
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
  const tooLarge = inbound.failed.filter((failure) => failure.tooLarge);
  if (tooLarge.length > 0) {
    // The user would otherwise never learn the file was dropped.
    try {
      await postChatMessage({ adapter, threadId, text: formatTooLargeReply(tooLarge) });
    } catch (error) {
      console.warn(
        `[chat-sdk] ${threadId}: could not post the too-large reply: ${errorMessage(error)}`,
      );
    }
  }
  const notes = await transcribeChatAudio(inbound.fetched);
  const fileText = buildChatAttachmentText(inbound.files, inbound.failed, notes);
  const combined = [body, fileText].filter(Boolean).join("\n\n");
  const marked =
    items.length > 1
      ? `[Thread follow-up: ${items.length} message(s) buffered]\n\n${combined}`
      : combined;
  const threadContext =
    mostRecentTask && thread
      ? await getChatThreadContext(thread, new Set(items.map((item) => item.messageId)), resetAt)
      : "";
  const header = resolveTemplate("chat.message.header", {
    chat_facts: formatChatHeaderFacts(
      adapter,
      otherSenders > 0
        ? { ...requester.facts, from: `${requester.facts.from} +${otherSenders} more` }
        : requester.facts,
      requester.addressed,
    ),
  }).text;
  const description = [
    header,
    threadContext
      ? resolveTemplate("chat.message.thread_context", { thread_messages: threadContext }).text
      : "",
    marked,
  ]
    .filter(Boolean)
    .join("\n\n");
  const requestedByUserId =
    otherSenders > 0 ? undefined : await resolveChatRequester(adapter, requester);

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
      requestedByUserId,
      parentTaskId: mostRecentTask?.id,
      // The parent's requester asked an earlier message: an unknown sender stays unattributed.
      inheritParentRequester: false,
      // A human message in the thread: never answer it in the previous task's
      // structured-output contract.
      inheritParentOutputSchema: false,
      // The relay answers as a reply to the newest buffered message. Always set
      // explicitly: `createTask` copies the parent's anchor into a child that
      // has none, and that would point at an older ask.
      mentionMessageId: answered.messageId,
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
    await rememberChatThreadRequester(threadId, requester.userId);
    await subscribe(thread);
    // Unaddressed subscribed-thread messages start typing only here, once a task exists.
    startTypingKeepalive(adapter, threadId);
    await clearChatMessageReactions(
      adapter,
      threadId,
      reacted.filter((id) => id !== answered.messageId),
    );
    if (!answered.reacted)
      await setChatMessageReaction(adapter, threadId, answered.messageId, "accepted");
  } else {
    stopTypingKeepalive(threadId);
    await clearChatMessageReactions(adapter, threadId, reacted);
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
