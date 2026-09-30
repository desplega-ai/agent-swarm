// Comment drafts and the comment outbox. Both live only in this browser's
// localStorage, namespaced by the swarm API URL (`deriveStorageKey`), the
// agent-fs URL, the connected agent-fs user, the drive, and the file.
//
// - A draft is the text in one composer. It survives a reload and expires
//   after 7 days.
// - The outbox keeps comments that failed to post because of a network error
//   or a 5xx, so the rail can show them as "Not sent" with Retry and Discard.
//
// Relative imports only: `bun:test` runs this from the repo root.

import { deriveStorageKey } from "../../hooks/use-dismissible-card-key";
import { AgentFsError } from "../agent-fs/client";
import type {
  CommentAddParams,
  CommentEntry,
  CommentListEntry,
  CommentQuote,
} from "../agent-fs/types";
import { commentWritePath } from "./comments";

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** `localStorage`, or null where it is missing or blocked. */
export function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Drafts older than this are dropped when read. */
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** One file in one drive, as seen by one agent-fs user from one swarm. */
export interface CommentScope {
  apiUrl: string;
  endpoint: string;
  /** The connected agent-fs user. Another user never sees these drafts or this outbox. */
  userId: string;
  orgId: string;
  driveId: string;
  path: string;
}

function scopeId(scope: CommentScope): string {
  return `${scope.endpoint}:${scope.userId}:${scope.orgId}/${scope.driveId}:${scope.path}`;
}

/** In every full draft key (after `deriveStorageKey`'s prefix). */
const DRAFT_KEY_PART = ":comb:draft:";

/**
 * The composer a draft belongs to: a reply (the parent id), an anchored
 * comment (`anchorKeyOf`), or the file-level composer ("file").
 */
export function draftStorageKey(scope: CommentScope, slot: string): string {
  return deriveStorageKey(scope.apiUrl, `comb:draft:${scopeId(scope)}:${slot}`);
}

/** A stable slot for an anchored draft: the lines plus a short hash of the quote. */
export function anchorKeyOf(anchor: {
  lineStart?: number;
  lineEnd?: number;
  quote?: CommentQuote;
}): string {
  const quote = anchor.quote;
  const text = quote ? `${quote.prefix ?? ""}\u0000${quote.exact}\u0000${quote.suffix ?? ""}` : "";
  return `anchor:${anchor.lineStart ?? 0}-${anchor.lineEnd ?? 0}:${hashText(text)}`;
}

/** djb2, base 36. A key part, not a security boundary. */
function hashText(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

interface StoredDraft {
  text: string;
  savedAt: number;
  /** step-8: the mentions picked in this composer, as `[label, userId]` pairs. */
  mentions?: Array<[string, string]>;
}

/** The saved draft, or null. An expired or unreadable draft is removed. */
function readStoredDraft(
  storage: DraftStorage | null,
  key: string,
  now: number,
): StoredDraft | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredDraft> | null;
    if (
      !value ||
      typeof value.text !== "string" ||
      typeof value.savedAt !== "number" ||
      now - value.savedAt > DRAFT_MAX_AGE_MS
    ) {
      storage.removeItem(key);
      return null;
    }
    return value as StoredDraft;
  } catch {
    clearDraft(storage, key);
    return null;
  }
}

/** The saved draft text, or "". An expired or unreadable draft is removed. */
export function readDraft(storage: DraftStorage | null, key: string, now: number): string {
  return readStoredDraft(storage, key, now)?.text ?? "";
}

function isLabelPair(value: unknown): value is [string, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "string"
  );
}

/** step-8: the mentions picked in the saved draft (`@label` -> user id). Empty without a draft. */
export function readDraftMentions(
  storage: DraftStorage | null,
  key: string,
  now: number,
): Map<string, string> {
  const pairs = readStoredDraft(storage, key, now)?.mentions;
  return new Map(Array.isArray(pairs) ? pairs.filter(isLabelPair) : []);
}

/** Save the draft with its picked mentions (step-8). Blank text removes it. */
export function writeDraft(
  storage: DraftStorage | null,
  key: string,
  text: string,
  now: number,
  mentions?: ReadonlyMap<string, string>,
): void {
  if (!storage) return;
  try {
    if (text.trim() === "") storage.removeItem(key);
    else {
      const draft: StoredDraft = { text, savedAt: now };
      if (mentions && mentions.size > 0) draft.mentions = [...mentions];
      storage.setItem(key, JSON.stringify(draft));
    }
  } catch {
    // A full or blocked localStorage only loses the draft.
  }
}

export function clearDraft(storage: DraftStorage | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Nothing to clear.
  }
}

/**
 * Remove every expired or unreadable Comb draft, for every file and user.
 * Otherwise a draft is dropped only when its own composer reads it.
 */
export function sweepExpiredDrafts(
  storage: (DraftStorage & Pick<Storage, "key" | "length">) | null,
  now: number,
): void {
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.includes(DRAFT_KEY_PART)) keys.push(key);
    }
    for (const key of keys) readDraft(storage, key, now);
  } catch {
    // A blocked localStorage has nothing to sweep.
  }
}

// --- Send errors --------------------------------------------------------------

/**
 * True when a failed `comment-add` belongs in the outbox: no response at all
 * (status 0) or a server error. A 4xx will fail again the same way, so the
 * composer shows it inline instead.
 */
export function isRetryableSendError(error: unknown): boolean {
  if (!(error instanceof AgentFsError)) return true;
  return error.status === 0 || error.status >= 500;
}

/**
 * Where the composer routes a failed `comment-add`: a 403 means the human is
 * a drive viewer ("read-only"), a network error or a 5xx goes to the outbox,
 * and any other error shows inline under the text.
 */
export function sendFailureRoute(error: unknown): "read-only" | "outbox" | "inline" {
  if (error instanceof AgentFsError && error.status === 403) return "read-only";
  return isRetryableSendError(error) ? "outbox" : "inline";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- Outbox -----------------------------------------------------------------

/** One comment that failed to post. `params` is the exact `comment-add` body. */
export interface OutboxEntry {
  id: string;
  /** The agent-fs user who wrote it. Entries of another user are never sent. */
  userId: string;
  params: CommentAddParams;
  /** ISO timestamp of the first attempt. */
  createdAt: string;
  /** Why the last attempt failed. */
  error: string;
}

export function outboxStorageKey(scope: CommentScope): string {
  return deriveStorageKey(scope.apiUrl, `comb:outbox:${scopeId(scope)}`);
}

function isOutboxEntry(value: unknown): value is OutboxEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<OutboxEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.userId === "string" &&
    typeof entry.createdAt === "string" &&
    typeof entry.error === "string" &&
    !!entry.params &&
    typeof entry.params.body === "string"
  );
}

/** The entries in a stored outbox value. Unreadable data reads as empty. */
export function parseOutbox(raw: string | null): OutboxEntry[] {
  try {
    const value = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(value) ? value.filter(isOutboxEntry) : [];
  } catch {
    return [];
  }
}

export function readOutbox(storage: DraftStorage | null, key: string): OutboxEntry[] {
  try {
    return parseOutbox(storage?.getItem(key) ?? null);
  } catch {
    return [];
  }
}

export function writeOutbox(
  storage: DraftStorage | null,
  key: string,
  entries: OutboxEntry[],
): void {
  if (!storage) return;
  try {
    if (entries.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(entries));
  } catch {
    // A full or blocked localStorage only loses the outbox.
  }
}

export function addToOutbox(
  entries: OutboxEntry[],
  entry: { id: string; userId: string; params: CommentAddParams; error: string; now: Date },
): OutboxEntry[] {
  return [
    ...entries,
    {
      id: entry.id,
      userId: entry.userId,
      params: entry.params,
      createdAt: entry.now.toISOString(),
      error: entry.error,
    },
  ];
}

export function discardFromOutbox(entries: OutboxEntry[], id: string): OutboxEntry[] {
  return entries.filter((entry) => entry.id !== id);
}

/**
 * Take the matching entries out of the stored outbox, so no other tab sends
 * them too. Returns the entries taken.
 */
export function claimOutbox(
  storage: DraftStorage | null,
  key: string,
  pick: (entry: OutboxEntry) => boolean,
): OutboxEntry[] {
  const all = readOutbox(storage, key);
  const claimed = all.filter(pick);
  if (claimed.length > 0) {
    writeOutbox(
      storage,
      key,
      all.filter((entry) => !claimed.includes(entry)),
    );
  }
  return claimed;
}

/** Put entries back (a failed send, or a page that closes mid-send), oldest first. */
export function returnToOutbox(
  storage: DraftStorage | null,
  key: string,
  entries: OutboxEntry[],
): void {
  if (entries.length === 0) return;
  const byId = new Map(readOutbox(storage, key).map((entry) => [entry.id, entry]));
  for (const entry of entries) byId.set(entry.id, entry);
  writeOutbox(
    storage,
    key,
    [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  );
}

/**
 * How far agent-fs's clock may run behind this browser's clock when
 * `alreadyPosted` matches a send whose answer was lost.
 */
const SEND_CLOCK_SKEW_MS = 60_000;

/**
 * True when an earlier send of `entry` landed although its answer was lost:
 * the file's threads hold a comment by the entry's user with the same body
 * on the same target (the file path, or the parent thread), made at or after
 * the first attempt.
 */
export function alreadyPosted(entry: OutboxEntry, threads: CommentListEntry[]): boolean {
  const since = Date.parse(entry.createdAt) - SEND_CLOCK_SKEW_MS;
  const { params } = entry;
  const same = (comment: CommentEntry) =>
    comment.author === entry.userId &&
    comment.body === params.body &&
    Date.parse(comment.createdAt) >= since;
  if (params.parentId) {
    return threads.some(
      (thread) => thread.id === params.parentId && thread.replies.some((reply) => same(reply)),
    );
  }
  const path = commentWritePath(params.path ?? "");
  return threads.some((thread) => commentWritePath(thread.path) === path && same(thread));
}

/** The part of the Web Locks API (`navigator.locks`) the outbox uses. */
export interface OutboxLocks {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export interface OutboxRetryOptions {
  storage: DraftStorage | null;
  key: string;
  /** The connected user. Only their entries are sent. */
  userId: string;
  /** Send only these entries (per-entry Retry). Absent: every entry of the user. */
  ids?: ReadonlySet<string>;
  send: (params: CommentAddParams) => Promise<unknown>;
  /** The file's threads now: an entry that already landed is dropped, not sent again. */
  fetchThreads: () => Promise<CommentListEntry[]>;
  /**
   * Claimed entries while they are sent. The rail still shows them, and a
   * page that closes mid-send puts them back. An entry that leaves this map
   * before its turn is not sent.
   */
  inFlight: Map<string, OutboxEntry>;
  onChange?: () => void;
  /** `navigator.locks`: one retry per outbox at a time, across tabs. */
  locks?: OutboxLocks | null;
}

/**
 * Send outbox entries again, in order. The entries are claimed first (taken
 * out of storage), so two tabs never send the same one. A sent or already
 * posted entry leaves the outbox. A failed one goes back with its new error
 * (a 4xx included, so the human can read it and discard).
 */
export async function retryOutboxEntries(opts: OutboxRetryOptions): Promise<void> {
  const { storage, key, userId, ids, inFlight, onChange } = opts;
  const settle = (entry: OutboxEntry, error?: unknown) => {
    if (!inFlight.delete(entry.id)) return;
    if (error !== undefined) {
      returnToOutbox(storage, key, [{ ...entry, error: errorMessage(error) }]);
    }
  };

  const run = async () => {
    const claimed = claimOutbox(
      storage,
      key,
      (entry) => entry.userId === userId && (!ids || ids.has(entry.id)),
    );
    if (claimed.length === 0) return;
    for (const entry of claimed) inFlight.set(entry.id, entry);
    onChange?.();

    let threads: CommentListEntry[];
    try {
      threads = await opts.fetchThreads();
    } catch (error) {
      // Without the current threads a resend could post twice: keep them all.
      for (const entry of claimed) settle(entry, error);
      onChange?.();
      return;
    }
    for (const entry of claimed) {
      if (!inFlight.has(entry.id)) continue;
      if (alreadyPosted(entry, threads)) {
        settle(entry);
      } else {
        try {
          await opts.send(entry.params);
          settle(entry);
        } catch (error) {
          settle(entry, error);
        }
      }
      onChange?.();
    }
  };

  if (opts.locks) await opts.locks.request(key, run);
  else await run();
}
