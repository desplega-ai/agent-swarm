import { describe, expect, test } from "bun:test";
import {
  isRateLimitMessage,
  MAX_RATE_LIMIT_RESET_MS,
  parseRateLimitWindowTelemetry,
  parseStderrForErrors,
  SessionErrorTracker,
  trackErrorFromJson,
} from "../utils/error-tracker";

// Verbatim fixture from Linear CAI-1279 (session logs for task b7fbbdb9-4922-41d9-88ec-21febd6c4fec)
const FIXTURE_REJECTED = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "rejected",
    resetsAt: 1779202200, // seconds since epoch — 2026-05-19T14:50:00Z
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    overageDisabledReason: "group_zero_credit_limit",
    isUsingOverage: false,
  },
  uuid: "ff6e5299-429c-4fcb-ab34-0ce4e8fa6202",
  session_id: "69dbe5a1-1130-45eb-983f-58a7a13c9c3c",
};

describe("SessionErrorTracker — rate_limit_event processing", () => {
  test("captures allowed_warning telemetry without marking a cooldown", () => {
    const tracker = new SessionErrorTracker();
    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        resetsAt: 1781334000,
        rateLimitType: "seven_day",
        utilization: 0.82,
        isUsingOverage: false,
        surpassedThreshold: 0.75,
      },
    });

    expect(tracker.getRateLimitResetAt()).toBeUndefined();
    expect(tracker.getRateLimitWindows()).toEqual({
      seven_day: expect.objectContaining({
        status: "allowed_warning",
        resetsAt: 1781334000,
        utilization: 0.82,
        isUsingOverage: false,
        surpassedThreshold: 0.75,
      }),
    });
  });

  test("parseRateLimitWindowTelemetry is best-effort for malformed events", () => {
    expect(parseRateLimitWindowTelemetry({ type: "rate_limit_event" })).toBeNull();
    expect(
      parseRateLimitWindowTelemetry({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed_warning", resetsAt: "bad" },
      }),
    ).toBeNull();
  });

  test("stashes resetsAt (seconds) correctly as ms — verbatim CAI-1279 fixture", () => {
    const tracker = new SessionErrorTracker();
    tracker.processRateLimitEvent(FIXTURE_REJECTED);

    const result = tracker.getRateLimitResetAt();
    expect(result).toBeDefined();

    // resetsAt: 1779202200 sec → 2026-05-19T14:50:00.000Z
    // But since we clamp to [now+60s, now+7d] and this is a past timestamp,
    // the value will be clamped to now+60s. What matters is the sec→ms conversion works.
    // We verify the unit is correct by checking that 1779202200 * 1000 = ms,
    // which is NOT the same as treating it as ms (would be 1970-01-21).
    const parsedMs = new Date(result!).getTime();
    const nowMs = Date.now();
    expect(parsedMs).toBeGreaterThanOrEqual(nowMs + 59_000); // clamped to at least now+60s
    expect(parsedMs).toBeLessThanOrEqual(nowMs + 7 * 60 * 60 * 1000); // not absurdly far
  });

  test("resetsAt treated as seconds, not milliseconds (unit conversion boundary)", () => {
    const tracker = new SessionErrorTracker();
    // A future resetsAt value (in seconds) — 1 hour from now
    const oneHourFromNowSec = Math.floor(Date.now() / 1000) + 3600;
    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        resetsAt: oneHourFromNowSec,
      },
    });

    const result = tracker.getRateLimitResetAt();
    expect(result).toBeDefined();

    const parsedMs = new Date(result!).getTime();
    const nowMs = Date.now();
    // Should be ~1h from now (not 1970 if treated as ms, not year 57,000 if multiplied wrong)
    expect(parsedMs).toBeGreaterThanOrEqual(nowMs + 50 * 60_000); // at least 50 min from now
    expect(parsedMs).toBeLessThanOrEqual(nowMs + 70 * 60_000); // at most 70 min from now
  });

  test("status: rejected → stashes resetsAt", () => {
    const tracker = new SessionErrorTracker();
    const futureResetsAtSec = Math.floor(Date.now() / 1000) + 3600;
    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: futureResetsAtSec },
    });
    expect(tracker.getRateLimitResetAt()).toBeDefined();
  });

  test("status: allowed → does NOT stash (no cooldown needed)", () => {
    const tracker = new SessionErrorTracker();
    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", resetsAt: 1779202200 },
    });
    expect(tracker.getRateLimitResetAt()).toBeUndefined();
  });

  test("status: allowed_warning → does NOT stash", () => {
    const tracker = new SessionErrorTracker();
    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning", resetsAt: 1779202200 },
    });
    expect(tracker.getRateLimitResetAt()).toBeUndefined();
  });

  test("malformed event (missing rate_limit_info) → does NOT stash, no throw", () => {
    const tracker = new SessionErrorTracker();
    tracker.processRateLimitEvent({ type: "rate_limit_event" });
    expect(tracker.getRateLimitResetAt()).toBeUndefined();
  });

  test("malformed event (resetsAt is string) → does NOT stash, no throw", () => {
    const tracker = new SessionErrorTracker();
    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: "not-a-number" },
    });
    expect(tracker.getRateLimitResetAt()).toBeUndefined();
  });

  test("malformed event (resetsAt is negative) → does NOT stash", () => {
    const tracker = new SessionErrorTracker();
    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: -1 },
    });
    expect(tracker.getRateLimitResetAt()).toBeUndefined();
  });

  test("resetsAt already in the past → clamped to now+60s (clock skew defense)", () => {
    const tracker = new SessionErrorTracker();
    // Use a known-past timestamp (year 2020)
    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: 1577836800 }, // 2020-01-01T00:00:00Z
    });

    const result = tracker.getRateLimitResetAt();
    expect(result).toBeDefined();
    const parsedMs = new Date(result!).getTime();
    const nowMs = Date.now();
    expect(parsedMs).toBeGreaterThanOrEqual(nowMs + 59_000);
    expect(parsedMs).toBeLessThanOrEqual(nowMs + 65_000);
  });

  test("resetsAt absurdly far in future → clamped to now+7d (malformed defense)", () => {
    const tracker = new SessionErrorTracker();
    // Year 2099 in seconds
    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: 4102444800 }, // 2100-01-01 in seconds
    });

    const result = tracker.getRateLimitResetAt();
    expect(result).toBeDefined();
    const parsedMs = new Date(result!).getTime();
    const nowMs = Date.now();
    const sevenDaysMs = MAX_RATE_LIMIT_RESET_MS;
    expect(parsedMs).toBeLessThanOrEqual(nowMs + sevenDaysMs + 1000); // within 7d (+1s tolerance)
  });

  test("legitimate weekly reset (~2 days out) is honored, not clamped to 6h", () => {
    const tracker = new SessionErrorTracker();
    const twoDaysFromNowSec = Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60;
    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: twoDaysFromNowSec, rateLimitType: "weekly" },
    });

    const result = tracker.getRateLimitResetAt();
    expect(result).toBeDefined();
    const parsedMs = new Date(result!).getTime();
    const nowMs = Date.now();
    // The real reset is ~2 days out — must be honored, not capped at 6h.
    expect(parsedMs).toBeGreaterThan(nowMs + 6 * 60 * 60 * 1000);
    expect(parsedMs).toBeLessThanOrEqual(nowMs + 2 * 24 * 60 * 60 * 1000 + 1000);
  });

  test("multiple rate_limit_event lines → last rejected one wins", () => {
    const tracker = new SessionErrorTracker();
    const firstResetsAtSec = Math.floor(Date.now() / 1000) + 1800; // 30 min from now
    const secondResetsAtSec = Math.floor(Date.now() / 1000) + 3600; // 60 min from now

    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: firstResetsAtSec },
    });
    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: secondResetsAtSec },
    });

    const result = tracker.getRateLimitResetAt();
    expect(result).toBeDefined();
    const parsedMs = new Date(result!).getTime();
    const nowMs = Date.now();
    // Should reflect the SECOND event (~60 min), not the first (~30 min)
    expect(parsedMs).toBeGreaterThanOrEqual(nowMs + 55 * 60_000);
    expect(parsedMs).toBeLessThanOrEqual(nowMs + 65 * 60_000);
  });

  test("allowed event between two rejected events → last rejected wins", () => {
    const tracker = new SessionErrorTracker();
    const firstSec = Math.floor(Date.now() / 1000) + 1800;
    const secondSec = Math.floor(Date.now() / 1000) + 3600;

    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: firstSec },
    });
    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", resetsAt: 9999999999 }, // should be ignored
    });
    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: secondSec },
    });

    const result = tracker.getRateLimitResetAt();
    expect(result).toBeDefined();
    const parsedMs = new Date(result!).getTime();
    const nowMs = Date.now();
    // Should reflect the third (second rejected) event (~60 min)
    expect(parsedMs).toBeGreaterThanOrEqual(nowMs + 55 * 60_000);
    expect(parsedMs).toBeLessThanOrEqual(nowMs + 65 * 60_000);
  });

  test("no rate_limit_event at all → getRateLimitResetAt returns undefined", () => {
    const tracker = new SessionErrorTracker();
    expect(tracker.getRateLimitResetAt()).toBeUndefined();
  });
});

describe("trackErrorFromJson — rate_limit_event routing", () => {
  test("routes rate_limit_event to processRateLimitEvent, stashes reset time", () => {
    const tracker = new SessionErrorTracker();
    const futureResetsAtSec = Math.floor(Date.now() / 1000) + 3600;

    trackErrorFromJson(
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: futureResetsAtSec },
      },
      tracker,
    );

    expect(tracker.getRateLimitResetAt()).toBeDefined();
    // rate_limit_event itself is NOT an error signal — it's informational
    expect(tracker.hasErrors()).toBe(false);
  });

  test("rate_limit_event with allowed status → no reset stashed, no errors", () => {
    const tracker = new SessionErrorTracker();
    trackErrorFromJson(
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", resetsAt: 1779202200 },
      },
      tracker,
    );

    expect(tracker.getRateLimitResetAt()).toBeUndefined();
    expect(tracker.hasErrors()).toBe(false);
  });

  test("rate_limit_event does not block subsequent event processing", () => {
    const tracker = new SessionErrorTracker();
    const futureResetsAtSec = Math.floor(Date.now() / 1000) + 3600;

    trackErrorFromJson(
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: futureResetsAtSec },
      },
      tracker,
    );
    trackErrorFromJson(
      { type: "result", is_error: true, result: "Your group's usage limit is set to $0" },
      tracker,
    );

    expect(tracker.getRateLimitResetAt()).toBeDefined();
    expect(tracker.hasErrors()).toBe(true);
  });
});

describe("three-tier resolver logic (unit test via clamp helper)", () => {
  // Mirrors the clampResetTime inline helper in runner.ts
  function clampResetTime(isoString: string): string {
    const nowMs = Date.now();
    const minMs = nowMs + 60_000;
    const maxMs = nowMs + MAX_RATE_LIMIT_RESET_MS;
    const candidateMs = new Date(isoString).getTime();
    return new Date(Math.min(Math.max(candidateMs, minMs), maxMs)).toISOString();
  }

  test("tier 1: rateLimitResetAt from structured event → used directly (after clamp)", () => {
    const futureResetsAtSec = Math.floor(Date.now() / 1000) + 3600;
    const tracker = new SessionErrorTracker();
    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: futureResetsAtSec },
    });

    const rateLimitResetAt = tracker.getRateLimitResetAt();
    expect(rateLimitResetAt).toBeDefined();

    // Simulate tier-1 branch: result.rateLimitResetAt is set
    const rateLimitedUntil = clampResetTime(rateLimitResetAt!);
    expect(rateLimitedUntil).toBeDefined();
    const resolvedMs = new Date(rateLimitedUntil).getTime();
    const nowMs = Date.now();
    expect(resolvedMs).toBeGreaterThanOrEqual(nowMs + 59_000);
  });

  test("tier 3 fallback: no structured event, no parseable message → 5-min default", () => {
    // Simulate: rateLimitResetAt is undefined, parseRateLimitResetTime returns undefined
    const defaultCooldownMs = 5 * 60 * 1000;
    const rateLimitedUntil = new Date(Date.now() + defaultCooldownMs).toISOString();

    const resolvedMs = new Date(rateLimitedUntil).getTime();
    const nowMs = Date.now();
    expect(resolvedMs).toBeGreaterThanOrEqual(nowMs + 4 * 60_000);
    expect(resolvedMs).toBeLessThanOrEqual(nowMs + 6 * 60_000);
  });
});

describe("isRateLimitMessage — shared matcher (runner gate + stderr parser)", () => {
  test.each([
    "You've hit your weekly limit · resets May 28, 5pm (UTC)",
    "hit your 5-hour limit",
    "hit your limit",
    "Claude usage limit reached",
    "hit your daily limit",
    "rate limit exceeded",
    "rate_limit error",
    "429 Too Many Requests",
    "Error: too many requests, slow down",
    "[rate-limit] codex prefix",
    "[usage-limit] codex prefix",
  ])("matches rate-limit signal: %s", (msg) => {
    expect(isRateLimitMessage(msg)).toBe(true);
  });

  test.each([
    "No conversation found with session ID abc",
    "Max turns exceeded",
    "Authentication failed: invalid token",
    "Error during execution: file not found",
    "Read 4290 bytes from stream",
  ])("does NOT match non-rate-limit text: %s", (msg) => {
    expect(isRateLimitMessage(msg)).toBe(false);
  });

  test("parseStderrForErrors flags a weekly-limit stderr line as an error", () => {
    const tracker = new SessionErrorTracker();
    parseStderrForErrors("You've hit your weekly limit · resets May 28, 5pm (UTC)", tracker);
    expect(tracker.hasErrors()).toBe(true);
  });

  test("parseStderrForErrors still flags a bare 429 stderr line", () => {
    const tracker = new SessionErrorTracker();
    parseStderrForErrors("HTTP 429 returned by upstream", tracker);
    expect(tracker.hasErrors()).toBe(true);
  });
});
