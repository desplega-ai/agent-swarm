// "@name" mentions in Comb comments (agent-fs feature `comment-mentions`).
//
// The composer inserts `@<label>` and sends the member's agent-fs user id in
// `mentions[]`. agent-fs stores the ids and notifies each mentioned member.
// Only a pick in the list makes a mention: typed text never notifies anyone.
// The thread renders the tokens that match `comment.mentions` as chips.
//
// Relative imports only: `bun:test` runs this from the repo root.

import type {
  CommentMention,
  CommentNotificationEntry,
  CommentNotificationListResult,
  DriveMember,
} from "../agent-fs/types";
import { commentCombPath } from "./comments";
import { hasSwarmMarker } from "./markers";
import { combPath } from "./paths";

/** agent-fs accounts that the swarm creates for its agents. */
const AGENT_EMAIL_SUFFIX = "@swarm.local";

/** The picker label of the swarm entry (it inserts the `@swarm` marker). */
export const SWARM_LABEL = "swarm";

/**
 * The members a human can mention: everyone except the caller, the swarm's
 * agent accounts (`@swarm.local`), and the swarm service account.
 */
export function pickableMembers(
  members: readonly DriveMember[],
  selfUserId: string | null,
  serviceUserId: string | null = null,
): DriveMember[] {
  return members.filter(
    (member) =>
      member.userId !== selfUserId &&
      member.userId !== serviceUserId &&
      !member.email.toLowerCase().endsWith(AGENT_EMAIL_SUFFIX),
  );
}

function localPart(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

export interface LabeledMember {
  member: DriveMember;
  /** The text after "@" in the body. Unique (case-insensitive) in the list. */
  label: string;
}

/**
 * One label per member: the display name, else the email local part, else
 * the email. A label that would read as the `@swarm` marker ("Swarm Fan",
 * "swarm") is reserved: the next form is used. Labels that repeat get the
 * local part appended, then the full email.
 */
export function labelMembers(members: readonly DriveMember[]): LabeledMember[] {
  const base = (member: DriveMember) =>
    [member.displayName?.trim(), localPart(member.email), member.email].find(
      (name) => name && !hasSwarmMarker(`@${name}`),
    ) ?? member.userId;
  const counts = new Map<string, number>();
  for (const member of members) {
    const key = base(member).toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const taken = new Set<string>();
  return members.map((member) => {
    const name = base(member);
    const candidates =
      (counts.get(name.toLowerCase()) ?? 0) > 1
        ? [`${name} (${localPart(member.email)})`, `${name} (${member.email})`]
        : [name];
    const label =
      candidates.find((candidate) => !taken.has(candidate.toLowerCase())) ??
      `${name} (${member.userId})`;
    taken.add(label.toLowerCase());
    return { member, label };
  });
}

/** One row of the picker. */
export interface PickerItem {
  /** cmdk item value. */
  value: string;
  /** Inserted as `@<label>`. */
  label: string;
  detail: string;
  /** The member's user id. Null for the swarm entry. */
  userId: string | null;
}

/**
 * The swarm entry first, then the members whose label, display name, or
 * email contains the query. The detail names the member when the label does
 * not (a reserved label).
 */
export function pickerItems(members: readonly LabeledMember[], query: string): PickerItem[] {
  const q = query.toLowerCase();
  const items: PickerItem[] = [];
  if (SWARM_LABEL.includes(q)) {
    items.push({ value: "swarm", label: SWARM_LABEL, detail: "Send to the swarm", userId: null });
  }
  for (const { member, label } of members) {
    const name = member.displayName?.trim() ?? "";
    if ([label, name, member.email].some((text) => text.toLowerCase().includes(q))) {
      items.push({
        value: `member:${member.userId}`,
        label,
        detail: name && !label.includes(name) ? `${name} · ${member.email}` : member.email,
        userId: member.userId,
      });
    }
  }
  return items;
}

/** Characters that continue a name: "@ann" is not a whole token of "@anna". */
const NAME_CHAR = /[\p{L}\p{N}_-]/u;
/** Characters of a query while typing ("@al", "@ann.lee"). */
const QUERY_CHARS = /[\p{L}\p{N}_.-]*$/u;
const TRAILING_QUERY_CHARS = /^[\p{L}\p{N}_.-]*/u;
/**
 * The longest query the picker reads. `QUERY_CHARS` runs on this many
 * characters before the caret only: on a long unbroken word the regex is
 * quadratic.
 */
const MAX_QUERY_LENGTH = 64;

/** A mention starts at the text start, after whitespace, or after an opening bracket or quote. */
function startsToken(text: string, at: number): boolean {
  return at === 0 || /[\s([{"'“‘]/u.test(text[at - 1]);
}

/** A mention ends at the text end or at a character that cannot continue a name. */
function endsToken(text: string, end: number): boolean {
  const next = text[end];
  if (next === undefined) return true;
  if (NAME_CHAR.test(next)) return false;
  // "@ann." ends a sentence, "@ann.lee" and "@ann@x.io" continue the name.
  if (next === "." || next === "@") {
    const after = text[end + 1];
    return after === undefined || !NAME_CHAR.test(after);
  }
  return true;
}

export interface MentionQuery {
  /** Index of the "@". */
  start: number;
  /** End of the word under the caret (a pick replaces `start..end`). */
  end: number;
  /** The text between "@" and the caret. */
  query: string;
}

/** The mention being typed: the caret follows `@<word chars>` at a word boundary. */
export function activeMentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(Math.max(0, caret - MAX_QUERY_LENGTH), caret);
  const query = QUERY_CHARS.exec(before)?.[0] ?? "";
  const start = caret - query.length - 1;
  if (start < 0 || text[start] !== "@" || !startsToken(text, start)) return null;
  const tail = TRAILING_QUERY_CHARS.exec(text.slice(caret))?.[0] ?? "";
  return { start, end: caret + tail.length, query };
}

/** Replace the typed `@query` with `@label ` and put the caret after it. */
export function insertMention(
  text: string,
  range: { start: number; end: number },
  label: string,
): { text: string; caret: number } {
  const before = text.slice(0, range.start);
  const after = text.slice(range.end);
  const token = `@${label}`;
  // Reuse a space that already follows, so a pick never doubles it.
  const space = after.startsWith(" ") ? "" : " ";
  return { text: `${before}${token}${space}${after}`, caret: before.length + token.length + 1 };
}

/**
 * The longest label (case-insensitive) written as a whole `@label` token at
 * `at`, or null.
 */
function tokenAt<T>(
  text: string,
  at: number,
  labels: ReadonlyArray<readonly [string, T]>,
): { label: string; value: T } | null {
  if (text[at] !== "@" || !startsToken(text, at)) return null;
  for (const [label, value] of labels) {
    const end = at + 1 + label.length;
    if (text.slice(at + 1, end).toLowerCase() !== label.toLowerCase()) continue;
    if (endsToken(text, end)) return { label: text.slice(at + 1, end), value };
  }
  return null;
}

function byLengthDesc<T>(entries: Iterable<readonly [string, T]>): Array<readonly [string, T]> {
  return [...entries].filter(([label]) => label !== "").sort(([a], [b]) => b.length - a.length);
}

/**
 * The user ids of the picked labels (`@label` -> user id, the picks of this
 * composer) that still appear in the body, in body order, without
 * duplicates. A deleted token drops its mention. A typed name that the human
 * did not pick is plain text.
 */
export function collectMentionIds(body: string, picked: ReadonlyMap<string, string>): string[] {
  const sorted = byLengthDesc(picked);
  const ids: string[] = [];
  for (let at = body.indexOf("@"); at !== -1; at = body.indexOf("@", at + 1)) {
    const token = tokenAt(body, at, sorted);
    if (!token) continue;
    if (!ids.includes(token.value)) ids.push(token.value);
    at += token.label.length;
  }
  return ids;
}

export type MentionSegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; text: string; mention: CommentMention };

/**
 * Split plain text into text and `@name` tokens of the comment's mentions.
 * A token can be any label the picker writes (display name, email local
 * part, a disambiguated label) or the email. Agents may write any of them.
 */
export function splitMentions(
  text: string,
  mentions: readonly CommentMention[] | undefined,
): MentionSegment[] {
  if (!mentions || mentions.length === 0 || !text.includes("@")) return [{ kind: "text", text }];
  const labels = byLengthDesc(
    mentions.flatMap((mention) => {
      const local = localPart(mention.email);
      const name = mention.displayName?.trim() || local;
      return [name, local, mention.email, `${name} (${local})`, `${name} (${mention.email})`].map(
        (label) => [label, mention] as const,
      );
    }),
  );
  const segments: MentionSegment[] = [];
  let last = 0;
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    const token = tokenAt(text, at, labels);
    if (!token) continue;
    if (at > last) segments.push({ kind: "text", text: text.slice(last, at) });
    const end = at + 1 + token.label.length;
    segments.push({ kind: "mention", text: text.slice(at, end), mention: token.value });
    last = end;
    at = end - 1;
  }
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
  return segments;
}

/**
 * The picks of a saved comment (`label` -> user id, the composer's `picked`
 * shape): each `@label` token of its mentions (`splitMentions`). An edit
 * starts from them, so the mentions it keeps stay mentions.
 */
export function mentionPicks(
  text: string,
  mentions: readonly CommentMention[] | undefined,
): Map<string, string> {
  const picks = new Map<string, string>();
  for (const segment of splitMentions(text, mentions)) {
    if (segment.kind === "mention") picks.set(segment.text.slice(1), segment.mention.userId);
  }
  return picks;
}

/**
 * The Comb route of a mention notification: the file, with its thread
 * selected (`?comment=` is the root, so a reply opens its thread). The stored
 * path can come in either form ("docs/a.md" or "/docs/a.md").
 */
export function mentionRoute(
  drive: { orgId: string; driveId: string },
  entry: Pick<CommentNotificationEntry, "path" | "commentId" | "parentId">,
): string {
  const path = commentCombPath(entry.path);
  const thread = entry.parentId ?? entry.commentId;
  return `${combPath({ ...drive, path })}?comment=${encodeURIComponent(thread)}`;
}

/**
 * The mention list after a `comment-notification-read`: `ids` (every entry
 * when null) marked read and the unread count lowered to match, never below 0.
 */
export function markMentionsRead(
  list: CommentNotificationListResult,
  ids: readonly string[] | null,
): CommentNotificationListResult {
  let newlyRead = 0;
  const notifications = list.notifications.map((entry) => {
    if (entry.read || (ids !== null && !ids.includes(entry.id))) return entry;
    newlyRead += 1;
    return { ...entry, read: true };
  });
  const unreadCount = ids === null ? 0 : Math.max(0, list.unreadCount - newlyRead);
  return { notifications, unreadCount };
}
