// Rows for Comb's diff view (`components/comb/review/diff-viewer.tsx`).
//
// Line numbers: agent-fs 0.15.0 sends each change's `oldLine` / `newLine`
// (1-based, per hunk). Older servers, and the `diffSummary` fallback of a
// backend without versioning, send none. Then the numbers count from line 1,
// like live/'s DiffViewer (agent-fs `live/src/components/viewers/DiffViewer.tsx`).
//
// No folds ("Show N unchanged lines"): agent-fs sends 4 unchanged lines
// around each change, so an unchanged run inside a hunk is at most 8 lines,
// too short to fold. The lines between hunks show as a gap row.
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

/** The diff view renders at most this many rows, then a "too large" row. */
export const DIFF_MAX_ROWS = 5000;

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
  /** The last row of a diff with more than `maxRows` rows: `lines` diff lines are not shown. */
  | { kind: "cap"; lines: number };

/**
 * The rows to render: every line, and a gap row where the line numbers jump
 * (between hunks). Past `maxRows` rows, one "cap" row replaces the rest.
 */
export function diffRows(lines: readonly DiffLine[], maxRows = DIFF_MAX_ROWS): DiffRow[] {
  const rows: DiffRow[] = [];
  let lastOld = 0;
  let lastNew = 0;
  lines.forEach((line, index) => {
    const skipped =
      line.oldLine !== undefined
        ? line.oldLine - lastOld - 1
        : line.newLine !== undefined
          ? line.newLine - lastNew - 1
          : 0;
    if (skipped > 0) rows.push({ kind: "gap", before: index, lines: skipped });
    if (line.oldLine !== undefined) lastOld = line.oldLine;
    if (line.newLine !== undefined) lastNew = line.newLine;
    rows.push({ kind: "line", index, line });
  });
  if (rows.length <= maxRows) return rows;
  const hidden = rows.slice(maxRows).filter((row) => row.kind === "line").length;
  return [...rows.slice(0, maxRows), { kind: "cap", lines: hidden }];
}

/** The diff changes something (a diff of equal versions has only context, or nothing). */
export function diffHasChanges(changes: readonly DiffChange[]): boolean {
  return changes.some((change) => change.type !== "context");
}
