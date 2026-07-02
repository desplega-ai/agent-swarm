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

export interface RateLimitWindowInfo {
  status: string;
  utilization?: number;
  resetsAt?: number;
  isUsingOverage?: boolean;
  surpassedThreshold?: number;
  lastSeenAt: string;
}

export type RateLimitWindowTelemetry = Record<string, RateLimitWindowInfo>;

export function parseRateLimitWindowTelemetry(
  json: Record<string, unknown>,
  lastSeenAt = new Date().toISOString(),
): { rateLimitType: string; info: RateLimitWindowInfo } | null {
  try {
    if (json.type !== "rate_limit_event") return null;
    const rawInfo = json.rate_limit_info;
    if (!rawInfo || typeof rawInfo !== "object") return null;

    const info = rawInfo as Record<string, unknown>;
    if (typeof info.status !== "string" || info.status.length === 0) return null;
    if (typeof info.rateLimitType !== "string" || info.rateLimitType.length === 0) return null;

    const window: RateLimitWindowInfo = {
      status: info.status,
      lastSeenAt,
    };

    if (typeof info.utilization === "number" && Number.isFinite(info.utilization)) {
      window.utilization = info.utilization;
    }
    if (typeof info.resetsAt === "number" && Number.isFinite(info.resetsAt) && info.resetsAt > 0) {
      window.resetsAt = info.resetsAt;
    }
    if (typeof info.isUsingOverage === "boolean") {
      window.isUsingOverage = info.isUsingOverage;
    }
    if (typeof info.surpassedThreshold === "number" && Number.isFinite(info.surpassedThreshold)) {
      window.surpassedThreshold = info.surpassedThreshold;
    }

    return { rateLimitType: info.rateLimitType, info: window };
  } catch {
    return null;
  }
}

/**
 * Maximum cooldown horizon for a rate-limit reset. A weekly OAuth limit resets
 * up to ~7 days out, so the cap must be at least that or a weekly-limited key
 * gets re-clamped to a short cooldown and re-handed to a worker every few hours
 * (the fail-every-6h sawtooth). 7d still guards against absurd far-future
 * (malformed) values.
 */
export const MAX_RATE_LIMIT_RESET_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Single source of truth for "does this text look like a rate-limit signal?".
 * Shared by the runner's cooldown gate and {@link parseStderrForErrors} so the
 * two matchers can't drift. Tolerates a qualifier between "your" and "limit"
 * (weekly / 5-hour / daily): matches "hit your weekly limit", "hit your 5-hour
 * limit", "hit your limit", "Claude usage limit reached", "rate limit exceeded",
 * "429 Too Many Requests"; does not match "No conversation found with session ID".
 */
export function isRateLimitMessage(s: string): boolean {
  return (
    /rate.?limit|hit your[\w\s-]*limit|usage[ _-]?limit|too many requests|\b429\b/i.test(s) ||
    isCodexCreditsExhaustedMessage(s)
  );
}

/**
 * Detects Codex's workspace-credit-exhausted error, which surfaces as:
 * "Your workspace is out of credits. Ask your workspace owner to refill in order to continue."
 * This wording does not match the standard rate-limit patterns, so it needs its own predicate.
 * Kept specific to avoid false positives — "refill" alone is intentionally excluded.
 */
export function isCodexCreditsExhaustedMessage(s: string): boolean {
  return /out of credits|refill in order to continue|workspace owner to refill/i.test(s);
}

/** Default cooldown applied when a Codex OAuth slot returns a credits-exhausted error.
 *  The workspace credit cap is weekly, so a 2-hour cooldown is conservative but avoids
 *  the sawtooth of the 5-minute tier-3 fallback re-handing the dead slot every 5 minutes.
 */
export const CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h

/** Floor for the operator-tunable Codex credits cooldown — never shorter than the tier-3 fallback. */
export const MIN_CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS = 5 * 60 * 1000; // 5m

/**
 * Resolve the effective Codex credits-exhausted cooldown (ms) from a raw config
 * value (string | number | undefined). Falls back to the default constant on
 * absent / empty / non-finite / non-positive input, then clamps to
 * [MIN_CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS, MAX_RATE_LIMIT_RESET_MS].
 * Pure + side-effect free so it's unit-testable and cheap to call.
 */
export function resolveCodexCreditsExhaustedCooldownMs(
  raw: string | number | undefined | null,
): number {
  if (raw === undefined || raw === null || raw === "") return CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS;
  const n =
    typeof raw === "number" ? raw : /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS;
  return Math.min(Math.max(n, MIN_CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS), MAX_RATE_LIMIT_RESET_MS);
}

/**
 * Clamps a candidate reset timestamp (ms) to [now+60s, now+7d].
 * Protects against past timestamps (clock skew) and absurdly far future values (malformed).
 */
function clampRateLimitResetMs(candidateMs: number): number {
  const nowMs = Date.now();
  const minMs = nowMs + 60_000;
  const maxMs = nowMs + MAX_RATE_LIMIT_RESET_MS;
  return Math.min(Math.max(candidateMs, minMs), maxMs);
}

export class SessionErrorTracker {
  private errors: ErrorSignal[] = [];
  /** Stashed reset time (ms) from the last rejected rate_limit_event in this session. */
  private rateLimitResetAtMs: number | undefined;
  private rateLimitWindows: RateLimitWindowTelemetry = {};

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

      const telemetry = parseRateLimitWindowTelemetry(json);
      if (telemetry) {
        this.rateLimitWindows[telemetry.rateLimitType] = telemetry.info;
      }

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
   * Process a Codex-style usage-limit error message (from a `{type:"error"}`
   * or `{type:"turn.failed"}` SDK event). Only stashes when the message
   * contains the usage-limit signature AND carries a parseable wall-clock
   * reset time. "Try again later." and workspace-credit branches fall through
   * to the runner's tier-3 fallback instead.
   * Last call wins — multiple events per session are deduped to the latest.
   */
  processCodexUsageLimitMessage(message: string): void {
    if (!message) return;
    if (!/usage limit|hit your usage/i.test(message)) return;

    const iso = parseCodexRateLimitResetTime(message);
    if (!iso) return;

    const candidateMs = new Date(iso).getTime();
    if (!Number.isFinite(candidateMs)) return;
    this.rateLimitResetAtMs = clampRateLimitResetMs(candidateMs);
  }

  /**
   * Returns the stashed rate limit reset time as an ISO string, or undefined
   * if no rejected rate_limit_event was seen in this session.
   */
  getRateLimitResetAt(): string | undefined {
    if (this.rateLimitResetAtMs === undefined) return undefined;
    return new Date(this.rateLimitResetAtMs).toISOString();
  }

  getRateLimitWindows(): RateLimitWindowTelemetry | undefined {
    if (Object.keys(this.rateLimitWindows).length === 0) return undefined;
    return { ...this.rateLimitWindows };
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
    return this.errors.some((e) => {
      const message = e.message.toLowerCase();
      return (
        message.includes("no conversation found with session id") ||
        (message.includes("--resume requires a valid session id") &&
          message.includes("does not match any session title"))
      );
    });
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
 * Parse the reset time embedded in a Codex `UsageLimitReached` error message.
 * Codex emits one of these formats via chrono's `%-I:%M %p` (same day) or
 * `%b %-d{th/st/nd/rd}, %Y %-I:%M %p` (different day):
 *   "Try again at 8:35 PM."
 *   "or try again at 8:35 PM."
 *   "Try again at May 26th, 2026 8:35 PM."
 *   "or try again at May 26th, 2026 8:35 PM."
 * Wall-clock times are UTC because the agent-swarm Docker worker has TZ=Etc/UTC;
 * chrono::Local resolves to UTC in that container.
 */
export function parseCodexRateLimitResetTime(
  message: string,
  now: Date = new Date(),
): string | undefined {
  if (!message) return undefined;

  // Different-day format (more specific — try first):
  // "Month Day{st/nd/rd/th}, Year HH:MM AM/PM"
  const datedMatch = message.match(
    /\btry again at\s+([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)\b/i,
  );
  if (datedMatch) {
    const monthIdx = MONTH_NAMES[datedMatch[1]!.toLowerCase()];
    if (monthIdx !== undefined) {
      const day = Number.parseInt(datedMatch[2]!, 10);
      const year = Number.parseInt(datedMatch[3]!, 10);
      const rawHours = Number.parseInt(datedMatch[4]!, 10);
      const minutes = Number.parseInt(datedMatch[5]!, 10);
      const ampm = datedMatch[6]!.toLowerCase();
      if (rawHours < 1 || rawHours > 12 || minutes < 0 || minutes > 59) return undefined;
      let hours = rawHours;
      if (ampm === "pm" && hours !== 12) hours += 12;
      if (ampm === "am" && hours === 12) hours = 0;
      const d = new Date(Date.UTC(year, monthIdx, day, hours, minutes, 0));
      // Round-trip guard: Date.UTC silently normalises out-of-range days (e.g. May 32 → June 1).
      if (d.getUTCFullYear() !== year || d.getUTCMonth() !== monthIdx || d.getUTCDate() !== day) {
        return undefined;
      }
      return d.toISOString();
    }
  }

  // Same-day format: "HH:MM AM/PM"
  // Anchored on "try again at" so we don't match times elsewhere in the message.
  const timeMatch = message.match(/\btry again at\s+(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)\b/i);
  if (timeMatch) {
    const rawHours = Number.parseInt(timeMatch[1]!, 10);
    const minutes = Number.parseInt(timeMatch[2]!, 10);
    const ampm = timeMatch[3]!.toLowerCase();
    if (rawHours < 1 || rawHours > 12 || minutes < 0 || minutes > 59) return undefined;
    let hours = rawHours;
    if (ampm === "pm" && hours !== 12) hours += 12;
    if (ampm === "am" && hours === 12) hours = 0;
    const candidate = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes, 0),
    );
    // Rollover: if the parsed wall-clock is more than SKEW_MS before "now", assume tomorrow.
    // At-or-just-before-now candidates (clock skew, second truncation) stay same-day and
    // flow to clampRateLimitResetMs which applies the now+60s floor.
    const SKEW_MS = 2 * 60 * 1000;
    if (candidate.getTime() < now.getTime() - SKEW_MS) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
    }
    return candidate.toISOString();
  }

  return undefined;
}

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

  if (isRateLimitMessage(stderr)) {
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
