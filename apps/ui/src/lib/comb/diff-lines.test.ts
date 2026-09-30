import { describe, expect, test } from "bun:test";
import type { DiffChange } from "../agent-fs/types";
import {
  DIFF_CONTEXT_LINES,
  DIFF_FOLD_MIN_LINES,
  type DiffLine,
  type DiffRow,
  diffHasChanges,
  diffLines,
  diffRows,
} from "./diff-lines";

/**
 * live/'s DiffViewer line numbers, copied from agent-fs
 * `live/src/components/viewers/DiffViewer.tsx:10-32` (0 renders as blank).
 */
function liveLineNumbers(changes: DiffChange[]) {
  let oldLine = 0;
  let newLine = 0;
  return changes.map((change) => {
    const result = { oldLineNum: 0, newLineNum: 0 };
    switch (change.type) {
      case "context":
        oldLine++;
        newLine++;
        result.oldLineNum = oldLine;
        result.newLineNum = newLine;
        break;
      case "remove":
        oldLine++;
        result.oldLineNum = oldLine;
        break;
      case "add":
        newLine++;
        result.newLineNum = newLine;
        break;
    }
    return result;
  });
}

const ctx = (content: string, oldLine?: number, newLine?: number): DiffChange => ({
  type: "context",
  content,
  oldLine,
  newLine,
});
const add = (content: string, newLine?: number): DiffChange => ({ type: "add", content, newLine });
const remove = (content: string, oldLine?: number): DiffChange => ({
  type: "remove",
  content,
  oldLine,
});

/** Compact row view: line numbers, "gap:N", or "fold:N". */
function shape(rows: DiffRow[]): string[] {
  return rows.map((row) => {
    if (row.kind === "gap") return `gap:${row.lines}`;
    if (row.kind === "fold") return `fold:${row.lines}`;
    const sign = row.line.type === "add" ? "+" : row.line.type === "remove" ? "-" : " ";
    return `${sign}${row.line.oldLine ?? ""}/${row.line.newLine ?? ""}`;
  });
}

/** `count` numbered context lines starting at `oldStart` / `newStart`. */
function contextRun(count: number, oldStart: number, newStart: number): DiffChange[] {
  return Array.from({ length: count }, (_, i) => ctx(`same ${i}`, oldStart + i, newStart + i));
}

describe("diffLines", () => {
  test("matches live/'s line numbers when agent-fs sends none", () => {
    const sequences: DiffChange[][] = [
      [ctx("a"), remove("b"), add("B"), ctx("c")],
      [add("x"), add("y"), ctx("a"), remove("b")],
      [remove("a"), remove("b"), remove("c"), add("A")],
      [ctx("a"), ctx("b"), add("c"), add("d"), ctx("e"), remove("f"), ctx("g")],
    ];
    for (const changes of sequences) {
      const ours = diffLines(changes).map((line) => ({
        oldLineNum: line.oldLine ?? 0,
        newLineNum: line.newLine ?? 0,
      }));
      expect(ours).toEqual(liveLineNumbers(changes));
    }
  });

  test("uses agent-fs's own line numbers when it sends them", () => {
    // A hunk that starts at old line 10, new line 12 (two lines added above it).
    const changes = [ctx("a", 10, 12), remove("b", 11), add("B", 13), ctx("c", 12, 14)];
    expect(diffLines(changes)).toEqual([
      { type: "context", content: "a", oldLine: 10, newLine: 12 },
      { type: "remove", content: "b", oldLine: 11 },
      { type: "add", content: "B", newLine: 13 },
      { type: "context", content: "c", oldLine: 12, newLine: 14 },
    ]);
    // live/ restarts at 1 and gets these wrong.
    expect(liveLineNumbers(changes)[0]).toEqual({ oldLineNum: 1, newLineNum: 1 });
  });

  test("keeps the no-newline marker unnumbered in a numbered diff", () => {
    const lines = diffLines([remove("a", 1), add("b", 1), ctx(" No newline at end of file")]);
    expect(lines[2]).toEqual({ type: "context", content: " No newline at end of file" });
  });

  test("no-content fallback: one remove and one add from diffSummary", () => {
    // agent-fs without versioning sends `{old, new}` from the edit's summary.
    const changes = [remove("old text"), add("new text")];
    const lines = diffLines(changes);
    expect(lines).toEqual([
      { type: "remove", content: "old text", oldLine: 1 },
      { type: "add", content: "new text", newLine: 1 },
    ]);
    expect(shape(diffRows(lines))).toEqual(["-1/", "+/1"]);
    expect(diffHasChanges(changes)).toBe(true);
  });
});

describe("diffRows", () => {
  test("marks the lines left out before and between hunks", () => {
    const lines = diffLines([
      ...contextRun(3, 5, 5),
      remove("a", 8),
      add("A", 8),
      ...contextRun(3, 9, 9),
      // Next hunk: lines 12-19 are not in the diff.
      ...contextRun(3, 20, 20),
      add("new", 23),
      ...contextRun(3, 23, 24),
    ]);
    expect(shape(diffRows(lines))).toEqual([
      "gap:4",
      " 5/5",
      " 6/6",
      " 7/7",
      "-8/",
      "+/8",
      " 9/9",
      " 10/10",
      " 11/11",
      "gap:8",
      " 20/20",
      " 21/21",
      " 22/22",
      "+/23",
      " 23/24",
      " 24/25",
      " 25/26",
    ]);
  });

  test("a gap before an added line uses the new line numbers", () => {
    const lines = diffLines([add("top", 1), add("later", 9)]);
    expect(shape(diffRows(lines))).toEqual(["+/1", "gap:7", "+/9"]);
  });

  test("folds a long unchanged run between two changes, keeping context on both sides", () => {
    const keep = DIFF_CONTEXT_LINES * 2;
    const runLength = keep + DIFF_FOLD_MIN_LINES + 6; // hides 10 lines
    const lines = diffLines([
      remove("a", 1),
      ...contextRun(runLength, 2, 1),
      add("b", runLength + 1),
    ]);
    const rows = diffRows(lines);
    expect(shape(rows)).toEqual([
      "-1/",
      " 2/1",
      " 3/2",
      " 4/3",
      "fold:10",
      " 15/14",
      " 16/15",
      " 17/16",
      "+/17",
    ]);
    // The fold id is its first hidden line: unfolding it shows every line.
    const fold = rows.find((row) => row.kind === "fold");
    expect(fold).toEqual({ kind: "fold", id: 4, lines: 10 });
    expect(diffRows(lines, new Set([4])).filter((row) => row.kind === "line")).toHaveLength(
      lines.length,
    );
  });

  test("folds only when the hidden part reaches the minimum", () => {
    const keep = DIFF_CONTEXT_LINES * 2;
    const below = diffLines([
      remove("a"),
      ...Array.from({ length: keep + DIFF_FOLD_MIN_LINES - 1 }, (_, i) => ctx(`c${i}`)),
      add("b"),
    ]);
    expect(diffRows(below).some((row) => row.kind === "fold")).toBe(false);

    const at = diffLines([
      remove("a"),
      ...Array.from({ length: keep + DIFF_FOLD_MIN_LINES }, (_, i) => ctx(`c${i}`)),
      add("b"),
    ]);
    expect(diffRows(at).filter((row) => row.kind === "fold")).toEqual([
      { kind: "fold", id: 1 + DIFF_CONTEXT_LINES, lines: DIFF_FOLD_MIN_LINES },
    ]);
  });

  test("a run at the start or the end keeps context only next to the change", () => {
    const lines = diffLines([
      ...Array.from({ length: 10 }, (_, i) => ctx(`head ${i}`)),
      add("x"),
      ...Array.from({ length: 10 }, (_, i) => ctx(`tail ${i}`)),
    ]);
    expect(shape(diffRows(lines))).toEqual([
      "fold:7",
      " 8/8",
      " 9/9",
      " 10/10",
      "+/11",
      " 11/12",
      " 12/13",
      " 13/14",
      "fold:7",
    ]);
  });

  test("a diff with no change folds every unchanged line", () => {
    const changes = Array.from({ length: 5 }, (_, i) => ctx(`c${i}`));
    expect(diffHasChanges(changes)).toBe(false);
    expect(shape(diffRows(diffLines(changes)))).toEqual(["fold:5"]);
    expect(diffRows(diffLines([]))).toEqual([]);
  });

  test("every line index appears once across rows and folds", () => {
    const lines: DiffLine[] = diffLines([
      ...contextRun(12, 1, 1),
      remove("a", 13),
      ...contextRun(12, 14, 13),
    ]);
    const rows = diffRows(lines);
    const shown = rows.filter((row) => row.kind === "line").length;
    const hidden = rows.reduce((sum, row) => sum + (row.kind === "fold" ? row.lines : 0), 0);
    expect(shown + hidden).toBe(lines.length);
  });
});
