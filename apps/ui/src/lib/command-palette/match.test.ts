import { describe, expect, test } from "bun:test";
import { highlightParts, isWordMatch, matchText, rankResults } from "./match";
import { taskResult } from "./task-result";

describe("matchText", () => {
  test("an empty query matches everything with no highlight", () => {
    expect(matchText("Tasks", "  ")).toEqual({ score: 0, ranges: [] });
  });

  test("ranks label start above word start above inner hits", () => {
    const start = matchText("Workflows", "work")?.score ?? 0;
    const wordStart = matchText("My workflows", "work")?.score ?? 0;
    const inner = matchText("Rework", "work")?.score ?? 0;
    expect(start).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(inner);
  });

  test("every word must match; each word is highlighted", () => {
    expect(matchText("Provider keys", "key prov")?.ranges).toEqual([
      [0, 4],
      [9, 12],
    ]);
    expect(matchText("Provider keys", "key secret")).toBeNull();
  });

  test("keywords match without highlighting the label", () => {
    const match = matchText("Provider keys", "api", ["api keys"]);
    expect(match?.ranges).toEqual([]);
    expect(match?.score ?? 0).toBeGreaterThan(0);
  });

  test("falls back to a subsequence, ranked below any word hit", () => {
    const fuzzy = matchText("Workflows", "wkfl");
    expect(fuzzy?.ranges).toEqual([
      [0, 1],
      [3, 6],
    ]);
    expect(fuzzy?.score ?? 0).toBeLessThan(matchText("Rework", "work")?.score ?? 0);
    expect(matchText("Workflows", "zz")).toBeNull();
  });

  test("an exact label beats a longer one", () => {
    expect(matchText("Tasks", "tasks")?.score ?? 0).toBeGreaterThan(
      matchText("Tasks archive", "tasks")?.score ?? 0,
    );
  });
});

test("highlightParts splits the label at the ranges", () => {
  expect(highlightParts("Provider keys", [[9, 12]])).toEqual([
    { text: "Provider ", hit: false },
    { text: "key", hit: true },
    { text: "s", hit: false },
  ]);
});

test("isWordMatch rejects a subsequence-only match", () => {
  expect(isWordMatch(matchText("Researcher", "secr"))).toBe(false);
  expect(isWordMatch(matchText("Researcher", "search"))).toBe(true);
  expect(isWordMatch(null)).toBe(false);
});

describe("task search hits", () => {
  const task = taskResult({
    id: "task-1",
    title: "Deploy",
    task: "Investigate database",
    status: "in_progress",
  });

  test("match on the title and on the prompt", () => {
    expect(rankResults([task], "deploy", true).map((row) => row.result.id)).toEqual(["task-1"]);
    expect(rankResults([task], "database", true).map((row) => row.result.id)).toEqual(["task-1"]);
  });

  test("keep a server hit past the prompt preview, ranked below client matches", () => {
    const other = taskResult({ id: "task-2", task: "Plan the migration", status: "pending" });
    // The API matched "migration" deep in task-1's prompt; its slim row has only the preview.
    const rows = rankResults([task, other], "migration", true);
    expect(rows.map((row) => row.result.id)).toEqual(["task-2", "task-1"]);
    expect(rows[1]?.match).toEqual({ score: 0, ranges: [] });
  });

  test("a client-matched provider still drops rows the server did not vouch for", () => {
    expect(rankResults([{ title: "Workflows" }], "schedule", true)).toEqual([]);
    expect(rankResults([{ title: "notes.md" }], "schedule", false)).toHaveLength(1);
  });
});
