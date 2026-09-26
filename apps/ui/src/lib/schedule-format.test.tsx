import { describe, expect, test } from "bun:test";
import type { ScheduledTask } from "../api/types";
import { cronTimezone, scheduleCadence } from "./schedule-format";

function schedule(overrides: Partial<ScheduledTask>) {
  return { scheduleType: "recurring", timezone: "UTC", ...overrides } as ScheduledTask;
}

describe("scheduleCadence", () => {
  test("a cron cadence keeps its zone, as the desktop column does", () => {
    expect(
      scheduleCadence(schedule({ cronExpression: "0 9 * * *", timezone: "America/New_York" })),
    ).toBe("At 09:00 (America/New_York)");
  });

  test("a cron row with no stored zone reads as UTC", () => {
    expect(scheduleCadence(schedule({ cronExpression: "0 9 * * *", timezone: "" }))).toBe(
      "At 09:00 (UTC)",
    );
    expect(cronTimezone(undefined)).toBe("UTC");
  });

  test("an interval cadence needs no zone", () => {
    expect(scheduleCadence(schedule({ intervalMs: 15 * 60 * 1000 }))).toBe("every 15m");
  });
});
