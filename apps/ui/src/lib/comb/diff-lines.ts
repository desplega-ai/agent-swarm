// Rows for Comb's diff view (`components/comb/review/diff-viewer.tsx`).
//
// Line numbers: agent-fs 0.15.0 sends each change's `oldLine` / `newLine`
// (1-based, per hunk). Older servers, and the `diffSummary` fallback of a
// backend without versioning, send none. Then the numbers count from line 1,
// like live/'s DiffViewer (agent-fs `live/src/components/viewers/DiffViewer.tsx`).
//
// Relative imports only: `bun:test` runs this from the repo root.

import type { DiffChange } from "../agent-fs/types";

export interface DiffLine {
  type: DiffChange["type"];
  content: string;
  /** Line in the older version. Absent on added lines and on unnumbered markers. */
  oldLine?: number;
  /** Line in the newer version. Absent on removed lines and on unnumbered markers. */
  newLine?: number;
}

/** Unchanged lines that stay visible next to a change when a run folds. */
export const DIFF_CONTEXT_LINES = 3;
/** An unchanged run folds only when it hides at least this many lines. */
export const DIFF_FOLD_MIN_LINES = 4;

/** Line numbers for each change: agent-fs's own when it sends them, else counted like live/. */
export function diffLines(changes: readonly DiffChange[]): DiffLine[] {
  const numbered = changes.some((c) => c.oldLine !== undefined || c.newLine !== undefined);
  if (numbered) {
    // A "\ No newline at end of file" marker has no numbers and keeps none.
    return changes.map(({ type, content, oldLine, newLine }) => ({
      type,
      content,
      oldLine,
      newLine,
    }));
  }
  let oldLine = 0;
  let newLine = 0;
  return changes.map(({ type, content }) => {
    if (type === "add") return { type, content, newLine: ++newLine };
    if (type === "remove") return { type, content, oldLine: ++oldLine };
    return { type, content, oldLine: ++oldLine, newLine: ++newLine };
  });
}

export type DiffRow =
  /** `index` is the line's position in the `diffLines` output. */
  | { kind: "line"; index: number; line: DiffLine }
  /** Unchanged lines the diff leaves out (before a hunk). `before` is the next line's index. */
  | { kind: "gap"; before: number; lines: number }
  /** A folded run of unchanged lines. `id` (its first hidden line's index) unfolds it. */
  | { kind: "fold"; id: number; lines: number };

/**
 * The rows to render: every line, a gap row where the line numbers jump
 * (between hunks), and a fold for each long unchanged run. A fold keeps
 * `DIFF_CONTEXT_LINES` lines next to each change and hides the rest, unless
 * its id is in `unfolded`.
 */
export function diffRows(
  lines: readonly DiffLine[],
  unfolded: ReadonlySet<number> = new Set(),
): DiffRow[] {
  const rows: DiffRow[] = [];
  let run: number[] = [];
  let changeBefore = false;
  let lastOld = 0;
  let lastNew = 0;

  const flushRun = (changeAfter: boolean) => {
    const keepHead = changeBefore ? DIFF_CONTEXT_LINES : 0;
    const keepTail = changeAfter ? DIFF_CONTEXT_LINES : 0;
    const hidden = run.length - keepHead - keepTail;
    const id = run[keepHead] as number;
    if (hidden >= DIFF_FOLD_MIN_LINES && !unfolded.has(id)) {
      for (const index of run.slice(0, keepHead)) rows.push(lineRow(lines, index));
      rows.push({ kind: "fold", id, lines: hidden });
      for (const index of run.slice(run.length - keepTail)) rows.push(lineRow(lines, index));
    } else {
      for (const index of run) rows.push(lineRow(lines, index));
    }
    run = [];
  };

  lines.forEach((line, index) => {
    const skipped =
      line.oldLine !== undefined
        ? line.oldLine - lastOld - 1
        : line.newLine !== undefined
          ? line.newLine - lastNew - 1
          : 0;
    if (skipped > 0) {
      flushRun(false);
      rows.push({ kind: "gap", before: index, lines: skipped });
      changeBefore = false;
    }
    if (line.oldLine !== undefined) lastOld = line.oldLine;
    if (line.newLine !== undefined) lastNew = line.newLine;

    if (line.type === "context") {
      run.push(index);
    } else {
      flushRun(true);
      rows.push(lineRow(lines, index));
      changeBefore = true;
    }
  });
  flushRun(false);
  return rows;
}

function lineRow(lines: readonly DiffLine[], index: number): DiffRow {
  return { kind: "line", index, line: lines[index] as DiffLine };
}

/** The diff changes something (a diff of equal versions has only context, or nothing). */
export function diffHasChanges(changes: readonly DiffChange[]): boolean {
  return changes.some((change) => change.type !== "context");
}
