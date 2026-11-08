import { describe, expect, test } from "bun:test";
import type { UsageSummaryDailyRow } from "../api/types";
import { cacheShare, costPerSessionSeries, spendStats, usageDay } from "./home-metrics";

const day = (date: string, costUsd: number, sessions = 0): UsageSummaryDailyRow => ({
  date,
  costUsd,
  inputTokens: 0,
  outputTokens: 0,
  sessions,
});

describe("home metrics", () => {
  test("daily spend, oldest first, ending with today", () => {
    const stats = spendStats(
      [day("2026-11-06", 221), day("2026-11-04", 150), day("2026-11-05", 210)],
      "2026-11-06",
    );
    expect(stats).toEqual({ today: 221, series: [150, 210, 221] });
    expect(spendStats([], "2026-11-06")).toEqual({ today: 0, series: [0] });
  });

  test("cost per session per day; a day without sessions is zero", () => {
    const stats = costPerSessionSeries(
      [day("2026-11-05", 30, 20), day("2026-11-04", 10, 0), day("2026-11-06", 12, 8)],
      "2026-11-06",
    );
    expect(stats).toEqual({ today: 1.5, series: [0, 1.5, 1.5] });
  });

  test("cache share and the usage day", () => {
    expect(cacheShare(12, 88, 0)).toBe(88);
    expect(cacheShare(0, 0, 0)).toBeNull();
    expect(usageDay(Date.UTC(2026, 10, 6, 23, 30))).toBe("2026-11-06");
  });
});
