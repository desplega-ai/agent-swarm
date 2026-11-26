import { describe, expect, test } from "bun:test";
import { formatDeferralDateTime } from "../utils/deferral-time";

describe("formatDeferralDateTime", () => {
  test.each([
    ["2026-11-01T00:30:00-04:00", "2026-11-02T12:00:00-05:00", "tomorrow", "12:00"],
    ["2026-11-01T00:30:00-04:00", "2026-11-01T23:30:00-05:00", "today", "23:30"],
    ["2026-03-07T23:30:00-05:00", "2026-03-08T23:30:00-04:00", "tomorrow", "23:30"],
    ["2026-03-07T23:30:00-05:00", "2026-03-09T00:30:00-04:00", "03-09", "00:30"],
    ["2028-02-29T23:30:00-05:00", "2028-03-01T00:15:00-05:00", "tomorrow", "00:15"],
    ["2026-12-31T23:30:00-05:00", "2027-01-01T00:15:00-05:00", "tomorrow", "00:15"],
  ])("in New York, from %s to %s is %s at %s", (now, target, date, time) => {
    expect(formatDeferralDateTime(new Date(target), new Date(now), "America/New_York")).toEqual({
      date,
      time,
    });
  });

  test("uses UTC for the date and time when the timezone is invalid", () => {
    const now = new Date("2026-11-01T23:45:00Z");
    const target = new Date("2026-11-02T00:15:00Z");
    expect(formatDeferralDateTime(target, now, "Invalid/Zone", true)).toEqual({
      date: "tomorrow",
      time: "00:15 UTC",
    });
  });
});
