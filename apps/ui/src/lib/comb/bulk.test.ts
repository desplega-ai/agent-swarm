import { describe, expect, test } from "bun:test";
import { bulkSummary, matchesAge, runLimited, selectionState, setAll } from "./bulk";

const NOW = Date.parse("2026-10-25T12:00:00Z");
const daysAgo = (days: number) => ({ createdAt: new Date(NOW - days * 86_400_000).toISOString() });

describe("matchesAge", () => {
  test("any keeps every comment, even one with a bad date", () => {
    expect(matchesAge(daysAgo(0), "any", NOW)).toBe(true);
    expect(matchesAge({ createdAt: "not a date" }, "any", NOW)).toBe(true);
  });

  test("older than 7 and 30 days, strictly", () => {
    expect(matchesAge(daysAgo(7.01), "week", NOW)).toBe(true);
    expect(matchesAge(daysAgo(7), "week", NOW)).toBe(false);
    expect(matchesAge(daysAgo(29), "month", NOW)).toBe(false);
    expect(matchesAge(daysAgo(45), "month", NOW)).toBe(true);
    expect(matchesAge({ createdAt: "not a date" }, "month", NOW)).toBe(false);
  });
});

describe("selection", () => {
  test("selectionState says none, some, or all of the listed ids", () => {
    expect(selectionState(new Set(), ["a", "b"])).toBe(false);
    expect(selectionState(new Set(["a"]), ["a", "b"])).toBe("indeterminate");
    expect(selectionState(new Set(["a", "b", "z"]), ["a", "b"])).toBe(true);
    expect(selectionState(new Set(["z"]), [])).toBe(false);
  });

  test("setAll adds or removes only the given ids", () => {
    expect([...setAll(new Set(["z"]), ["a", "b"], true)]).toEqual(["z", "a", "b"]);
    expect([...setAll(new Set(["a", "b", "z"]), ["a", "b"], false)]).toEqual(["z"]);
  });
});

describe("runLimited", () => {
  test("runs at most `limit` at once, keeps going after a failure, and reports progress", async () => {
    let running = 0;
    let peak = 0;
    const progress: number[] = [];
    const outcome = await runLimited(
      [1, 2, 3, 4, 5, 6, 7],
      3,
      async (n) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 2));
        running--;
        if (n % 3 === 0) throw new Error(`no ${n}`);
      },
      { onProgress: (finished) => progress.push(finished) },
    );
    expect(peak).toBe(3);
    expect(outcome.done).toEqual([1, 2, 4, 5, 7]);
    expect(outcome.failed.map((entry) => entry.item).sort()).toEqual([3, 6]);
    expect(progress).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("an empty list finishes at once", async () => {
    expect(await runLimited([], 4, async () => {})).toEqual({ done: [], failed: [], skipped: [] });
  });

  test("an error that stopOn matches starts no more items", async () => {
    const denied = new Error("403");
    const tried: number[] = [];
    const outcome = await runLimited(
      [1, 2, 3, 4, 5, 6],
      2,
      async (n) => {
        tried.push(n);
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (n === 2) throw denied;
      },
      { stopOn: (error) => error === denied },
    );
    // 1 and 2 run together, 3 starts after 1. Nothing starts after 2 fails.
    expect(tried).toEqual([1, 2, 3]);
    expect(outcome.done).toEqual([1, 3]);
    expect(outcome.failed).toEqual([{ item: 2, error: denied }]);
    expect(outcome.skipped).toEqual([4, 5, 6]);
  });
});

describe("bulkSummary", () => {
  test("reads as a short toast title", () => {
    expect(bulkSummary("Resolved", 1, 0)).toBe("Resolved 1 comment");
    expect(bulkSummary("Resolved", 392, 0)).toBe("Resolved 392 comments");
    expect(bulkSummary("Reopened", 10, 2)).toBe("Reopened 10. 2 failed");
  });
});
