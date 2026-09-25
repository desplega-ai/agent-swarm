import {
  CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS,
  isCodexCreditsExhaustedMessage,
  isRateLimitMessage,
  MAX_RATE_LIMIT_RESET_MS,
  parseRateLimitResetTime,
  type RateLimitWindowTelemetry,
} from "../utils/error-tracker";
import {
  type ModelFamily,
  parseModelLimitMessage,
  windowForModelFamily,
} from "../utils/model-rate-limit-windows";

export type RateLimitOutcome =
  | { kind: "none" }
  | { kind: "key"; rateLimitedUntil: string }
  | {
      kind: "model";
      model: ModelFamily;
      window: string;
      resetsAtSec: number;
      source: "event" | "text";
      /**
       * When a structured rejection event was observed (event source only).
       * A text-only rejection has no observation time of its own.
       */
      observedAt?: string;
      /**
       * An independent key-wide rejection from the same session (structured
       * event only), still to enforce. Windows are independent: a model
       * rejection is never evidence that the key-wide window recovered.
       */
      keyRateLimitedUntil?: string;
    };

interface ClassifiableResult {
  rateLimitResetAt?: string;
  rateLimitWindows?: RateLimitWindowTelemetry;
  modelRateLimit?: { window: string; model: ModelFamily; resetAt: string; observedAt?: string };
}

function clampMs(candidateMs: number, nowMs: number): number {
  const minMs = nowMs + 60_000;
  const maxMs = nowMs + MAX_RATE_LIMIT_RESET_MS;
  return Math.min(Math.max(candidateMs, minMs), maxMs);
}

/**
 * Classifies a finished provider session's rate-limit signal into one of
 * three outcomes: no rate limit, a key-wide rate limit (legacy path), or a
 * model-scoped weekly-window rejection (Fable/Opus/Sonnet). Model outcomes
 * are tested before key outcomes so a model-scoped event or message never
 * falls into the legacy key-wide gate and marks the whole key.
 *
 * `codexCreditsExhaustedCooldownMs` defaults to the fixed constant so the
 * function stays pure and testable with 3 args; the runner call site passes
 * the live, config-driven cooldown to preserve today's behavior exactly.
 */
export function classifyRateLimitOutcome(
  result: ClassifiableResult,
  failureReason: string | undefined,
  nowMs: number,
  codexCreditsExhaustedCooldownMs: number = CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS,
): RateLimitOutcome {
  const keyRateLimitedUntil = result.rateLimitResetAt
    ? new Date(clampMs(new Date(result.rateLimitResetAt).getTime(), nowMs)).toISOString()
    : undefined;
  const keyExtra = keyRateLimitedUntil ? { keyRateLimitedUntil } : {};

  if (result.modelRateLimit) {
    const resetsAtSec = Math.floor(new Date(result.modelRateLimit.resetAt).getTime() / 1000);
    const { observedAt } = result.modelRateLimit;
    return {
      kind: "model",
      model: result.modelRateLimit.model,
      window: result.modelRateLimit.window,
      resetsAtSec,
      source: "event",
      ...(observedAt ? { observedAt } : {}),
      ...keyExtra,
    };
  }

  if (failureReason != null) {
    const family = parseModelLimitMessage(failureReason);
    const window = family ? windowForModelFamily(family) : undefined;
    if (family && window) {
      const sevenDay = result.rateLimitWindows?.seven_day;
      const sevenDayResetsAtSec =
        sevenDay && typeof sevenDay.resetsAt === "number" && sevenDay.resetsAt * 1000 > nowMs
          ? sevenDay.resetsAt
          : undefined;
      const fallbackResetsAtSec = Math.floor((nowMs + 24 * 60 * 60 * 1000) / 1000);
      const maxResetsAtSec = Math.floor((nowMs + MAX_RATE_LIMIT_RESET_MS) / 1000);
      const resetsAtSec = Math.min(sevenDayResetsAtSec ?? fallbackResetsAtSec, maxResetsAtSec);
      return { kind: "model", model: family, window, resetsAtSec, source: "text", ...keyExtra };
    }
  }

  if (
    result.rateLimitResetAt != null ||
    (failureReason != null && isRateLimitMessage(failureReason))
  ) {
    let rateLimitedUntil: string;
    if (keyRateLimitedUntil) {
      rateLimitedUntil = keyRateLimitedUntil;
    } else if (failureReason != null) {
      const parsedResetTime = parseRateLimitResetTime(failureReason);
      if (parsedResetTime) {
        rateLimitedUntil = new Date(
          clampMs(new Date(parsedResetTime).getTime(), nowMs),
        ).toISOString();
      } else if (isCodexCreditsExhaustedMessage(failureReason)) {
        rateLimitedUntil = new Date(nowMs + codexCreditsExhaustedCooldownMs).toISOString();
      } else {
        rateLimitedUntil = new Date(nowMs + 5 * 60 * 1000).toISOString();
      }
    } else {
      rateLimitedUntil = new Date(nowMs + 5 * 60 * 1000).toISOString();
    }
    return { kind: "key", rateLimitedUntil };
  }

  return { kind: "none" };
}

/**
 * Builds the one telemetry payload a finished session reports for its key:
 * the session's window snapshots with the classified model rejection merged
 * over its own window. A single payload keeps an older `allowed` snapshot
 * from the same session (e.g. before a text-only "reached your Fable limit"
 * failure) from overwriting the terminal rejection in a second report.
 *
 * `lastSeenAt` is the DB freshness key. A structured rejection keeps the time
 * it was observed, so it never overwrites a later recovery that another worker
 * reported in the meantime. Only a text-only rejection, which has no event of
 * its own, is stamped with `nowIso`.
 */
export function buildFinalRateLimitWindows(
  sessionWindows: RateLimitWindowTelemetry | undefined,
  outcome: RateLimitOutcome,
  nowIso: string,
): RateLimitWindowTelemetry | undefined {
  if (outcome.kind !== "model") return sessionWindows;
  // Keep the session's own fields (utilization, overage) only when that
  // snapshot is itself the rejection; an older `allowed` read is stale.
  const sessionEntry = sessionWindows?.[outcome.window];
  const sessionRejectedAt =
    sessionEntry?.status === "rejected" ? sessionEntry.lastSeenAt : undefined;
  const lastSeenAt =
    outcome.source === "event" ? (outcome.observedAt ?? sessionRejectedAt ?? nowIso) : nowIso;
  return {
    ...sessionWindows,
    [outcome.window]: {
      ...(sessionEntry?.status === "rejected" ? sessionEntry : {}),
      status: "rejected",
      resetsAt: outcome.resetsAtSec,
      lastSeenAt,
    },
  };
}
