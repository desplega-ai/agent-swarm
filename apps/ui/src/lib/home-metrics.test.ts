import { describe, expect, test } from "bun:test";
import type { ApiKeyStatus, UsageSummaryDailyRow } from "../api/types";
import { cacheShare, percentDelta, planUsage, spendStats, usageDay } from "./home-metrics";

const day = (date: string, costUsd: number): UsageSummaryDailyRow => ({
  date,
  costUsd,
  inputTokens: 0,
  outputTokens: 0,
  sessions: 0,
});

const key = (windows: ApiKeyStatus["rateLimitWindows"]) =>
  ({ rateLimitWindows: windows }) as ApiKeyStatus;

describe("home metrics", () => {
  test("today's spend against the average of the earlier days", () => {
    const stats = spendStats(
      [day("2026-11-06", 221), day("2026-11-04", 150), day("2026-11-05", 210)],
      "2026-11-06",
    );
    expect(stats).toEqual({ today: 221, average: 180, series: [150, 210, 221] });
    expect(percentDelta(stats.today, stats.average)).toBe("+23%");
  });

  test("a day with no row yet is zero, and no history means no average", () => {
    expect(spendStats([], "2026-11-06")).toEqual({ today: 0, average: null, series: [0] });
    expect(percentDelta(5, null)).toBeNull();
  });

  test("plan use is the busiest key's windows", () => {
    const usage = planUsage([
      key({ five_hour: { status: "allowed", utilization: 0.2, resetsAt: 100, lastSeenAt: "" } }),
      key({
        five_hour: { status: "allowed", utilization: 0.62, resetsAt: 200, lastSeenAt: "" },
        seven_day: { status: "allowed", utilization: 0.41, lastSeenAt: "" },
      }),
    ]);
    expect(usage).toEqual({ fiveHour: 62, sevenDay: 41, fiveHourResetsAt: 200_000 });
    expect(planUsage([key({})])).toBeNull();
  });

  test("cache share and the usage day", () => {
    expect(cacheShare(12, 88, 0)).toBe(88);
    expect(cacheShare(0, 0, 0)).toBeNull();
    expect(usageDay(Date.UTC(2026, 10, 6, 23, 30))).toBe("2026-11-06");
  });
});
