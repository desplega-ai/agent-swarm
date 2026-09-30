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

/**
 * The file version a comment was made on, from the file's `log`: the newest
 * version written at or before the comment. agent-fs sets `fileVersion` only
 * when the stored comment path matches the file path exactly, so comments in
 * the live/ form (no leading "/") come without it. Undefined when no version
 * is that old.
 */
export function versionAt(
  versions: ReadonlyArray<{ version: number; createdAt: string }>,
  createdAt: string,
): number | undefined {
  const at = Date.parse(createdAt);
  let found: number | undefined;
  for (const entry of versions) {
    if (Date.parse(entry.createdAt) <= at && (found === undefined || entry.version > found)) {
      found = entry.version;
    }
  }
  return found;
}
