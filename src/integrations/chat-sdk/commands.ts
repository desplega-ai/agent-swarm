import type { Chat, SlashCommandEvent } from "chat";
import {
  cancelTask,
  getAgentById,
  getLatestActiveTaskByContextKey,
  getLatestTaskByContextKey,
  updateAgentStatusFromCapacity,
} from "@/be/db";
import { chatSdkContextKey } from "@/tasks/context-key";
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

async function statusText(contextKey: string): Promise<string> {
  const latest = await getLatestTaskByContextKey(contextKey);
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
  contextKey: string,
  threadId: string,
  requestedBy: string,
): Promise<string> {
  const cancelled: AgentTask[] = [];
  for (let i = 0; i < CANCEL_LIMIT; i++) {
    const active = await getLatestActiveTaskByContextKey(contextKey, "chat");
    if (!active) break;
    const task = await cancelTask(active.id, `Cancelled from chat by ${requestedBy}`);
    if (!task) break;
    if (task.agentId) await updateAgentStatusFromCapacity(task.agentId);
    cancelled.push(task);
  }
  stopTypingKeepalive(threadId);
  if (cancelled.length === 0) return "No running task in this chat.";
  const ids = cancelled.map(shortId).join(", ");
  return cancelled.length === 1
    ? `Cancelled task ${ids}.`
    : `Cancelled ${cancelled.length} tasks: ${ids}.`;
}

/** The reply for one command. Exported for tests; the handler posts it. */
export async function runChatCommand(
  command: string,
  threadId: string,
  requestedBy: string,
): Promise<string> {
  const name = command.replace(/^\//, "").toLowerCase();
  if (name === "help") return helpText();
  if (name === "start") return welcomeText();
  if (!CHAT_COMMANDS.some((c) => c.command === name)) {
    return `Unknown command /${name}.\n${helpText()}`;
  }
  let contextKey: string;
  try {
    contextKey = chatSdkContextKey(threadId);
  } catch {
    return "This command works only in a chat the swarm can address.";
  }
  switch (name) {
    case "status":
      return statusText(contextKey);
    case "cancel":
      return cancelActiveTasks(contextKey, threadId, requestedBy);
    case "reset": {
      await markChatThreadReset(threadId);
      const lines = ["Context reset. Your next message starts a new conversation."];
      // A running task is state, not context: it keeps going, and the next task
      // is still created next to it. Only /cancel stops it.
      if (await getLatestActiveTaskByContextKey(contextKey, "chat")) {
        lines.push("A task is still running in this chat. Send /cancel to stop it.");
      }
      return lines.join("\n");
    }
    default:
      return helpText();
  }
}

async function onSlashCommand(event: SlashCommandEvent): Promise<void> {
  const adapter = event.adapter.name;
  // Telegram passes the thread id as the channel id. Slack and Discord pass
  // the channel, so a command there addresses the channel-level thread.
  const threadId = event.channel.id;
  const requestedBy = event.user.userName || event.user.fullName || event.user.userId;
  console.log(`[chat-sdk] ${adapter} ${threadId}: command ${event.command} from ${requestedBy}`);
  let reply: string;
  try {
    reply = await runChatCommand(event.command, threadId, requestedBy);
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
