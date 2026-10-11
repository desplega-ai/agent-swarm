import { describe, expect, test } from "bun:test";
import { showTelemetryBanner, TELEMETRY_BANNER_RESHOW_AFTER_MS } from "./telemetry-banner";

const NOW = Date.parse("2026-10-12T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const base = { telemetryEnabled: false, isAdmin: true, dismissedAt: null, nowMs: NOW };

describe("showTelemetryBanner", () => {
  test("shows only to admins while telemetry is off", () => {
    expect(showTelemetryBanner(base)).toBe(true);
    expect(showTelemetryBanner({ ...base, isAdmin: false })).toBe(false);
    expect(showTelemetryBanner({ ...base, telemetryEnabled: true })).toBe(false);
    // Loading, or a server that predates the field.
    expect(showTelemetryBanner({ ...base, telemetryEnabled: undefined })).toBe(false);
  });

  test("never comes back after a dismissal by default", () => {
    expect(TELEMETRY_BANNER_RESHOW_AFTER_MS).toBeNull();
    const dismissedAt = new Date(NOW - 400 * DAY).toISOString();
    expect(showTelemetryBanner({ ...base, dismissedAt })).toBe(false);
  });

  test("the constant controls re-show when set", () => {
    const dismissedAt = new Date(NOW - 31 * DAY).toISOString();
    expect(showTelemetryBanner({ ...base, dismissedAt, reshowAfterMs: 30 * DAY })).toBe(true);
    expect(showTelemetryBanner({ ...base, dismissedAt, reshowAfterMs: 60 * DAY })).toBe(false);
    expect(showTelemetryBanner({ ...base, dismissedAt: "garbage", reshowAfterMs: DAY })).toBe(
      false,
    );
  });
});
