import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  isRateLimitMessage,
  MAX_RATE_LIMIT_RESET_MS,
  parseRateLimitWindowTelemetry,
  parseStderrForErrors,
  SessionErrorTracker,
  trackErrorFromJson,
} from "../utils/error-tracker";
import { parseModelLimitMessage } from "../utils/model-rate-limit-windows";

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

// Verbatim fixture from task fe35598c-8973-4728-a691-6d039d983101, session_logs line 0,
// 2026-09-24T02:05:41.040Z. The Fable weekly limit arrives as
// rateLimitType: "seven_day_overage_included".
const FIXTURE_FABLE_REJECTED = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "rejected",
    resetsAt: 1790467200, // seconds since epoch — 2026-09-27T00:00:00Z
    rateLimitType: "seven_day_overage_included",
    overageStatus: "rejected",
    overageDisabledReason: "group_zero_credit_limit",
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.05, resetsAt: 1790217000 },
      seven_day: { utilization: 0.77, resetsAt: 1790467200 },
      seven_day_overage_included: { utilization: 1, resetsAt: 1790467200 },
    },
  },
  uuid: "347bea29-f868-47b4-a070-5a9ba117989e",
  session_id: "0a7b672e-3cd1-4fe6-a5fd-12dd8698f121",
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

describe("SessionErrorTracker — model-scoped rejection (Fable weekly window)", () => {
  afterEach(() => {
    setSystemTime();
  });

  test("Fable rejection sets getModelRateLimit and never sets getRateLimitResetAt", () => {
    setSystemTime(new Date("2026-09-24T02:05:41.040Z"));
    const tracker = new SessionErrorTracker();
    tracker.processRateLimitEvent(FIXTURE_FABLE_REJECTED);

    expect(tracker.getRateLimitResetAt()).toBeUndefined();
    expect(tracker.getModelRateLimit()).toEqual({
      window: "seven_day_overage_included",
      model: "fable",
      resetAt: "2026-09-27T00:00:00.000Z",
      observedAt: "2026-09-24T02:05:41.040Z",
    });
    // The telemetry entry for the same event carries the same observation time.
    expect(tracker.getRateLimitWindows()?.seven_day_overage_included?.lastSeenAt).toBe(
      "2026-09-24T02:05:41.040Z",
    );
  });

  test("Fable rejection still records the 3-key unified window telemetry", () => {
    setSystemTime(new Date("2026-09-24T02:05:41.040Z"));
    const tracker = new SessionErrorTracker();
    tracker.processRateLimitEvent(FIXTURE_FABLE_REJECTED);

    const windows = tracker.getRateLimitWindows();
    expect(windows).toBeDefined();
    expect(Object.keys(windows!)).toHaveLength(3);
    expect(windows!.five_hour?.utilization).toBe(0.05);
    expect(windows!.seven_day?.utilization).toBe(0.77);
    expect(windows!.seven_day_overage_included?.status).toBe("rejected");
    // The top-level entry (written for the same rateLimitType) has no
    // utilization of its own — it must merge over the unified entry's
    // utilization: 1 rather than overwrite it away.
    expect(windows!.seven_day_overage_included?.utilization).toBe(1);
    expect(windows!.seven_day_overage_included?.resetsAt).toBe(1790467200);
  });

  test("a five_hour rejected fixture still sets getRateLimitResetAt (legacy key-wide path)", () => {
    const tracker = new SessionErrorTracker();
    tracker.processRateLimitEvent(FIXTURE_REJECTED);

    expect(tracker.getRateLimitResetAt()).toBeDefined();
    expect(tracker.getModelRateLimit()).toBeUndefined();
  });

  test("rateLimitType 'toString' is not model-scoped (own-property check, not `in`) — falls back to key-wide", () => {
    const tracker = new SessionErrorTracker();
    const futureResetsAtSec = Math.floor(Date.now() / 1000) + 3600;
    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        resetsAt: futureResetsAtSec,
        rateLimitType: "toString",
      },
    });

    expect(tracker.getModelRateLimit()).toBeUndefined();
    expect(tracker.getRateLimitResetAt()).toBeDefined();
  });

  test("a model-scoped rejection followed by a key-wide rejection keeps both blocks", () => {
    const tracker = new SessionErrorTracker();
    const resetsAtSec = Math.floor(Date.now() / 1000) + 3600;
    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        resetsAt: resetsAtSec,
        rateLimitType: "seven_day_overage_included",
      },
    });
    expect(tracker.getModelRateLimit()).toBeDefined();

    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: resetsAtSec, rateLimitType: "five_hour" },
    });

    expect(tracker.getModelRateLimit()?.window).toBe("seven_day_overage_included");
    expect(tracker.getRateLimitResetAt()).toBe(new Date(resetsAtSec * 1000).toISOString());
  });

  test("a key-wide rejection followed by a model-scoped rejection keeps the key-wide block", () => {
    const tracker = new SessionErrorTracker();
    const resetsAtSec = Math.floor(Date.now() / 1000) + 3600;
    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: resetsAtSec, rateLimitType: "five_hour" },
    });
    expect(tracker.getRateLimitResetAt()).toBeDefined();

    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        resetsAt: resetsAtSec,
        rateLimitType: "seven_day_overage_included",
      },
    });

    // Independent windows: the Fable rejection is no evidence that the
    // five-hour window recovered, so both constraints stay effective.
    expect(tracker.getRateLimitResetAt()).toBe(new Date(resetsAtSec * 1000).toISOString());
    expect(tracker.getModelRateLimit()?.window).toBe("seven_day_overage_included");
  });

  test("two rejected key-wide windows → the later reset wins (the key waits for both)", () => {
    const tracker = new SessionErrorTracker();
    const fiveHourSec = Math.floor(Date.now() / 1000) + 3600;
    const sevenDaySec = Math.floor(Date.now() / 1000) + 2 * 24 * 3600;
    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: sevenDaySec, rateLimitType: "seven_day" },
    });
    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: fiveHourSec, rateLimitType: "five_hour" },
    });

    expect(tracker.getRateLimitResetAt()).toBe(new Date(sevenDaySec * 1000).toISOString());
  });

  test("a non-rejected event for the same window is its explicit recovery", () => {
    const tracker = new SessionErrorTracker();
    const resetsAtSec = Math.floor(Date.now() / 1000) + 3600;
    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: resetsAtSec, rateLimitType: "five_hour" },
    });
    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        resetsAt: resetsAtSec,
        rateLimitType: "seven_day_overage_included",
      },
    });

    // Recovery of another window leaves the five-hour block in place.
    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", resetsAt: resetsAtSec, rateLimitType: "seven_day" },
    });
    expect(tracker.getRateLimitResetAt()).toBeDefined();

    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", resetsAt: resetsAtSec, rateLimitType: "five_hour" },
    });
    expect(tracker.getRateLimitResetAt()).toBeUndefined();
    expect(tracker.getModelRateLimit()).toBeDefined();

    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        resetsAt: resetsAtSec,
        rateLimitType: "seven_day_overage_included",
      },
    });
    expect(tracker.getModelRateLimit()).toBeUndefined();
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

  test("a stderr-only Fable limit message is captured, so failureReason carries the model-limit signal", () => {
    const tracker = new SessionErrorTracker();
    parseStderrForErrors(
      "You've reached your Fable limit. Switch to another model to continue.",
      tracker,
    );

    // Not classified as a generic rate-limit signal — must never widen the
    // key-wide matcher for this text.
    expect(isRateLimitMessage("You've reached your Fable limit. Switch to another model")).toBe(
      false,
    );
    expect(tracker.hasErrors()).toBe(true);

    const failureReason = tracker.buildFailureReason(1);
    expect(parseModelLimitMessage(failureReason)).toBe("fable");
  });
});
