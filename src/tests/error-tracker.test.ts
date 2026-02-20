import { describe, expect, test } from "bun:test";
import {
  parseStderrForErrors,
  SessionErrorTracker,
  trackErrorFromJson,
} from "../utils/error-tracker";

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
