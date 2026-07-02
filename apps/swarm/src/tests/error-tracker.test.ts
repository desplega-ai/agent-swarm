import { describe, expect, test } from "bun:test";
import {
  CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS,
  isCodexCreditsExhaustedMessage,
  isRateLimitMessage,
  MAX_RATE_LIMIT_RESET_MS,
  MIN_CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS,
  parseCodexRateLimitResetTime,
  parseRateLimitResetTime,
  parseStderrForErrors,
  resolveCodexCreditsExhaustedCooldownMs,
  SessionErrorTracker,
  trackErrorFromJson,
} from "../utils/error-tracker";

describe("SessionErrorTracker — getRateLimitResetAt", () => {
  test("returns undefined when no rate_limit_event was processed", () => {
    const tracker = new SessionErrorTracker();
    expect(tracker.getRateLimitResetAt()).toBeUndefined();
  });

  test("returns ISO string after a rejected rate_limit_event", () => {
    const tracker = new SessionErrorTracker();
    const futureResetsAtSec = Math.floor(Date.now() / 1000) + 3600;
    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: futureResetsAtSec },
    });
    const result = tracker.getRateLimitResetAt();
    expect(result).toBeDefined();
    expect(() => new Date(result!).toISOString()).not.toThrow();
  });

  test("returns undefined after only allowed/allowed_warning events", () => {
    const tracker = new SessionErrorTracker();
    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", resetsAt: 1779202200 },
    });
    tracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning", resetsAt: 1779202200 },
    });
    expect(tracker.getRateLimitResetAt()).toBeUndefined();
  });
});

describe("SessionErrorTracker", () => {
  test("hasErrors returns false when no errors tracked", () => {
    const tracker = new SessionErrorTracker();
    expect(tracker.hasErrors()).toBe(false);
    expect(tracker.getErrors()).toHaveLength(0);
  });

  test("addApiError tracks an API error", () => {
    const tracker = new SessionErrorTracker();
    tracker.addApiError("rate_limit", "Rate limit exceeded");

    expect(tracker.hasErrors()).toBe(true);
    const errors = tracker.getErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.type).toBe("api_error");
    expect(errors[0]!.errorCategory).toBe("rate_limit");
    expect(errors[0]!.message).toBe("Rate limit exceeded");
    expect(errors[0]!.timestamp).toBeTruthy();
  });

  test("addResultError tracks multiple error messages", () => {
    const tracker = new SessionErrorTracker();
    tracker.addResultError("error_max_turns", ["Turn limit reached", "Session ended"]);

    expect(tracker.getErrors()).toHaveLength(2);
    expect(tracker.getErrors()[0]!.type).toBe("result_error");
    expect(tracker.getErrors()[0]!.errorCategory).toBe("error_max_turns");
    expect(tracker.getErrors()[0]!.message).toBe("Turn limit reached");
    expect(tracker.getErrors()[1]!.message).toBe("Session ended");
  });

  test("addErrorEvent tracks an error event", () => {
    const tracker = new SessionErrorTracker();
    tracker.addErrorEvent("Something went wrong");

    const errors = tracker.getErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.type).toBe("api_error");
    expect(errors[0]!.message).toBe("Something went wrong");
    expect(errors[0]!.errorCategory).toBeUndefined();
  });

  test("addStderrError tracks a stderr error", () => {
    const tracker = new SessionErrorTracker();
    tracker.addStderrError("fatal: connection refused");

    const errors = tracker.getErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.type).toBe("stderr_error");
    expect(errors[0]!.message).toBe("fatal: connection refused");
  });

  test("detects Claude CLI invalid --resume session errors as stale sessions", () => {
    const tracker = new SessionErrorTracker();
    trackErrorFromJson(
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: [
          'Error during execution: Error: --resume requires a valid session ID or session title when used with --print. Usage: claude -p --resume <session-id|title>. Provided value "ses_19c145de3ffeD9qLlntj8SRO28" is not a UUID and does not match any session title.',
        ],
      },
      tracker,
    );

    expect(tracker.isSessionNotFound()).toBe(true);
  });
});

describe("buildFailureReason", () => {
  test("returns generic message when no errors", () => {
    const tracker = new SessionErrorTracker();
    expect(tracker.buildFailureReason(1)).toBe("Claude process exited with code 1");
  });

  test("returns rate limit message", () => {
    const tracker = new SessionErrorTracker();
    tracker.addApiError("rate_limit", "Too many requests");
    expect(tracker.buildFailureReason(1)).toBe("Rate limit hit: Too many requests");
  });

  test("returns authentication failed message", () => {
    const tracker = new SessionErrorTracker();
    tracker.addApiError("authentication_failed", "Invalid API key");
    expect(tracker.buildFailureReason(1)).toBe("Authentication failed: Invalid API key");
  });

  test("returns billing error message", () => {
    const tracker = new SessionErrorTracker();
    tracker.addApiError("billing_error", "Insufficient funds");
    expect(tracker.buildFailureReason(1)).toBe("Billing error: Insufficient funds");
  });

  test("returns server error message", () => {
    const tracker = new SessionErrorTracker();
    tracker.addApiError("server_error", "Service unavailable");
    expect(tracker.buildFailureReason(1)).toBe(
      "Server error (API overloaded): Service unavailable",
    );
  });

  test("returns max turns exceeded for result errors", () => {
    const tracker = new SessionErrorTracker();
    tracker.addResultError("error_max_turns", ["Reached 50 turns"]);
    expect(tracker.buildFailureReason(1)).toBe("Max turns exceeded: Reached 50 turns");
  });

  test("returns budget limit exceeded for result errors", () => {
    const tracker = new SessionErrorTracker();
    tracker.addResultError("error_max_budget_usd", ["$5.00 limit reached"]);
    expect(tracker.buildFailureReason(1)).toBe("Budget limit exceeded: $5.00 limit reached");
  });

  test("returns error during execution for result errors", () => {
    const tracker = new SessionErrorTracker();
    tracker.addResultError("error_during_execution", ["Process crashed"]);
    expect(tracker.buildFailureReason(1)).toBe("Error during execution: Process crashed");
  });

  test("returns generic session error for unknown result subtype", () => {
    const tracker = new SessionErrorTracker();
    tracker.addResultError("unknown_subtype", ["Something odd"]);
    expect(tracker.buildFailureReason(2)).toBe("Session error (exit code 2): Something odd");
  });

  test("falls back to session error when only stderr errors present", () => {
    const tracker = new SessionErrorTracker();
    tracker.addStderrError("segfault");
    expect(tracker.buildFailureReason(139)).toBe("Session error (exit code 139): segfault");
  });

  test("falls back to session error for error events without category", () => {
    const tracker = new SessionErrorTracker();
    tracker.addErrorEvent("connection timeout");
    expect(tracker.buildFailureReason(1)).toBe("Session error (exit code 1): connection timeout");
  });

  test("shows count of additional errors when multiple unique messages", () => {
    const tracker = new SessionErrorTracker();
    tracker.addApiError("rate_limit", "Error one");
    tracker.addApiError("rate_limit", "Error two");
    tracker.addApiError("rate_limit", "Error three");
    expect(tracker.buildFailureReason(1)).toBe("Rate limit hit: Error one (+2 more error(s))");
  });

  test("deduplicates identical error messages in count", () => {
    const tracker = new SessionErrorTracker();
    tracker.addApiError("rate_limit", "Same error");
    tracker.addApiError("rate_limit", "Same error");
    tracker.addApiError("rate_limit", "Different error");
    expect(tracker.buildFailureReason(1)).toBe("Rate limit hit: Same error (+1 more error(s))");
  });

  test("uses first api error category as primary", () => {
    const tracker = new SessionErrorTracker();
    tracker.addApiError("rate_limit", "Rate limited");
    tracker.addApiError("server_error", "Server down");
    // First category (rate_limit) wins
    expect(tracker.buildFailureReason(1)).toBe("Rate limit hit: Rate limited (+1 more error(s))");
  });
});

describe("trackErrorFromJson", () => {
  test("tracks assistant message with API error", () => {
    const tracker = new SessionErrorTracker();
    trackErrorFromJson(
      {
        type: "assistant",
        message: {
          error: "rate_limit",
          content: [{ text: "Rate limit exceeded, please retry" }],
        },
      },
      tracker,
    );

    const errors = tracker.getErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.type).toBe("api_error");
    expect(errors[0]!.errorCategory).toBe("rate_limit");
    expect(errors[0]!.message).toBe("Rate limit exceeded, please retry");
  });

  test("tracks assistant message error with no content, falls back to error string", () => {
    const tracker = new SessionErrorTracker();
    trackErrorFromJson(
      {
        type: "assistant",
        message: { error: "server_error" },
      },
      tracker,
    );

    const errors = tracker.getErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("server_error");
  });

  test("ignores assistant messages without error", () => {
    const tracker = new SessionErrorTracker();
    trackErrorFromJson({ type: "assistant", message: { content: [{ text: "Hello" }] } }, tracker);
    expect(tracker.hasErrors()).toBe(false);
  });

  test("tracks explicit error events", () => {
    const tracker = new SessionErrorTracker();
    trackErrorFromJson({ type: "error", error: "Connection lost" }, tracker);

    const errors = tracker.getErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.type).toBe("api_error");
    expect(errors[0]!.message).toBe("Connection lost");
  });

  test("tracks error event with message field fallback", () => {
    const tracker = new SessionErrorTracker();
    trackErrorFromJson({ type: "error", message: "Timeout reached" }, tracker);

    expect(tracker.getErrors()[0]!.message).toBe("Timeout reached");
  });

  test("tracks error event with JSON fallback when no error or message", () => {
    const tracker = new SessionErrorTracker();
    trackErrorFromJson({ type: "error" }, tracker);

    expect(tracker.getErrors()[0]!.message).toBe('{"type":"error"}');
  });

  test("tracks result events with is_error true", () => {
    const tracker = new SessionErrorTracker();
    trackErrorFromJson(
      {
        type: "result",
        is_error: true,
        subtype: "error_max_turns",
        errors: ["Max turns reached"],
      },
      tracker,
    );

    const errors = tracker.getErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.type).toBe("result_error");
    expect(errors[0]!.errorCategory).toBe("error_max_turns");
    expect(errors[0]!.message).toBe("Max turns reached");
  });

  test("tracks result event falling back to result field when no errors array", () => {
    const tracker = new SessionErrorTracker();
    trackErrorFromJson({ type: "result", is_error: true, result: "Something failed" }, tracker);

    expect(tracker.getErrors()[0]!.message).toBe("Something failed");
    expect(tracker.getErrors()[0]!.errorCategory).toBe("error_during_execution");
  });

  test("tracks result event with unknown error when no errors or result", () => {
    const tracker = new SessionErrorTracker();
    trackErrorFromJson({ type: "result", is_error: true }, tracker);

    expect(tracker.getErrors()[0]!.message).toBe("Unknown error");
  });

  test("ignores result events without is_error", () => {
    const tracker = new SessionErrorTracker();
    trackErrorFromJson({ type: "result", result: "All good" }, tracker);
    expect(tracker.hasErrors()).toBe(false);
  });

  test("ignores unrelated event types", () => {
    const tracker = new SessionErrorTracker();
    trackErrorFromJson({ type: "content_block_delta", delta: {} }, tracker);
    expect(tracker.hasErrors()).toBe(false);
  });

  test("rate_limit_event is not treated as an error signal", () => {
    const tracker = new SessionErrorTracker();
    trackErrorFromJson(
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: 1779202200 },
      },
      tracker,
    );
    expect(tracker.hasErrors()).toBe(false);
  });
});

describe("parseStderrForErrors", () => {
  test("ignores empty or whitespace-only stderr", () => {
    const tracker = new SessionErrorTracker();
    parseStderrForErrors("", tracker);
    parseStderrForErrors("   ", tracker);
    expect(tracker.hasErrors()).toBe(false);
  });

  test("detects rate limit errors", () => {
    const tracker = new SessionErrorTracker();
    parseStderrForErrors("Rate limit exceeded for model", tracker);

    expect(tracker.getErrors()).toHaveLength(1);
    expect(tracker.getErrors()[0]!.message).toBe("Rate limit exceeded for model");
  });

  test("detects rate_limit with underscore", () => {
    const tracker = new SessionErrorTracker();
    parseStderrForErrors("rate_limit: too many requests", tracker);

    expect(tracker.hasErrors()).toBe(true);
  });

  test("detects 429 status code", () => {
    const tracker = new SessionErrorTracker();
    parseStderrForErrors("HTTP 429 Too Many Requests", tracker);

    expect(tracker.hasErrors()).toBe(true);
  });

  test("detects 'hit your limit' as rate limit error", () => {
    const tracker = new SessionErrorTracker();
    parseStderrForErrors("You've hit your limit for the day", tracker);

    expect(tracker.hasErrors()).toBe(true);
    expect(tracker.getErrors()).toHaveLength(1);
    expect(tracker.getErrors()[0]!.type).toBe("stderr_error");
    expect(tracker.getErrors()[0]!.message).toBe("You've hit your limit for the day");
  });

  test("detects 'hit your limit' case-insensitively", () => {
    const tracker = new SessionErrorTracker();
    parseStderrForErrors("Hit Your Limit · resets 3pm (UTC)", tracker);

    expect(tracker.hasErrors()).toBe(true);
    expect(tracker.getErrors()[0]!.message).toBe("Hit Your Limit · resets 3pm (UTC)");
  });

  test("detects authentication errors", () => {
    const tracker = new SessionErrorTracker();
    parseStderrForErrors("Authentication failed: invalid key", tracker);

    expect(tracker.getErrors()[0]!.message).toBe(
      "Authentication error: Authentication failed: invalid key",
    );
  });

  test("detects unauthorized errors", () => {
    const tracker = new SessionErrorTracker();
    parseStderrForErrors("Unauthorized access attempt", tracker);

    expect(tracker.getErrors()[0]!.message).toContain("Authentication error:");
  });

  test("detects 401 status code", () => {
    const tracker = new SessionErrorTracker();
    parseStderrForErrors("HTTP 401 Unauthorized", tracker);

    expect(tracker.getErrors()[0]!.message).toContain("Authentication error:");
  });

  test("detects billing errors", () => {
    const tracker = new SessionErrorTracker();
    parseStderrForErrors("Billing account suspended", tracker);

    expect(tracker.getErrors()[0]!.message).toContain("Billing error:");
  });

  test("detects payment errors", () => {
    const tracker = new SessionErrorTracker();
    parseStderrForErrors("Payment method declined", tracker);

    expect(tracker.getErrors()[0]!.message).toContain("Billing error:");
  });

  test("detects generic error keyword", () => {
    const tracker = new SessionErrorTracker();
    parseStderrForErrors("Error: ECONNREFUSED", tracker);

    expect(tracker.getErrors()[0]!.message).toBe("Error: ECONNREFUSED");
  });

  test("detects fatal keyword", () => {
    const tracker = new SessionErrorTracker();
    parseStderrForErrors("fatal: unable to access remote", tracker);

    expect(tracker.getErrors()[0]!.message).toBe("fatal: unable to access remote");
  });

  test("detects panic keyword", () => {
    const tracker = new SessionErrorTracker();
    parseStderrForErrors("panic: runtime error: index out of range", tracker);

    expect(tracker.getErrors()[0]!.message).toBe("panic: runtime error: index out of range");
  });

  test("uses only first line of multiline stderr", () => {
    const tracker = new SessionErrorTracker();
    parseStderrForErrors("Error: something broke\n  at function.js:10\n  at main.js:5", tracker);

    expect(tracker.getErrors()[0]!.message).toBe("Error: something broke");
  });

  test("ignores stderr without recognized error patterns", () => {
    const tracker = new SessionErrorTracker();
    parseStderrForErrors("Debugger attached.\nWaiting for connections...", tracker);

    expect(tracker.hasErrors()).toBe(false);
  });
});

describe("rate limit detection regex (runner)", () => {
  // This regex is used in runner.ts to detect rate-limited failures from credential errors
  const rateLimitRegex = /rate.?limit|hit your limit/i;

  test("matches 'rate limit' with space", () => {
    expect(rateLimitRegex.test("Rate limit hit: Too many requests")).toBe(true);
  });

  test("matches 'rate_limit' with underscore", () => {
    expect(rateLimitRegex.test("rate_limit exceeded")).toBe(true);
  });

  test("matches 'ratelimit' without separator", () => {
    expect(rateLimitRegex.test("ratelimit error")).toBe(true);
  });

  test("matches 'hit your limit' message", () => {
    expect(rateLimitRegex.test("You've hit your limit · resets 3pm (UTC)")).toBe(true);
  });

  test("matches 'Hit Your Limit' case-insensitively", () => {
    expect(rateLimitRegex.test("Hit Your Limit")).toBe(true);
  });

  test("does not match unrelated errors", () => {
    expect(rateLimitRegex.test("Authentication failed")).toBe(false);
    expect(rateLimitRegex.test("Server error 500")).toBe(false);
    expect(rateLimitRegex.test("Connection timeout")).toBe(false);
  });
});

describe("parseRateLimitResetTime", () => {
  test("parses 'resets 3pm (UTC)' format", () => {
    const result = parseRateLimitResetTime(
      "Rate limit hit: You've hit your limit · resets 3pm (UTC)",
    );
    expect(result).toBeDefined();
    const parsed = new Date(result!);
    expect(parsed.getUTCHours()).toBe(15);
    expect(parsed.getUTCMinutes()).toBe(0);
  });

  test("parses 'resets 3:30pm (UTC)' format with minutes", () => {
    const result = parseRateLimitResetTime("resets 3:30pm (UTC)");
    expect(result).toBeDefined();
    const parsed = new Date(result!);
    expect(parsed.getUTCHours()).toBe(15);
    expect(parsed.getUTCMinutes()).toBe(30);
  });

  test("parses 'resets 12am (UTC)' as midnight", () => {
    const result = parseRateLimitResetTime("resets 12am (UTC)");
    expect(result).toBeDefined();
    const parsed = new Date(result!);
    expect(parsed.getUTCHours()).toBe(0);
  });

  test("parses 'resets May 14, 5pm (UTC)' with date prefix", () => {
    const result = parseRateLimitResetTime("You've hit your limit · resets May 14, 5pm (UTC)");
    expect(result).toBeDefined();
    const parsed = new Date(result!);
    expect(parsed.getUTCMonth()).toBe(4); // May = index 4
    expect(parsed.getUTCDate()).toBe(14);
    expect(parsed.getUTCHours()).toBe(17);
    expect(parsed.getUTCMinutes()).toBe(0);
  });

  test("parses dated reset without comma", () => {
    const result = parseRateLimitResetTime("resets Jan 3 9:30am (UTC)");
    expect(result).toBeDefined();
    const parsed = new Date(result!);
    expect(parsed.getUTCMonth()).toBe(0);
    expect(parsed.getUTCDate()).toBe(3);
    expect(parsed.getUTCHours()).toBe(9);
    expect(parsed.getUTCMinutes()).toBe(30);
  });

  test("dated reset in the past rolls to next year", () => {
    const now = new Date();
    // Pick a month/day in the past relative to "now"
    const pastMonth = now.getUTCMonth() === 0 ? "December" : "January";
    const result = parseRateLimitResetTime(`resets ${pastMonth} 1, 12pm (UTC)`);
    expect(result).toBeDefined();
    const parsed = new Date(result!);
    expect(parsed.getTime()).toBeGreaterThan(now.getTime());
  });

  test("parses 'retry after N seconds'", () => {
    const before = Date.now();
    const result = parseRateLimitResetTime("Rate limited. retry after 60 seconds");
    expect(result).toBeDefined();
    const parsed = new Date(result!).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before + 59_000);
    expect(parsed).toBeLessThanOrEqual(before + 62_000);
  });

  test("parses 'wait N minutes'", () => {
    const before = Date.now();
    const result = parseRateLimitResetTime("Please wait 5 minutes before retrying");
    expect(result).toBeDefined();
    const parsed = new Date(result!).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before + 4 * 60_000);
    expect(parsed).toBeLessThanOrEqual(before + 6 * 60_000);
  });

  test("returns undefined for unparseable messages", () => {
    expect(parseRateLimitResetTime("Rate limit exceeded")).toBeUndefined();
    expect(parseRateLimitResetTime("Too many requests")).toBeUndefined();
    expect(parseRateLimitResetTime("")).toBeUndefined();
  });

  test("rejects unreasonable durations", () => {
    // More than 24 hours in seconds
    expect(parseRateLimitResetTime("retry after 100000 seconds")).toBeUndefined();
    // More than 24 hours in minutes
    expect(parseRateLimitResetTime("wait 2000 minutes")).toBeUndefined();
  });
});

describe("isCodexCreditsExhaustedMessage", () => {
  const CANONICAL =
    "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.";

  test("returns true for the canonical credits-exhausted message", () => {
    expect(isCodexCreditsExhaustedMessage(CANONICAL)).toBe(true);
  });

  test("matches 'out of credits' fragment", () => {
    expect(isCodexCreditsExhaustedMessage("Your workspace is out of credits.")).toBe(true);
  });

  test("matches 'refill in order to continue' fragment", () => {
    expect(isCodexCreditsExhaustedMessage("Please refill in order to continue.")).toBe(true);
  });

  test("matches 'workspace owner to refill' fragment", () => {
    expect(isCodexCreditsExhaustedMessage("Ask your workspace owner to refill credits.")).toBe(
      true,
    );
  });

  test("is case-insensitive", () => {
    expect(isCodexCreditsExhaustedMessage("OUT OF CREDITS")).toBe(true);
  });

  test("returns false for unrelated errors", () => {
    expect(isCodexCreditsExhaustedMessage("No conversation found with session ID abc123")).toBe(
      false,
    );
    expect(isCodexCreditsExhaustedMessage("Authentication failed")).toBe(false);
    expect(isCodexCreditsExhaustedMessage("Rate limit exceeded")).toBe(false);
    expect(isCodexCreditsExhaustedMessage("Connection timeout")).toBe(false);
  });

  test("returns false for bare 'refill' without qualifying context", () => {
    expect(isCodexCreditsExhaustedMessage("Please refill your coffee")).toBe(false);
  });
});

describe("isRateLimitMessage — Codex credits-exhausted integration", () => {
  const CANONICAL =
    "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.";

  test("returns true for canonical Codex credits-exhausted message", () => {
    expect(isRateLimitMessage(CANONICAL)).toBe(true);
  });

  test("still returns true for standard rate-limit messages", () => {
    expect(isRateLimitMessage("Rate limit exceeded")).toBe(true);
    expect(isRateLimitMessage("429 Too Many Requests")).toBe(true);
    expect(isRateLimitMessage("You've hit your weekly limit")).toBe(true);
  });

  test("still returns false for unrelated errors", () => {
    expect(isRateLimitMessage("No conversation found with session ID abc123")).toBe(false);
    expect(isRateLimitMessage("Authentication failed")).toBe(false);
    expect(isRateLimitMessage("Server error 500")).toBe(false);
  });
});

describe("resolveCodexCreditsExhaustedCooldownMs", () => {
  test("absent (undefined) → default constant", () => {
    expect(resolveCodexCreditsExhaustedCooldownMs(undefined)).toBe(
      CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS,
    );
  });

  test("null → default constant", () => {
    expect(resolveCodexCreditsExhaustedCooldownMs(null)).toBe(CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS);
  });

  test("empty string → default constant", () => {
    expect(resolveCodexCreditsExhaustedCooldownMs("")).toBe(CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS);
  });

  test("non-numeric string → default constant", () => {
    expect(resolveCodexCreditsExhaustedCooldownMs("abc")).toBe(CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS);
  });

  test("zero → default constant", () => {
    expect(resolveCodexCreditsExhaustedCooldownMs("0")).toBe(CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS);
  });

  test("negative → default constant", () => {
    expect(resolveCodexCreditsExhaustedCooldownMs("-5")).toBe(CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS);
  });

  test("valid in-range string (30m) → parsed value", () => {
    expect(resolveCodexCreditsExhaustedCooldownMs("1800000")).toBe(1_800_000);
  });

  test("valid in-range number (30m) → parsed value", () => {
    expect(resolveCodexCreditsExhaustedCooldownMs(1_800_000)).toBe(1_800_000);
  });

  test("below floor → clamped to MIN", () => {
    expect(resolveCodexCreditsExhaustedCooldownMs("1000")).toBe(
      MIN_CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS,
    );
  });

  test("above ceiling (8d) → clamped to MAX", () => {
    expect(resolveCodexCreditsExhaustedCooldownMs(String(8 * 24 * 60 * 60 * 1000))).toBe(
      MAX_RATE_LIMIT_RESET_MS,
    );
  });

  test("partial-numeric strings → default constant (not silently truncated)", () => {
    for (const bad of ["60000ms", "1.5", "123abc", "1e5"]) {
      expect(resolveCodexCreditsExhaustedCooldownMs(bad)).toBe(CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS);
    }
  });
});

describe("Codex/Claude coexistence — single tracker handles both providers", () => {
  test("processRateLimitEvent (Claude) and processCodexUsageLimitMessage (Codex) both stash into getRateLimitResetAt", () => {
    // Claude path: processRateLimitEvent
    const claudeTracker = new SessionErrorTracker();
    const futureResetsAtSec = Math.floor(Date.now() / 1000) + 3600;
    claudeTracker.processRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: futureResetsAtSec },
    });
    expect(claudeTracker.getRateLimitResetAt()).toBeDefined();

    // Codex path: processCodexUsageLimitMessage
    const codexTracker = new SessionErrorTracker();
    codexTracker.processCodexUsageLimitMessage(
      "You've hit your usage limit. To get more access now, send a request to your admin or try again at 8:35 PM.",
    );
    expect(codexTracker.getRateLimitResetAt()).toBeDefined();

    // A tracker that received a Claude event does NOT get cross-contaminated by
    // an independent Codex call on a different instance.
    const iso = claudeTracker.getRateLimitResetAt();
    expect(iso).toBeDefined();
    const ms = new Date(iso!).getTime();
    expect(ms).toBeCloseTo(futureResetsAtSec * 1000, -2); // within 100ms tolerance
  });

  test("parseCodexRateLimitResetTime does not interfere with parseRateLimitResetTime fixtures", () => {
    // Claude format: "resets 3pm (UTC)" — must NOT be matched by Codex parser
    expect(parseCodexRateLimitResetTime("resets 3pm (UTC)")).toBeUndefined();
    // Codex format: "try again at 8:35 PM" — must NOT be matched by Claude parser
    expect(parseRateLimitResetTime("try again at 8:35 PM.")).toBeUndefined();
  });
});
