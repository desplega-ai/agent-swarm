/**
 * Tracks error signals from Claude CLI stream-json output to produce
 * meaningful failure reasons instead of generic "exited with code N".
 */

export interface ErrorSignal {
  type: "api_error" | "result_error" | "stderr_error";
  errorCategory?: string;
  message: string;
  timestamp: string;
}

/**
 * Clamps a candidate reset timestamp (ms) to [now+60s, now+6h].
 * Protects against past timestamps (clock skew) and absurdly far future values (malformed).
 */
function clampRateLimitResetMs(candidateMs: number): number {
  const nowMs = Date.now();
  const minMs = nowMs + 60_000;
  const maxMs = nowMs + 6 * 60 * 60 * 1000;
  return Math.min(Math.max(candidateMs, minMs), maxMs);
}

export class SessionErrorTracker {
  private errors: ErrorSignal[] = [];
  /** Stashed reset time (ms) from the last rejected rate_limit_event in this session. */
  private rateLimitResetAtMs: number | undefined;

  /** Record an error from an assistant message with message.error field */
  addApiError(errorCategory: string, message: string): void {
    this.errors.push({
      type: "api_error",
      errorCategory,
      message,
      timestamp: new Date().toISOString(),
    });
  }

  /** Record an error from a result event with is_error: true */
  addResultError(subtype: string, errors: string[]): void {
    for (const msg of errors) {
      this.errors.push({
        type: "result_error",
        errorCategory: subtype,
        message: msg,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /** Record an error from an explicit type: "error" event */
  addErrorEvent(message: string): void {
    this.errors.push({
      type: "api_error",
      message,
      timestamp: new Date().toISOString(),
    });
  }

  /** Record an error pattern found in stderr */
  addStderrError(message: string): void {
    this.errors.push({
      type: "stderr_error",
      message,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Process a parsed rate_limit_event JSON object from the Claude CLI stream.
   * Only stashes the reset time when status === "rejected"; ignores all others.
   * Last call wins — if the CLI emits multiple events, the final rejected one is used.
   *
   * `resetsAt` is **seconds** since epoch (empirically verified; Linear description is wrong).
   * Conversion to ms happens here at this single well-named boundary.
   */
  processRateLimitEvent(json: Record<string, unknown>): void {
    try {
      const info = json.rate_limit_info as Record<string, unknown> | undefined;
      if (!info) return;

      if (info.status !== "rejected") return;

      const resetsAtSec = info.resetsAt;
      if (typeof resetsAtSec !== "number" || !Number.isFinite(resetsAtSec) || resetsAtSec <= 0) {
        console.warn(
          `[rate_limit_event] Malformed resetsAt value: ${JSON.stringify(resetsAtSec)} — ignoring`,
        );
        return;
      }

      const resetsAtMs = resetsAtSec * 1000;
      this.rateLimitResetAtMs = clampRateLimitResetMs(resetsAtMs);
    } catch (err) {
      console.warn(`[rate_limit_event] Failed to process event: ${err}`);
    }
  }

  /**
   * Returns the stashed rate limit reset time as an ISO string, or undefined
   * if no rejected rate_limit_event was seen in this session.
   */
  getRateLimitResetAt(): string | undefined {
    if (this.rateLimitResetAtMs === undefined) return undefined;
    return new Date(this.rateLimitResetAtMs).toISOString();
  }

  hasErrors(): boolean {
    return this.errors.length > 0;
  }

  /**
   * Build a meaningful failure reason string from accumulated errors.
   * Falls back to the generic exit code message if no errors were captured.
   */
  buildFailureReason(exitCode: number): string {
    if (this.errors.length === 0) {
      return `Claude process exited with code ${exitCode}`;
    }

    const uniqueMessages = [...new Set(this.errors.map((e) => e.message))];
    const apiErrors = this.errors.filter((e) => e.type === "api_error" && e.errorCategory);
    const primaryCategory = apiErrors.length > 0 ? (apiErrors[0]!.errorCategory ?? null) : null;

    const parts: string[] = [];

    switch (primaryCategory) {
      case "rate_limit":
        parts.push("Rate limit hit");
        break;
      case "authentication_failed":
        parts.push("Authentication failed");
        break;
      case "billing_error":
        parts.push("Billing error");
        break;
      case "server_error":
        parts.push("Server error (API overloaded)");
        break;
      default: {
        const resultErrors = this.errors.filter((e) => e.type === "result_error");
        if (resultErrors.length > 0) {
          const subtype = resultErrors[0]!.errorCategory;
          switch (subtype) {
            case "error_max_turns":
              parts.push("Max turns exceeded");
              break;
            case "error_max_budget_usd":
              parts.push("Budget limit exceeded");
              break;
            case "error_during_execution":
              parts.push("Error during execution");
              break;
            default:
              parts.push(`Session error (exit code ${exitCode})`);
          }
        } else {
          parts.push(`Session error (exit code ${exitCode})`);
        }
      }
    }

    if (uniqueMessages.length > 0) {
      parts.push(`: ${uniqueMessages[0]}`);
    }

    if (uniqueMessages.length > 1) {
      parts.push(` (+${uniqueMessages.length - 1} more error(s))`);
    }

    return parts.join("");
  }

  /** Check if the failure was due to a missing/stale session ID */
  isSessionNotFound(): boolean {
    return this.errors.some((e) => e.message.includes("No conversation found with session ID"));
  }

  getErrors(): ReadonlyArray<ErrorSignal> {
    return this.errors;
  }
}

/**
 * Extract error signals from a parsed JSON line of Claude CLI stream-json output.
 * Call this for each parsed JSON object from stdout.
 */
export function trackErrorFromJson(
  json: Record<string, unknown>,
  tracker: SessionErrorTracker,
): void {
  // 0. Structured rate limit event — stash resetsAt for the three-tier resolver in runner.ts
  if (json.type === "rate_limit_event") {
    tracker.processRateLimitEvent(json);
    return;
  }

  // 1. Assistant messages with API errors (rate_limit, auth, billing, etc.)
  if (json.type === "assistant") {
    const message = json.message as Record<string, unknown> | undefined;
    if (message?.error) {
      const content = message.content as Array<Record<string, unknown>> | undefined;
      const errorText =
        (content?.[0]?.text as string) || String(message.error) || "Unknown API error";
      tracker.addApiError(String(message.error), errorText);
    }
  }

  // 2. Explicit error events
  if (json.type === "error") {
    const errorText = (json.error as string) || (json.message as string) || JSON.stringify(json);
    tracker.addErrorEvent(errorText);
  }

  // 3. Result events with errors
  if (json.type === "result" && json.is_error) {
    const errors = Array.isArray(json.errors) ? (json.errors as string[]) : [];
    const subtype = (json.subtype as string) || "error_during_execution";
    tracker.addResultError(
      subtype,
      errors.length > 0 ? errors : [(json.result as string) || "Unknown error"],
    );
  }
}

const MONTH_NAMES: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

/**
 * Parse a rate limit error message to extract a reset time, returning an ISO datetime string.
 * Handles patterns like:
 *   - "resets 3pm (UTC)" / "resets 3:30pm (UTC)"
 *   - "resets May 14, 5pm (UTC)" / "resets May 14 5pm (UTC)"
 *   - "retry after 60 seconds" / "wait 120 seconds"
 *   - "retry after 2 minutes"
 * Returns undefined if no parseable reset time is found.
 */
export function parseRateLimitResetTime(errorMessage: string): string | undefined {
  // Pattern 1a: "resets <Month> <day>[,] <time> (UTC)" — e.g. "resets May 14, 5pm (UTC)"
  const datedMatch = errorMessage.match(
    /resets?\s+([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(?\s*UTC\s*\)?/i,
  );
  if (datedMatch) {
    const monthIdx = MONTH_NAMES[datedMatch[1]!.toLowerCase()];
    if (monthIdx !== undefined) {
      const day = Number.parseInt(datedMatch[2]!, 10);
      let hours = Number.parseInt(datedMatch[3]!, 10);
      const minutes = datedMatch[4] ? Number.parseInt(datedMatch[4], 10) : 0;
      const ampm = datedMatch[5]!.toLowerCase();
      if (ampm === "pm" && hours !== 12) hours += 12;
      if (ampm === "am" && hours === 12) hours = 0;

      const now = new Date();
      let year = now.getUTCFullYear();
      let resetDate = new Date(Date.UTC(year, monthIdx, day, hours, minutes, 0));
      // If the parsed date is in the past (date wrapped around year-end), assume next year.
      if (resetDate.getTime() <= now.getTime()) {
        year += 1;
        resetDate = new Date(Date.UTC(year, monthIdx, day, hours, minutes, 0));
      }
      return resetDate.toISOString();
    }
  }

  // Pattern 1b: "resets <time> (UTC)" — e.g. "resets 3pm (UTC)", "resets 3:30pm (UTC)"
  const resetTimeMatch = errorMessage.match(
    /resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(?\s*UTC\s*\)?/i,
  );
  if (resetTimeMatch) {
    let hours = Number.parseInt(resetTimeMatch[1]!, 10);
    const minutes = resetTimeMatch[2] ? Number.parseInt(resetTimeMatch[2], 10) : 0;
    const ampm = resetTimeMatch[3]!.toLowerCase();
    if (ampm === "pm" && hours !== 12) hours += 12;
    if (ampm === "am" && hours === 12) hours = 0;

    const now = new Date();
    const resetDate = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes, 0),
    );
    // If the parsed time is in the past, assume it's tomorrow
    if (resetDate.getTime() <= now.getTime()) {
      resetDate.setUTCDate(resetDate.getUTCDate() + 1);
    }
    return resetDate.toISOString();
  }

  // Pattern 2: "retry after N seconds" / "wait N seconds"
  const secondsMatch = errorMessage.match(/(?:retry\s+after|wait)\s+(\d+)\s*seconds?/i);
  if (secondsMatch) {
    const seconds = Number.parseInt(secondsMatch[1]!, 10);
    if (seconds > 0 && seconds <= 86400) {
      return new Date(Date.now() + seconds * 1000).toISOString();
    }
  }

  // Pattern 3: "retry after N minutes" / "wait N minutes"
  const minutesMatch = errorMessage.match(/(?:retry\s+after|wait)\s+(\d+)\s*minutes?/i);
  if (minutesMatch) {
    const mins = Number.parseInt(minutesMatch[1]!, 10);
    if (mins > 0 && mins <= 1440) {
      return new Date(Date.now() + mins * 60 * 1000).toISOString();
    }
  }

  return undefined;
}

/**
 * Parse stderr text for known error patterns and add them to the tracker.
 */
export function parseStderrForErrors(stderr: string, tracker: SessionErrorTracker): void {
  if (!stderr.trim()) return;

  const lower = stderr.toLowerCase();
  const firstLine = stderr.trim().split("\n")[0] ?? stderr.trim();

  if (
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("429") ||
    lower.includes("hit your limit")
  ) {
    tracker.addStderrError(firstLine);
  } else if (
    lower.includes("authentication") ||
    lower.includes("unauthorized") ||
    lower.includes("401")
  ) {
    tracker.addStderrError(`Authentication error: ${firstLine}`);
  } else if (lower.includes("billing") || lower.includes("payment")) {
    tracker.addStderrError(`Billing error: ${firstLine}`);
  } else if (lower.includes("error") || lower.includes("fatal") || lower.includes("panic")) {
    tracker.addStderrError(firstLine);
  }
}
