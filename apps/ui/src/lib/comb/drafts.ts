// Comment drafts and the comment outbox. Both live only in this browser's
// localStorage, namespaced by the swarm API URL (`deriveStorageKey`), the
// agent-fs URL, the drive, and the file.
//
// - A draft is the text in one composer. It survives a reload and expires
//   after 7 days.
// - The outbox keeps comments that failed to post because of a network error
//   or a 5xx, so the rail can show them as "Not sent" with Retry and Discard.
//
// Relative imports only: `bun:test` runs this from the repo root.

import { deriveStorageKey } from "../../hooks/use-dismissible-card-key";
import { AgentFsError } from "../agent-fs/client";
import type { CommentAddParams, CommentQuote } from "../agent-fs/types";

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Drafts older than this are dropped when read. */
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** One file in one drive, as seen from one swarm and one agent-fs server. */
export interface CommentScope {
  apiUrl: string;
  endpoint: string;
  orgId: string;
  driveId: string;
  path: string;
}

function scopeId(scope: CommentScope): string {
  return `${scope.endpoint}:${scope.orgId}/${scope.driveId}:${scope.path}`;
}

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
}

/** The saved draft text, or "". An expired or unreadable draft is removed. */
export function readDraft(storage: DraftStorage | null, key: string, now: number): string {
  if (!storage) return "";
  try {
    const raw = storage.getItem(key);
    if (!raw) return "";
    const value = JSON.parse(raw) as Partial<StoredDraft> | null;
    if (
      !value ||
      typeof value.text !== "string" ||
      typeof value.savedAt !== "number" ||
      now - value.savedAt > DRAFT_MAX_AGE_MS
    ) {
      storage.removeItem(key);
      return "";
    }
    return value.text;
  } catch {
    return "";
  }
}

/** Save the draft. Blank text removes it. */
export function writeDraft(
  storage: DraftStorage | null,
  key: string,
  text: string,
  now: number,
): void {
  if (!storage) return;
  try {
    if (text.trim() === "") storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ text, savedAt: now } satisfies StoredDraft));
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

// --- Outbox -----------------------------------------------------------------

/** One comment that failed to post. `params` is the exact `comment-add` body. */
export interface OutboxEntry {
  id: string;
  params: CommentAddParams;
  /** ISO timestamp of the first attempt. */
  createdAt: string;
  /** Why the last attempt failed. */
  error: string;
}

export function outboxStorageKey(scope: CommentScope): string {
  return deriveStorageKey(scope.apiUrl, `comb:outbox:${scopeId(scope)}`);
}

/**
 * True when a failed `comment-add` belongs in the outbox: no response at all
 * (status 0) or a server error. A 4xx will fail again the same way, so the
 * composer shows it inline instead.
 */
export function isRetryableSendError(error: unknown): boolean {
  if (!(error instanceof AgentFsError)) return true;
  return error.status === 0 || error.status >= 500;
}

function isOutboxEntry(value: unknown): value is OutboxEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<OutboxEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.createdAt === "string" &&
    typeof entry.error === "string" &&
    !!entry.params &&
    typeof entry.params.body === "string"
  );
}

export function readOutbox(storage: DraftStorage | null, key: string): OutboxEntry[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(key);
    const value = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(value) ? value.filter(isOutboxEntry) : [];
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
  entry: { id: string; params: CommentAddParams; error: string; now: Date },
): OutboxEntry[] {
  return [
    ...entries,
    { id: entry.id, params: entry.params, createdAt: entry.now.toISOString(), error: entry.error },
  ];
}

export function discardFromOutbox(entries: OutboxEntry[], id: string): OutboxEntry[] {
  return entries.filter((entry) => entry.id !== id);
}

/**
 * Send outbox entries again, in order. A sent entry leaves the outbox. A
 * failed one stays with its new error (a 4xx included, so the human can read
 * it and discard). Returns the entries that are left.
 */
export async function retryOutbox(
  entries: OutboxEntry[],
  send: (params: CommentAddParams) => Promise<unknown>,
): Promise<OutboxEntry[]> {
  const left: OutboxEntry[] = [];
  for (const entry of entries) {
    try {
      await send(entry.params);
    } catch (error) {
      left.push({ ...entry, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return left;
}
