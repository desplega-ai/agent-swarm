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

export class SessionErrorTracker {
  private errors: ErrorSignal[] = [];

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

/**
 * Parse stderr text for known error patterns and add them to the tracker.
 */
export function parseStderrForErrors(stderr: string, tracker: SessionErrorTracker): void {
  if (!stderr.trim()) return;

  const lower = stderr.toLowerCase();
  const firstLine = stderr.trim().split("\n")[0] ?? stderr.trim();

  if (lower.includes("rate limit") || lower.includes("rate_limit") || lower.includes("429")) {
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
