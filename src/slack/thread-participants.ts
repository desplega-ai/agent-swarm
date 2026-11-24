/**
 * One read of a Slack thread for a new task: the `<thread_context>` block and
 * the people in the thread with their trust level. Shared by the mention path
 * (`handlers.ts`) and the follow-up buffer (`thread-buffer.ts`).
 */

import type { WebClient } from "@slack/web-api";
import { getFirstTaskInThread } from "../be/db";
import { resolveTemplate } from "../prompts/resolver";
import type { SlackParticipantTrust, TaskSlackParticipant, TaskSlackParticipants } from "../types";
import {
  resolveSlackParticipant,
  rewriteSlackMentions,
  type SlackParticipantResolution,
} from "./enrich";
import { extractSlackMessageText, type SlackMessageLike } from "./message-text";
import "./templates";

/** People listed in the prompt; the rest render as `<N more...>`. */
export const SLACK_PARTICIPANT_CAP = 10;
/** Messages kept in `<thread_context>`: the root plus the newest replies. */
const THREAD_CONTEXT_MESSAGES = 20;
// shortcut: one page of replies, so a thread past 200 messages loses its tail; page with the cursor when that matters.
const THREAD_FETCH_LIMIT = 200;

interface ThreadMessage extends SlackMessageLike {
  ts?: string;
  user?: string;
  user_team?: string;
  bot_id?: string;
  subtype?: string;
}

/** One message of the batch that triggers the task, oldest first. */
export interface SlackSender {
  userId: string;
  text: string;
  userTeam?: string;
}

export interface SlackThreadSnapshot {
  /** The rendered `<thread_context>` block, or "" when there is no history. */
  threadContext: string;
  participants: TaskSlackParticipants;
  trust: ReadonlyMap<string, SlackParticipantTrust>;
  /** The newest sender: owns `requestedByUserId`. */
  newest: SlackParticipantResolution;
}

/**
 * `label: text` with every continuation line indented. Author labels start at
 * column 0 and message lines never do, so a multi-line message cannot forge
 * another person's `<@U…>: …` line.
 */
export function formatAuthoredMessage(label: string, text: string): string {
  return `${label}: ${text.split(/\r\n|[\n\r\u2028\u2029]/).join("\n  ")}`;
}

export function isUntrusted(trust: SlackParticipantTrust | undefined): boolean {
  return trust === "external" || trust === "unknown";
}

export async function buildSlackThreadSnapshot(
  client: WebClient,
  opts: {
    channelId: string;
    /** Absent for a top-level message. */
    threadTs?: string;
    /** Messages already in the task body (the batch itself). */
    excludeTs: ReadonlySet<string>;
    botUserId?: string;
    senders: readonly SlackSender[];
    sampleEventType: string;
  },
): Promise<SlackThreadSnapshot> {
  const { botUserId, senders } = opts;
  const newestSender = senders.at(-1);
  if (!newestSender) throw new Error("buildSlackThreadSnapshot needs at least one sender");

  let messages: ThreadMessage[] = [];
  if (opts.threadTs) {
    try {
      const result = await client.conversations.replies({
        channel: opts.channelId,
        ts: opts.threadTs,
        limit: THREAD_FETCH_LIMIT,
      });
      messages = (result.messages ?? []) as ThreadMessage[];
    } catch (error) {
      console.error("[Slack] Failed to fetch thread context:", error);
    }
  }
  const isBot = (m: ThreadMessage) =>
    m.user === botUserId || m.bot_id !== undefined || m.subtype === "bot_message";
  // Only this swarm's own posts render as `[Agent]`; any other bot or app is untrusted.
  const ownBotId = messages.some((m) => m.bot_id !== undefined) ? await getOwnBotId(client) : null;
  const isOwnBot = (m: ThreadMessage) =>
    (botUserId !== undefined && m.user === botUserId) ||
    (ownBotId !== null && m.bot_id === ownBotId);

  // Latest message per human, newest first: the order of non-batch participants.
  const latest = new Map<string, { text: string; userTeam?: string }>();
  for (const m of [...messages].reverse()) {
    if (!m.user || isBot(m) || latest.has(m.user)) continue;
    latest.set(m.user, { text: extractSlackMessageText(m), userTeam: m.user_team });
  }
  for (const sender of senders) {
    latest.set(sender.userId, { text: sender.text, userTeam: sender.userTeam });
  }

  const starterId = opts.threadTs
    ? (await getFirstTaskInThread(opts.channelId, opts.threadTs))?.slackUserId
    : undefined;
  const askers = new Set(senders.map((sender) => sender.userId));
  const ordered = [
    ...new Set([
      newestSender.userId,
      ...(starterId ? [starterId] : []),
      ...senders.map((sender) => sender.userId).reverse(),
      ...latest.keys(),
    ]),
  ].filter((id) => id !== botUserId);
  const listed = ordered.slice(0, SLACK_PARTICIPANT_CAP);
  const resolve = (slackUserId: string) =>
    resolveSlackParticipant(client, slackUserId, {
      sampleEventType: opts.sampleEventType,
      sampleContext: latest.get(slackUserId)?.text ?? "",
      userTeam: latest.get(slackUserId)?.userTeam,
    });

  const people: TaskSlackParticipant[] = await Promise.all(
    listed.map(async (slackUserId) => {
      const resolution = await resolve(slackUserId);
      return {
        slackUserId,
        ...(resolution.userId && { userId: resolution.userId }),
        trust: resolution.trust,
        ...(slackUserId === starterId && { starter: true }),
        ...(slackUserId === newestSender.userId && { newest: true }),
        ...(askers.has(slackUserId) && { asked: true }),
      };
    }),
  );
  const trust = new Map(people.map((person) => [person.slackUserId, person.trust]));
  // The cap limits the listed people only. Every sender and every author in the
  // rendered context still gets a trust level, so a label is never dropped.
  const window = contextWindow(messages, opts.excludeTs);
  const unlisted = [
    ...new Set([
      ...senders.map((sender) => sender.userId),
      ...window.filter((m) => !isBot(m) && m.user).map((m) => m.user as string),
    ]),
  ].filter((id) => id !== botUserId && !trust.has(id));
  for (const [slackUserId, resolution] of await Promise.all(
    unlisted.map(async (id) => [id, await resolve(id)] as const),
  )) {
    trust.set(slackUserId, resolution.trust);
  }
  const newestPerson = people[0];

  return {
    threadContext: await renderThreadContext(window, isBot, isOwnBot, botUserId, trust),
    participants: { people, more: ordered.length - listed.length },
    trust,
    newest: { userId: newestPerson?.userId, trust: newestPerson?.trust ?? "unknown" },
  };
}

/** Bot id of this swarm's own app (`auth.test`), cached per process once known. */
let cachedOwnBotId: string | undefined;
async function getOwnBotId(client: WebClient): Promise<string | null> {
  if (cachedOwnBotId) return cachedOwnBotId;
  try {
    cachedOwnBotId = ((await client.auth.test()).bot_id as string | undefined) || undefined;
  } catch (error) {
    console.error("[Slack] auth.test failed while reading the bot id:", error);
  }
  return cachedOwnBotId ?? null;
}

/** The messages `<thread_context>` shows: the root plus the newest replies. */
function contextWindow(messages: ThreadMessage[], excludeTs: ReadonlySet<string>): ThreadMessage[] {
  const previous = messages.filter(
    (m) => !(m.ts && excludeTs.has(m.ts)) && extractSlackMessageText(m) !== "",
  );
  // conversations.replies is oldest first: keep the root and the newest replies.
  return previous.length > THREAD_CONTEXT_MESSAGES
    ? [previous[0]!, ...previous.slice(-(THREAD_CONTEXT_MESSAGES - 1))]
    : previous;
}

async function renderThreadContext(
  window: ThreadMessage[],
  isBot: (m: ThreadMessage) => boolean,
  isOwnBot: (m: ThreadMessage) => boolean,
  botUserId: string | undefined,
  trust: ReadonlyMap<string, SlackParticipantTrust>,
): Promise<string> {
  if (window.length === 0) return "";

  // Author identity comes from the identity primitive (resolved name or the
  // UNKNOWN sentinel), never a raw Slack display name.
  let otherBot = false;
  const lines: string[] = [];
  for (const m of window) {
    const text = extractSlackMessageText(m);
    if (isBot(m)) {
      const short = text.length > 500 ? `${text.slice(0, 500)}...` : text;
      if (isOwnBot(m)) {
        lines.push(formatAuthoredMessage("[Agent]", short));
        continue;
      }
      otherBot = true;
      const label = (
        await resolveTemplate("slack.message.thread_context_other_bot", {
          bot_id: m.bot_id ?? m.user ?? "unknown",
        })
      ).text;
      lines.push(formatAuthoredMessage(label, short));
      continue;
    }
    lines.push(formatAuthoredMessage(m.user ? `<@${m.user}>` : "Unknown", text));
  }
  let body = await rewriteSlackMentions(lines.join("\n"), botUserId, trust);
  if (otherBot || [...trust.values()].some(isUntrusted)) {
    body = `${(await resolveTemplate("slack.message.thread_context_untrusted", {})).text}\n${body}`;
  }
  return (await resolveTemplate("slack.message.thread_context", { thread_messages: body })).text;
}
