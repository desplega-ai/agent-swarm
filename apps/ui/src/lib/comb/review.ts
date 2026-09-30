// "Review changes" helpers: the `?diff=<from>..<to>` URL state and the
// versions a thread's review compares.
//
// Relative imports only: `bun:test` runs this from the repo root.

import { COMB_LOG_LIMIT, versionAt } from "./comments";

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

/**
 * What a thread's "Review changes" compares: the version the comment was
 * made on, and the current version. A comment without `fileVersion` (the
 * live/ path form on older agent-fs) takes it from the file's `log` (newest
 * first), like the anchors do. Null when the file has no newer version, or
 * the comment's version is unknown.
 */
export function reviewRange(
  thread: { fileVersion?: number; createdAt: string },
  currentVersion: number | undefined,
  versions?: ReadonlyArray<{ version: number; createdAt: string }>,
): DiffRange | null {
  if (currentVersion === undefined) return null;
  const from =
    thread.fileVersion ??
    (versions
      ? versionAt(versions, thread.createdAt, versions.length < COMB_LOG_LIMIT)
      : undefined);
  return from !== undefined && from >= 1 && from < currentVersion
    ? { from, to: currentVersion }
    : null;
}
