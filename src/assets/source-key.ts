import { chatThreadOfContextKey } from "../tasks/context-key";
import { normalizeAssetKey, sessionGroupKey } from "./key";

export const SESSION_SOURCES = ["slack", "telegram", "discord"] as const;
export type SessionSource = (typeof SESSION_SOURCES)[number];

/**
 * The source asset key of a root session, or null when the task has no Slack
 * thread and no supported Chat SDK thread. Shapes:
 * - Slack fields or chat-sdk `slack:<channel>:<ts>`: `shared/slack/<channel>/thread:<ts>/`
 * - chat-sdk `slack:<channel>:` (a top-level DM, empty ts): `shared/slack/<channel>/task:<id>/`
 * - `telegram:<chatId>[:<topicId>]`: `shared/telegram/<chatId>/thread:<topicId>/`, else `.../task:<id>/`
 * - `discord:<guild|@me>:<channelId>[:<threadId>]`: `shared/discord/<channelId>/thread:<threadId>/`, else `.../task:<id>/`
 */
export function sessionSourceKey({
  id,
  slackChannelId,
  slackThreadTs,
  contextKey,
}: {
  id: string;
  slackChannelId?: string | null;
  slackThreadTs?: string | null;
  contextKey?: string | null;
}): string | null {
  let parts: [SessionSource, string | undefined, string | undefined];
  if (slackChannelId && slackThreadTs) {
    parts = ["slack", slackChannelId, slackThreadTs];
  } else {
    const chat = chatThreadOfContextKey(contextKey);
    if (!chat) return null;
    // threadId keeps its adapter prefix, so index 0 is the adapter.
    const ids = chat.threadId.split(":");
    if (chat.adapter === "slack" && ids.length === 3 && !ids[2]) ids.pop();
    if (ids.some((part) => !part)) return null;
    if (chat.adapter === "slack" && (ids.length === 2 || ids.length === 3)) {
      parts = ["slack", ids[1], ids[2]];
    } else if (chat.adapter === "telegram" && (ids.length === 2 || ids.length === 3)) {
      parts = ["telegram", ids[1], ids[2]];
    } else if (chat.adapter === "discord" && (ids.length === 3 || ids.length === 4)) {
      parts = ["discord", ids[2], ids[3]];
    } else {
      return null;
    }
  }
  const [source, channel, thread] = parts;
  // A "/" inside an id would add key segments and break the group shape.
  if (!channel || channel.includes("/") || thread?.includes("/")) return null;
  try {
    return normalizeAssetKey(
      `shared/${source}/${channel}/${thread ? `thread:${thread}` : `task:${id}`}/`,
    );
  } catch {
    return null;
  }
}

export function sourceOfKey(key: string): SessionSource | null {
  return SESSION_SOURCES.find((source) => key.startsWith(`shared/${source}/`)) ?? null;
}

export const NESTED_THREAD_MIN_ROOTS = 2;

export function isSourceThreadKey(key: string): boolean {
  return sourceOfKey(key) !== null && /\/thread:[^/]+\/$/.test(key);
}

/** A source thread with at least two owned roots gets its own nested group. */
export function sessionThreadGroupKey(key: string, threadRoots: number): string {
  const normalized = normalizeAssetKey(key);
  return isSourceThreadKey(normalized) && threadRoots >= NESTED_THREAD_MIN_ROOTS
    ? normalized
    : sessionGroupKey(normalized);
}

export const SOURCE_GROUPS_READ_ONLY = "Source groups are read-only.";

/** The source a filter matches: the source of the key prefix, else the raw task source. */
export function effectiveSource(key: string, source: string): string {
  return sourceOfKey(key) ?? source;
}

/**
 * Why a session root may not move to `destination` (a normalized key), or null.
 * Source groups are read-only: only a move back to the root's own source key
 * (Undo after a move out) may land under a source prefix. Null is No group.
 */
export function sourceMoveError(
  destination: string | null,
  root: Parameters<typeof sessionSourceKey>[0],
): string | null {
  return destination !== null && sourceOfKey(destination) && destination !== sessionSourceKey(root)
    ? SOURCE_GROUPS_READ_ONLY
    : null;
}
