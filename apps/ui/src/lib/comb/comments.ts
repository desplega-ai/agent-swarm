// Comment helpers that do not need React.
//
// agent-fs stores a comment's path exactly as the client sent it. live/, the
// CLI, and the swarm API send drive paths without the leading "/"
// ("docs/a.md"). Other clients (an agent that copied `stat.path`) send
// "/docs/a.md". `comment-list {path}` matches exactly, so Comb reads both
// forms and writes the live/ form, which live/ and the CLI then see.
//
// Relative imports only: `bun:test` runs this from the repo root.

import type { CommentListEntry } from "../agent-fs/types";
import { type AnchorInput, commentAnchorInput } from "./comment-anchor";

/** The path Comb writes on a new root comment: the live/ form, no leading "/". */
export function commentWritePath(path: string): string {
  return path.replace(/^\/+/, "");
}

/** Every stored form of a Comb file path: the live/ form first, then "/"-prefixed. */
export function commentReadPaths(path: string): [string, string] {
  const bare = commentWritePath(path);
  return [bare, `/${bare}`];
}

/** One thread list from several `comment-list` answers: no duplicates, newest first. */
export function mergeCommentLists(lists: CommentListEntry[][]): CommentListEntry[] {
  const byId = new Map<string, CommentListEntry>();
  for (const list of lists) for (const comment of list) byId.set(comment.id, comment);
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Root threads per `comment-list` page. */
export const COMMENT_PAGE_SIZE = 200;
/** Comb lists at most this many threads per file (the newest). */
export const COMMENT_LIST_MAX = 2000;

export interface FileThreads {
  /** Every root thread (open and resolved), newest first, with its replies. */
  threads: CommentListEntry[];
  /** More than `COMMENT_LIST_MAX` threads exist: only the newest are here. */
  truncated: boolean;
}

/**
 * Every root thread of a file: pages through `comment-list` for each stored
 * path form until a short page, and stops at `COMMENT_LIST_MAX` threads.
 */
export async function listFileThreads(
  paths: readonly string[],
  fetchPage: (path: string, offset: number, limit: number) => Promise<CommentListEntry[]>,
): Promise<FileThreads> {
  let truncated = false;
  const lists = await Promise.all(
    paths.map(async (path) => {
      const threads: CommentListEntry[] = [];
      for (let offset = 0; ; offset += COMMENT_PAGE_SIZE) {
        const page = await fetchPage(path, offset, COMMENT_PAGE_SIZE);
        threads.push(...page);
        if (page.length < COMMENT_PAGE_SIZE) break;
        if (threads.length >= COMMENT_LIST_MAX) {
          truncated = true;
          break;
        }
      }
      return threads;
    }),
  );
  const threads = mergeCommentLists(lists);
  if (threads.length > COMMENT_LIST_MAX) truncated = true;
  return { threads: threads.slice(0, COMMENT_LIST_MAX), truncated };
}

/** Versions per `log` call (Comb's `agentFsLogQuery`). */
export const COMB_LOG_LIMIT = 200;

/**
 * The file version a comment was made on, from the file's `log` (newest
 * first): the newest version written at or before the comment.
 *
 * agent-fs sets `fileVersion` only when the stored comment path matches the
 * file path exactly, so comments in the live/ form (no leading "/") come
 * without it (fixed upstream in agent-fs PR #69; older comments and servers
 * still need this). When `complete` is false (the log hit its limit) and no
 * listed version is old enough, the oldest listed version stands in: the
 * comment is older than it, so it is at least that stale. Undefined only
 * when the full log has no version that old.
 */
export function versionAt(
  versions: ReadonlyArray<{ version: number; createdAt: string }>,
  createdAt: string,
  complete = true,
): number | undefined {
  const at = Date.parse(createdAt);
  let found: number | undefined;
  let oldest: number | undefined;
  for (const entry of versions) {
    if (oldest === undefined || entry.version < oldest) oldest = entry.version;
    if (Date.parse(entry.createdAt) <= at && (found === undefined || entry.version > found)) {
      found = entry.version;
    }
  }
  return found ?? (complete ? undefined : oldest);
}

/** The file's `log` as `anchorInputs` sees it. */
export interface AnchorLog {
  /** The log is still loading: comments that need it wait. */
  loading: boolean;
  versions?: ReadonlyArray<{ version: number; createdAt: string }>;
}

/**
 * The anchor input of every anchored comment (file-level comments have
 * none). A comment without `fileVersion` takes it from the log (`versionAt`),
 * and waits while the log loads rather than trust its stored lines too early.
 */
export function anchorInputs(
  comments: ReadonlyArray<CommentListEntry>,
  currentVersion: number | undefined,
  log: AnchorLog,
): Array<{ id: string; version?: number; input: AnchorInput }> {
  const complete = (log.versions?.length ?? 0) < COMB_LOG_LIMIT;
  const out: Array<{ id: string; version?: number; input: AnchorInput }> = [];
  for (const comment of comments) {
    let fileVersion = comment.fileVersion;
    if (fileVersion == null) {
      if (log.loading) continue;
      fileVersion = log.versions ? versionAt(log.versions, comment.createdAt, complete) : undefined;
    }
    const entry = commentAnchorInput({ ...comment, fileVersion }, currentVersion);
    if (entry) out.push({ id: comment.id, ...entry }); // null: file-level comment
  }
  return out;
}

/** `author → authorDisplayName` over every loaded comment and reply that has a name. */
export function commentAuthorNames({ threads }: FileThreads): Map<string, string> {
  const names = new Map<string, string>();
  for (const thread of threads) {
    for (const entry of [thread, ...thread.replies]) {
      if (entry.authorDisplayName) names.set(entry.author, entry.authorDisplayName);
    }
  }
  return names;
}
