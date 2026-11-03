import type { Chat, SlashCommandEvent } from "chat";
import {
  cancelTask,
  getAgentById,
  getLatestActiveTaskByContextKey,
  getLatestTaskByContextKey,
  getLatestTaskByContextKeyPrefix,
  updateAgentStatusFromCapacity,
} from "@/be/db";
import { resolveIdentity } from "@/be/identity";
import { chatSdkContextKey, chatThreadOfContextKey } from "@/tasks/context-key";
import type { AgentTask } from "@/types";
import { scrubSecrets } from "@/utils/secret-scrubber";
import { resolveAdapterApiUrl } from "./adapters";
import { trackBackground } from "./background";
import type { ResolvedAdapterConfig } from "./config";
import { errorMessage } from "./logger";
import { SqliteChatState } from "./state";
import { callTelegramBotApi } from "./telegram-api";
import { stopTypingKeepalive } from "./typing";

/**
 * Slash commands the swarm answers on every adapter that delivers them
 * (Telegram, Discord, Slack). The platform learns the list in its own way:
 * Telegram through `setMyCommands` at adapter start, Discord through a
 * one-time application-command registration, Slack through the app manifest.
 * Names follow the Telegram rules (lowercase, 1-32 chars) so one list fits all.
 */
export interface ChatCommandSpec {
  command: string;
  description: string;
}

export const CHAT_COMMANDS: readonly ChatCommandSpec[] = [
  { command: "help", description: "List the commands" },
  { command: "status", description: "Show the latest task of this chat" },
  { command: "cancel", description: "Cancel the running task of this chat" },
  { command: "reset", description: "Start over: the next message gets no earlier context" },
];

/**
 * The shipped Slack manifest declares `/agent-swarm-status` and
 * `/agent-swarm-help`. They run the same commands as `/status` and `/help`.
 */
const COMMAND_ALIAS_PREFIX = "agent-swarm-";

const RESET_KEY_PREFIX = "swarm:reset:";
const RESET_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Upper bound on the active tasks `/cancel` walks in one chat. */
const CANCEL_LIMIT = 20;

/**
 * Record that the user reset the conversation. The next flush in this thread
 * creates a task with no parent and no thread history older than this mark.
 */
export async function markChatThreadReset(threadId: string): Promise<Date> {
  const at = new Date();
  await new SqliteChatState().set(`${RESET_KEY_PREFIX}${threadId}`, at.toISOString(), RESET_TTL_MS);
  return at;
}

/** The last `/reset` in this thread, or null. */
export async function getChatThreadResetAt(threadId: string): Promise<Date | null> {
  const raw = await new SqliteChatState().get<string>(`${RESET_KEY_PREFIX}${threadId}`);
  if (typeof raw !== "string") return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

function helpText(): string {
  return ["Commands:", ...CHAT_COMMANDS.map((c) => `/${c.command}: ${c.description}`)].join("\n");
}

/**
 * Telegram sends `/start` when a user opens a bot DM. It stays out of
 * `CHAT_COMMANDS`, so the `/` menu does not list it.
 */
function welcomeText(): string {
  return [
    "Hi! Send a message here (in a group, mention me) and the swarm picks it up. Each answer arrives as a reply to your message.",
    "",
    helpText(),
  ].join("\n");
}

export function shortId(task: Pick<AgentTask, "id">): string {
  return task.id.slice(0, 8);
}

async function assigneeLabel(task: AgentTask): Promise<string> {
  if (!task.agentId) return "waiting for an agent";
  const agent = await getAgentById(task.agentId);
  return agent ? `assigned to ${agent.name}` : "assigned to a removed agent";
}

/**
 * Whose tasks a command may touch. `owner` is set for a command that comes from
 * a place several people share (a Slack or Discord channel): it sees and
 * changes only that user's tasks. Without `owner`, the thread belongs to the
 * conversation (a Telegram chat, a Discord thread, a private DM).
 */
interface CommandTarget {
  threadId: string;
  owner?: string;
}

/**
 * What a chat id names, as a command reports it:
 * - `conversation`: one conversation (Telegram's chat id, a Discord thread or
 *   DM, a Slack thread). The command acts on it directly.
 * - `dm`: the channel of a Slack 1:1 DM, which a slash command reports without
 *   the conversation in it. Its human is the only requester, so the command
 *   acts on the latest conversation there whoever the sender resolves to.
 * - `shared`: a Slack or Discord channel, where several people ask. The command
 *   sees and changes only the sender's own tasks. An adapter this does not know
 *   counts as shared.
 */
type CommandScope = "conversation" | "dm" | "shared";

function commandScope(threadId: string): CommandScope {
  const separator = threadId.indexOf(":");
  const adapter = threadId.slice(0, separator);
  const parts = threadId.slice(separator + 1).split(":");
  switch (adapter) {
    case "telegram":
      return "conversation";
    case "discord":
      // `<guild>:<channel>[:<thread>]`; a DM has the guild `@me`.
      if (parts[0] === "@me") return "conversation";
      return parts.length <= 2 ? "shared" : "conversation";
    case "slack":
      // `<channel>[:<thread ts>]`; a 1:1 DM channel id starts with `D`.
      if (parts[1]) return "conversation";
      return parts[0]?.startsWith("D") ? "dm" : "shared";
    default:
      return "shared";
  }
}

async function statusText(target: CommandTarget | null): Promise<string> {
  const latest = target
    ? await getLatestTaskByContextKey(chatSdkContextKey(target.threadId), {
        requestedByUserId: target.owner,
      })
    : null;
  if (!latest) return "No task yet for this chat. Send a message to create one.";
  const lines = [
    `Latest task ${shortId(latest)}: ${latest.status}, ${await assigneeLabel(latest)}.`,
  ];
  if (latest.status === "pending" || latest.status === "in_progress") {
    lines.push("Send /cancel to stop it.");
  }
  return lines.join("\n");
}

async function cancelActiveTasks(
  target: CommandTarget | null,
  requestedBy: string,
): Promise<string> {
  const cancelled: AgentTask[] = [];
  if (target) {
    const contextKey = chatSdkContextKey(target.threadId);
    for (let i = 0; i < CANCEL_LIMIT; i++) {
      const active = await getLatestActiveTaskByContextKey(contextKey, "chat", target.owner);
      if (!active) break;
      const task = await cancelTask(active.id, `Cancelled from chat by ${requestedBy}`);
      if (!task) break;
      if (task.agentId) await updateAgentStatusFromCapacity(task.agentId);
      cancelled.push(task);
    }
    // Another user's task may still run in this thread: its indicator stays.
    if (!(await getLatestActiveTaskByContextKey(contextKey, "chat"))) {
      stopTypingKeepalive(target.threadId);
    }
  }
  if (cancelled.length === 0) return "No running task in this chat.";
  const ids = cancelled.map(shortId).join(", ");
  return cancelled.length === 1
    ? `Cancelled task ${ids}.`
    : `Cancelled ${cancelled.length} tasks: ${ids}.`;
}

/**
 * The conversation a command acts on, or null when there is none for this
 * sender. Telegram hands the command its thread id, so the chat's own task is
 * found at once. Slack and Discord hand it the channel, while their tasks are
 * keyed `<channel>:<thread>` (a Slack thread root, a Discord thread made for a
 * mention) or, when Discord cannot open a thread, by the channel itself; a
 * slash command carries no thread. The command then acts on the most recent
 * task in the channel (the most recent running one for `/cancel`). In a shared
 * channel that is the sender's own tasks only: a channel member must not read,
 * cancel or reset another user's conversation, which on Discord may be private,
 * and an unknown sender gets no target. A Slack DM channel has one human, so the
 * sender is not checked there (see `CommandScope`).
 */
async function resolveCommandTarget(
  threadId: string,
  activeOnly: boolean,
  senderUserId: string | undefined,
): Promise<CommandTarget | null> {
  const scope = commandScope(threadId);
  if (scope === "conversation") return { threadId };
  if (scope === "shared" && !senderUserId) return null;
  // A shared channel filters by the sender; a DM has one human and no filter.
  const owner = scope === "shared" ? senderUserId : undefined;
  const contextKey = chatSdkContextKey(threadId);
  const exact = activeOnly
    ? await getLatestActiveTaskByContextKey(contextKey, "chat", owner)
    : await getLatestTaskByContextKey(contextKey, { requestedByUserId: owner });
  const threaded = await getLatestTaskByContextKeyPrefix(
    `${contextKey}${encodeURIComponent(":")}`,
    activeOnly
      ? { activeOnly, source: "chat", requestedByUserId: owner }
      : { requestedByUserId: owner },
  );
  const latest =
    exact && threaded && threaded.createdAt > exact.createdAt ? threaded : (exact ?? threaded);
  const found = chatThreadOfContextKey(latest?.contextKey)?.threadId;
  if (found) return owner ? { threadId: found, owner } : { threadId: found };
  // No task yet in a DM: its conversation is the channel with an empty thread
  // ts, which is where the first message lands, so a reset still applies to it.
  return scope === "dm" ? { threadId: `${threadId}:` } : null;
}

async function resetText(target: CommandTarget | null): Promise<string> {
  if (!target) return "No conversation of yours here to reset.";
  const contextKey = chatSdkContextKey(target.threadId);
  // The mark covers the whole thread. When someone else also asked in it, the
  // mark would cut their context too.
  if (
    target.owner &&
    (await getLatestTaskByContextKey(contextKey, { notRequestedByUserId: target.owner }))
  ) {
    return "Other people also asked in your latest thread, so a reset would change their context. Nothing was reset.";
  }
  await markChatThreadReset(target.threadId);
  const lines = ["Context reset. Your next message starts a new conversation."];
  // A running task is state, not context: it keeps going, and the next task
  // is still created next to it. Only /cancel stops it.
  if (await getLatestActiveTaskByContextKey(contextKey, "chat")) {
    lines.push("A task is still running in this chat. Send /cancel to stop it.");
  }
  return lines.join("\n");
}

/**
 * The reply for one command. Exported for tests; the handler posts it.
 * `senderUserId` is the sender's canonical user, undefined when unknown.
 */
export async function runChatCommand(
  command: string,
  threadId: string,
  requestedBy: string,
  senderUserId?: string,
): Promise<string> {
  let name = command.replace(/^\//, "").toLowerCase();
  if (name.startsWith(COMMAND_ALIAS_PREFIX)) name = name.slice(COMMAND_ALIAS_PREFIX.length);
  if (name === "help") return helpText();
  if (name === "start") return welcomeText();
  if (!CHAT_COMMANDS.some((c) => c.command === name)) {
    return `Unknown command /${name}.\n${helpText()}`;
  }
  try {
    chatSdkContextKey(threadId);
  } catch {
    return "This command works only in a chat the swarm can address.";
  }
  switch (name) {
    case "status":
      return statusText(await resolveCommandTarget(threadId, false, senderUserId));
    case "cancel":
      return cancelActiveTasks(
        await resolveCommandTarget(threadId, true, senderUserId),
        requestedBy,
      );
    case "reset":
      return resetText(await resolveCommandTarget(threadId, false, senderUserId));
    default:
      return helpText();
  }
}

/** The sender's canonical user through the identity registry, undefined when unknown. */
async function resolveCommandSender(adapter: string, userId: string): Promise<string | undefined> {
  if (!userId || userId.startsWith("chat:")) return undefined;
  try {
    const resolution = await resolveIdentity(adapter, userId);
    return resolution.status === "resolved" ? resolution.userId : undefined;
  } catch (error) {
    console.warn(`[chat-sdk] Could not resolve the command sender: ${errorMessage(error)}`);
    return undefined;
  }
}

async function onSlashCommand(event: SlashCommandEvent): Promise<void> {
  const adapter = event.adapter.name;
  // Telegram passes the thread id as the channel id. Slack and Discord pass
  // the channel; `runChatCommand` resolves it to a thread of that channel.
  const threadId = event.channel.id;
  const requestedBy = event.user.userName || event.user.fullName || event.user.userId;
  console.log(`[chat-sdk] ${adapter} ${threadId}: command ${event.command} from ${requestedBy}`);
  let reply: string;
  try {
    const senderUserId = await resolveCommandSender(adapter, event.user.userId);
    reply = await runChatCommand(event.command, threadId, requestedBy, senderUserId);
  } catch (error) {
    console.warn(
      scrubSecrets(
        `[chat-sdk] ${threadId}: command ${event.command} failed: ${errorMessage(error)}`,
      ),
    );
    reply = "The command failed. Check the API log.";
  }
  try {
    await event.channel.post(scrubSecrets(reply));
  } catch (error) {
    console.warn(
      `[chat-sdk] ${threadId}: could not answer ${event.command}: ${errorMessage(error)}`,
    );
  }
}

/** Catch-all handler: known commands act, unknown ones get the list. */
export function registerChatCommands(chat: Chat): void {
  chat.onSlashCommand((event) => {
    const work = onSlashCommand(event);
    trackBackground(work);
    return work.catch(() => undefined);
  });
}

/**
 * Publish the command list to Telegram so the client shows the `/` menu.
 * Called after the adapter initialized; a failure is logged, never fatal.
 */
export async function registerTelegramCommands(config: ResolvedAdapterConfig): Promise<void> {
  const raw = config.botToken;
  const token = typeof raw === "function" ? await (raw as () => Promise<string>)() : raw;
  if (typeof token !== "string" || token.length === 0) return;
  await callTelegramBotApi(resolveAdapterApiUrl("telegram"), token, "setMyCommands", {
    commands: CHAT_COMMANDS.map((c) => ({ command: c.command, description: c.description })),
  });
}
