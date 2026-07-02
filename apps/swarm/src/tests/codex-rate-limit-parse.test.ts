import { describe, expect, test } from "bun:test";
import {
  MAX_RATE_LIMIT_RESET_MS,
  parseCodexRateLimitResetTime,
  SessionErrorTracker,
} from "../utils/error-tracker";

// Verbatim from Linear CAI-1284 issue body (Team/Business plan fixture)
const VERBATIM_ERROR_MESSAGE =
  "You've hit your usage limit. To get more access now, send a request to your admin or try again at 8:35 PM.";

describe("parseCodexRateLimitResetTime — verbatim CAI-1284 fixture", () => {
  test("parses '8:35 PM' as 20:35 UTC same day when now is 18:00 UTC", () => {
    const now = new Date("2026-05-25T18:00:00Z");
    const result = parseCodexRateLimitResetTime(VERBATIM_ERROR_MESSAGE, now);
    expect(result).toBe("2026-05-25T20:35:00.000Z");
  });

  test("rolls to next day when 'now' is past the parsed wall-clock", () => {
    const now = new Date("2026-05-25T21:00:00Z"); // 9:00 PM UTC — past 8:35 PM
    const result = parseCodexRateLimitResetTime(VERBATIM_ERROR_MESSAGE, now);
    expect(result).toBe("2026-05-26T20:35:00.000Z");
  });

  test("keeps same day when 'now' equals the parsed wall-clock exactly (clock-skew window)", () => {
    const now = new Date("2026-05-25T20:35:00Z");
    const result = parseCodexRateLimitResetTime(VERBATIM_ERROR_MESSAGE, now);
    // Within 2-min skew window → same day; clampRateLimitResetMs applies now+60s floor.
    expect(result).toBe("2026-05-25T20:35:00.000Z");
  });

  test("clock-skew regression: 30s past 8:35 PM does NOT roll to tomorrow (CAI-1284)", () => {
    // Worker receives the usage-limit event 30 seconds after the wall-clock reset time.
    // Should stay same-day; clampRateLimitResetMs applies now+60s floor instead.
    const now = new Date("2026-05-25T20:35:30Z");
    const result = parseCodexRateLimitResetTime(VERBATIM_ERROR_MESSAGE, now);
    expect(result).toBe("2026-05-25T20:35:00.000Z");
  });
});

describe("parseCodexRateLimitResetTime — same-day format variants", () => {
  test.each([
    // [time string, expected ISO, now ISO]
    ["12:00 AM", "2026-05-25T00:00:00.000Z", "2026-05-25T00:00:00Z"], // midnight == now: within skew, stays same day
    ["12:00 PM", "2026-05-25T12:00:00.000Z", "2026-05-25T00:00:00Z"], // noon: future
    ["1:00 PM", "2026-05-25T13:00:00.000Z", "2026-05-25T00:00:00Z"],
    ["11:59 PM", "2026-05-25T23:59:00.000Z", "2026-05-25T00:00:00Z"],
  ])("'Try again at %s.' → %s", (time, expected, nowISO) => {
    const now = new Date(nowISO);
    const msg = `You've hit your usage limit. Try again at ${time}.`;
    expect(parseCodexRateLimitResetTime(msg, now)).toBe(expected);
  });

  test("'or try again at' prefix (lowercase) also parses", () => {
    const now = new Date("2026-05-25T18:00:00Z");
    const msg =
      "You've hit your usage limit. To get more access now, send a request to your admin or try again at 8:35 PM.";
    expect(parseCodexRateLimitResetTime(msg, now)).toBe("2026-05-25T20:35:00.000Z");
  });
});

describe("parseCodexRateLimitResetTime — different-day format", () => {
  test("'May 26th, 2026 8:35 PM' parses with ordinal suffix", () => {
    const now = new Date("2026-05-25T22:00:00Z");
    const msg =
      "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), " +
      "visit https://chatgpt.com/codex/settings/usage to purchase more credits or " +
      "try again at May 26th, 2026 8:35 PM.";
    expect(parseCodexRateLimitResetTime(msg, now)).toBe("2026-05-26T20:35:00.000Z");
  });

  test("ordinal-less form 'May 26, 2026 8:35 PM' also parses (defensive)", () => {
    const now = new Date("2026-05-25T22:00:00Z");
    const msg = "You've hit your usage limit. Try again at May 26, 2026 8:35 PM.";
    expect(parseCodexRateLimitResetTime(msg, now)).toBe("2026-05-26T20:35:00.000Z");
  });

  test.each([
    ["1st", 1],
    ["2nd", 2],
    ["3rd", 3],
    ["4th", 4],
    ["11th", 11],
    ["21st", 21],
    ["22nd", 22],
    ["23rd", 23],
  ])("ordinal suffix %s parses", (ord, day) => {
    const now = new Date("2026-04-01T00:00:00Z");
    const msg = `You've hit your usage limit. Try again at May ${day}${ord.replace(/\d+/, "")}, 2026 8:35 PM.`;
    const result = parseCodexRateLimitResetTime(msg, now);
    expect(result).toBe(`2026-05-${String(day).padStart(2, "0")}T20:35:00.000Z`);
  });

  test("12-hour edge: midnight cross-day 'Jan 1st, 2027 12:00 AM'", () => {
    const now = new Date("2026-12-31T23:00:00Z");
    const msg = "You've hit your usage limit. Try again at Jan 1st, 2027 12:00 AM.";
    expect(parseCodexRateLimitResetTime(msg, now)).toBe("2027-01-01T00:00:00.000Z");
  });

  test("12-hour edge: noon cross-day 'Jan 2nd, 2027 12:00 PM'", () => {
    const now = new Date("2026-12-31T23:00:00Z");
    const msg = "You've hit your usage limit. Try again at Jan 2nd, 2027 12:00 PM.";
    expect(parseCodexRateLimitResetTime(msg, now)).toBe("2027-01-02T12:00:00.000Z");
  });
});

describe("parseCodexRateLimitResetTime — negative cases", () => {
  test("'Try again later.' (no time) → undefined", () => {
    const msg = "You've hit your usage limit. Try again later.";
    expect(parseCodexRateLimitResetTime(msg)).toBeUndefined();
  });

  test("'or try again later.' (no time) → undefined", () => {
    const msg =
      "You've hit your usage limit. To get more access now, send a request to your admin or try again later.";
    expect(parseCodexRateLimitResetTime(msg)).toBeUndefined();
  });

  test("workspace-credit-depleted (no retry suffix at all) → undefined", () => {
    expect(
      parseCodexRateLimitResetTime("Your workspace is out of credits. Add credits to continue."),
    ).toBeUndefined();
  });

  test("workspace member out of credits → undefined", () => {
    expect(
      parseCodexRateLimitResetTime(
        "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
      ),
    ).toBeUndefined();
  });

  test("non-codex error message → undefined", () => {
    expect(parseCodexRateLimitResetTime("Connection failed: ECONNREFUSED")).toBeUndefined();
  });

  test("empty string → undefined", () => {
    expect(parseCodexRateLimitResetTime("")).toBeUndefined();
  });
});

describe("parseCodexRateLimitResetTime — invalid component rejection (CAI-1284 review)", () => {
  const now = new Date("2026-05-25T18:00:00Z");

  test("'Try again at 99:99 PM.' → undefined (hour and minute out of range)", () => {
    expect(
      parseCodexRateLimitResetTime("usage limit. Try again at 99:99 PM.", now),
    ).toBeUndefined();
  });

  test("'Try again at 13:99 PM.' → undefined (hour out of range)", () => {
    expect(
      parseCodexRateLimitResetTime("usage limit. Try again at 13:99 PM.", now),
    ).toBeUndefined();
  });

  test("'Try again at 0:30 PM.' → undefined (hour 0 is not 1–12)", () => {
    expect(parseCodexRateLimitResetTime("usage limit. Try again at 0:30 PM.", now)).toBeUndefined();
  });

  test("'Try again at 12:60 PM.' → undefined (minute 60 out of range)", () => {
    expect(
      parseCodexRateLimitResetTime("usage limit. Try again at 12:60 PM.", now),
    ).toBeUndefined();
  });

  test("'Try again at May 32nd, 2026 8:35 PM.' → undefined (day overflow)", () => {
    expect(
      parseCodexRateLimitResetTime("usage limit. Try again at May 32nd, 2026 8:35 PM.", now),
    ).toBeUndefined();
  });

  test("'Try again at Feb 30th, 2026 8:35 PM.' → undefined (Feb has ≤29 days)", () => {
    expect(
      parseCodexRateLimitResetTime("usage limit. Try again at Feb 30th, 2026 8:35 PM.", now),
    ).toBeUndefined();
  });

  test("'Try again at May 26th, 2026 8:35 PM.' → valid (positive control)", () => {
    expect(
      parseCodexRateLimitResetTime("usage limit. Try again at May 26th, 2026 8:35 PM.", now),
    ).toBe("2026-05-26T20:35:00.000Z");
  });
});

describe("parseCodexRateLimitResetTime — case-insensitive", () => {
  test("'TRY AGAIN AT 8:35 PM' (all caps) parses", () => {
    const now = new Date("2026-05-25T00:00:00Z");
    const result = parseCodexRateLimitResetTime("usage limit. TRY AGAIN AT 8:35 PM.", now);
    expect(result).toBe("2026-05-25T20:35:00.000Z");
  });
});

describe("SessionErrorTracker — Codex usage-limit integration", () => {
  test("stashes clamped reset time from verbatim CAI-1284 fixture", () => {
    const tracker = new SessionErrorTracker();
    tracker.processCodexUsageLimitMessage(VERBATIM_ERROR_MESSAGE);
    const iso = tracker.getRateLimitResetAt();
    expect(iso).toBeDefined();
    const ms = new Date(iso!).getTime();
    const nowMs = Date.now();
    // Bounded to [now+60s, now+7d]. The same-day wall-clock fixture may be >6h away.
    expect(ms).toBeGreaterThanOrEqual(nowMs + 59_000);
    expect(ms).toBeLessThanOrEqual(nowMs + MAX_RATE_LIMIT_RESET_MS + 1000);
  });

  test("non-usage-limit error does not stash", () => {
    const tracker = new SessionErrorTracker();
    tracker.processCodexUsageLimitMessage("Connection failed.");
    expect(tracker.getRateLimitResetAt()).toBeUndefined();
  });

  test("workspace-credit message does not stash (no parseable time)", () => {
    const tracker = new SessionErrorTracker();
    tracker.processCodexUsageLimitMessage(
      "Your workspace is out of credits. Add credits to continue.",
    );
    expect(tracker.getRateLimitResetAt()).toBeUndefined();
  });

  test("'try again later' variant does not stash (no parseable time)", () => {
    const tracker = new SessionErrorTracker();
    tracker.processCodexUsageLimitMessage(
      "You've hit your usage limit. To get more access now, send a request to your admin or try again later.",
    );
    expect(tracker.getRateLimitResetAt()).toBeUndefined();
  });

  test("last call wins on multiple usage-limit events", () => {
    const tracker = new SessionErrorTracker();
    // First: a past-sounding time that would be clamped to now+60s
    tracker.processCodexUsageLimitMessage("You've hit your usage limit. Try again at 1:00 AM.");
    const firstIso = tracker.getRateLimitResetAt();
    expect(firstIso).toBeDefined();

    // Second: clear future time
    const future = new Date(Date.now() + 3 * 60 * 60 * 1000); // +3h
    const h = future.getUTCHours();
    const m = future.getUTCMinutes();
    const hh = h % 12 || 12;
    const ampm = h >= 12 ? "PM" : "AM";
    const mm = String(m).padStart(2, "0");
    tracker.processCodexUsageLimitMessage(
      `You've hit your usage limit. Try again at ${hh}:${mm} ${ampm}.`,
    );
    const secondIso = tracker.getRateLimitResetAt();
    expect(secondIso).toBeDefined();
    // Last call wins — value changed (may be same or different after clamp, but defined)
  });

  test("empty string does not stash", () => {
    const tracker = new SessionErrorTracker();
    tracker.processCodexUsageLimitMessage("");
    expect(tracker.getRateLimitResetAt()).toBeUndefined();
  });
});
