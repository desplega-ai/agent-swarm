// "Review changes" helpers: the `?diff=<from>..<to>` URL state, the versions
// a thread's review compares, and the review's decisions (which files show
// the entry points, when a range opens, when Revert shows, and what a
// failed revert means).
//
// Relative imports only: `bun:test` runs this from the repo root.

import { AgentFsError } from "../agent-fs/client";
import type { DiffChange, StatResult } from "../agent-fs/types";
import { commentFileVersion } from "./comments";
import { diffHasChanges } from "./diff-lines";
import { type FileKind, getFileKind } from "./file-kinds";

/** The query parameter of the review view: `?diff=<from>..<to>`. */
export const DIFF_PARAM = "diff";

/** Two versions of one file, `from < to`. */
export interface DiffRange {
  from: number;
  to: number;
}

/**
 * `?diff=` as a range. The pair is ordered (`3..1` reads as 1 to 3). Null
 * when it is missing, not two positive integers, or one version twice.
 */
export function parseDiffRange(value: string | null): DiffRange | null {
  const match = value?.match(/^(\d+)\.\.(\d+)$/);
  if (!match) return null;
  const a = Number(match[1]);
  const b = Number(match[2]);
  if (a < 1 || b < 1 || a === b || !Number.isSafeInteger(a) || !Number.isSafeInteger(b)) {
    return null;
  }
  return { from: Math.min(a, b), to: Math.max(a, b) };
}

export function formatDiffRange({ from, to }: DiffRange): string {
  return `${from}..${to}`;
}

/** The kinds Comb compares: agent-fs diffs text line by line. */
const REVIEW_KINDS: ReadonlySet<FileKind> = new Set(["markdown", "text", "table"]);

type ReviewStat = Pick<StatResult, "contentType" | "size" | "currentVersion">;

/**
 * Show "Review changes" and the Versions menu: the file has a version and
 * opens as markdown, text, or a table. Images, PDFs, video, and other
 * binary files have no line diff.
 */
export function showReviewEntry(path: string, stat: ReviewStat): boolean {
  return (
    stat.currentVersion !== undefined &&
    REVIEW_KINDS.has(getFileKind(path, stat.contentType, stat.size))
  );
}

/**
 * Why `?diff=` cannot open as a review of this file, as a notice for the
 * normal file view. Null when the review can open. A `to` past the current
 * version is a bad link, or a `stat` that has not caught up yet (the review
 * opens when it does).
 */
export function reviewRangeNotice(range: DiffRange, path: string, stat: ReviewStat): string | null {
  const current = stat.currentVersion;
  if (current === undefined) return "This file has no versions to compare.";
  if (!showReviewEntry(path, stat)) return "Comb compares versions of text files only.";
  if (range.to > current)
    return `This file has no v${range.to}. The latest version is v${current}.`;
  return null;
}

/**
 * What a thread's "Review changes" compares: the version the comment was
 * made on (`commentFileVersion`, from the file's `log` when the comment has
 * no `fileVersion`), and the current version. Null when the file has no
 * newer version, or the comment's version is unknown.
 */
export function reviewRange(
  thread: { fileVersion?: number; createdAt: string },
  currentVersion: number | undefined,
  versions?: ReadonlyArray<{ version: number; createdAt: string }>,
): DiffRange | null {
  if (currentVersion === undefined) return null;
  const from = commentFileVersion(thread, versions);
  return from !== undefined && from >= 1 && from < currentVersion
    ? { from, to: currentVersion }
    : null;
}

/** The review shows this thread's own changes, so it may resolve the thread. */
export function reviewsThread(
  thread: { fileVersion?: number; createdAt: string },
  range: DiffRange,
  currentVersion: number | undefined,
  versions?: ReadonlyArray<{ version: number; createdAt: string }>,
): boolean {
  const own = reviewRange(thread, currentVersion, versions);
  return own !== null && own.from === range.from && own.to === range.to;
}

/** The current version when it is past the reviewed head `to`, else null. */
export function newerVersion(currentVersion: number | undefined, to: number): number | null {
  return currentVersion !== undefined && currentVersion > to ? currentVersion : null;
}

/**
 * Revert shows only after the human has seen a real diff of the head: the
 * diff loaded and changes something, `to` is the current version, and no
 * revert of this review answered 409 since `stat` was last reloaded.
 */
export function canRevert(review: {
  /** The loaded diff. Undefined while it loads, or when it failed. */
  changes: readonly DiffChange[] | undefined;
  currentVersion: number | undefined;
  to: number;
  /** A revert of this review answered 409, and `stat` has not been reloaded since. */
  stale: boolean;
}): boolean {
  return (
    !review.stale &&
    review.currentVersion === review.to &&
    review.changes !== undefined &&
    diffHasChanges(review.changes)
  );
}

export type RevertOutcome =
  | { kind: "reverted" }
  /** 403: the human is a drive viewer. */
  | { kind: "read-only" }
  /**
   * 409: the file moved on since the reviewed head, and agent-fs wrote
   * nothing. `newer` is the new head when `stat` knows it already (Reload
   * moves the diff there). Null: `stat` must reload first, and `message`
   * (the server's) says what happened.
   */
  | { kind: "stale"; newer: number | null; message: string }
  | { kind: "failed"; message: string };

/** What a revert answered, for a review whose head is `to`. `error` null: it landed. */
export function revertOutcome(
  error: unknown,
  currentVersion: number | undefined,
  to: number,
): RevertOutcome {
  if (error == null) return { kind: "reverted" };
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof AgentFsError && error.status === 403) return { kind: "read-only" };
  if (error instanceof AgentFsError && error.status === 409) {
    return { kind: "stale", newer: newerVersion(currentVersion, to), message };
  }
  return { kind: "failed", message };
}
