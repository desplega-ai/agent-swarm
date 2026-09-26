import { describe, expect, test } from "bun:test";
import type { AgentTask } from "../api/types";
import { summarizeRecentFailures } from "./recent-failures";

const NOW = Date.parse("2026-09-26T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function failed(id: string, finishedHoursAgo: number, updatedHoursAgo = finishedHoursAgo) {
  return {
    id,
    status: "failed",
    finishedAt: new Date(NOW - finishedHoursAgo * HOUR).toISOString(),
    lastUpdatedAt: new Date(NOW - updatedHoursAgo * HOUR).toISOString(),
  } as AgentTask;
}

describe("summarizeRecentFailures", () => {
  test("a page that is not full is a complete count", () => {
    const result = summarizeRecentFailures([failed("a", 1), failed("b", 30)], 20, NOW);
    expect(result.tasks.map((t) => t.id)).toEqual(["a"]);
    expect(result.complete).toBe(true);
  });

  test("a full page whose rows are all recent is only a lower bound", () => {
    const page = Array.from({ length: 20 }, (_, i) => failed(`t${i}`, 1));
    const result = summarizeRecentFailures(page, 20, NOW);
    expect(result.tasks).toHaveLength(20);
    expect(result.complete).toBe(false);
  });

  test("old failures edited recently are dropped and mark the count partial", () => {
    const page = [
      failed("recent", 2),
      ...Array.from({ length: 19 }, (_, i) => failed(`old${i}`, 72, 1)),
    ];
    const result = summarizeRecentFailures(page, 20, NOW);
    expect(result.tasks.map((t) => t.id)).toEqual(["recent"]);
    expect(result.complete).toBe(false);
  });

  test("a full page that reaches past the window is complete", () => {
    const page = [failed("a", 1), ...Array.from({ length: 19 }, (_, i) => failed(`o${i}`, 30))];
    expect(summarizeRecentFailures(page, 20, NOW).complete).toBe(true);
  });
});
