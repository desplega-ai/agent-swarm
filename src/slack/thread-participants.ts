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

  // shortcut: people past the cap are not resolved, so their trust is unknown to the "untrusted present" rule; resolve them too if the cap ever hides one.
  const people: TaskSlackParticipant[] = await Promise.all(
    listed.map(async (slackUserId) => {
      const resolution = await resolveSlackParticipant(client, slackUserId, {
        sampleEventType: opts.sampleEventType,
        sampleContext: latest.get(slackUserId)?.text ?? "",
        userTeam: latest.get(slackUserId)?.userTeam,
      });
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
  const newestPerson = people[0];

  return {
    threadContext: await renderThreadContext(messages, opts.excludeTs, isBot, botUserId, trust),
    participants: { people, more: ordered.length - listed.length },
    trust,
    newest: { userId: newestPerson?.userId, trust: newestPerson?.trust ?? "unknown" },
  };
}

async function renderThreadContext(
  messages: ThreadMessage[],
  excludeTs: ReadonlySet<string>,
  isBot: (m: ThreadMessage) => boolean,
  botUserId: string | undefined,
  trust: ReadonlyMap<string, SlackParticipantTrust>,
): Promise<string> {
  const previous = messages.filter(
    (m) => !(m.ts && excludeTs.has(m.ts)) && extractSlackMessageText(m) !== "",
  );
  if (previous.length === 0) return "";
  // conversations.replies is oldest first: keep the root and the newest replies.
  const window =
    previous.length > THREAD_CONTEXT_MESSAGES
      ? [previous[0]!, ...previous.slice(-(THREAD_CONTEXT_MESSAGES - 1))]
      : previous;

  // Author identity comes from the identity primitive (resolved name or the
  // UNKNOWN sentinel), never a raw Slack display name.
  const lines = window.map((m) => {
    const text = extractSlackMessageText(m);
    if (isBot(m))
      return formatAuthoredMessage(
        "[Agent]",
        text.length > 500 ? `${text.slice(0, 500)}...` : text,
      );
    return formatAuthoredMessage(m.user ? `<@${m.user}>` : "Unknown", text);
  });
  let body = await rewriteSlackMentions(lines.join("\n"), botUserId, trust);
  if ([...trust.values()].some(isUntrusted)) {
    body = `${resolveTemplate("slack.message.thread_context_untrusted", {}).text}\n${body}`;
  }
  return resolveTemplate("slack.message.thread_context", { thread_messages: body }).text;
}
