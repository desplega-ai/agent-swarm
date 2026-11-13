import {
  CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS,
  isCodexCreditsExhaustedMessage,
  isRateLimitMessage,
  MAX_RATE_LIMIT_RESET_MS,
  MAX_SPEND_CAP_HOLD_MS,
  parseRateLimitResetTime,
  type RateLimitWindowTelemetry,
  type SpendCap,
} from "../utils/error-tracker";
import {
  type ModelFamily,
  parseCreditsRequiredMessage,
  parseModelLimitMessage,
  windowForModelFamily,
} from "../utils/model-rate-limit-windows";
import type {
  ProviderAccountTelemetry,
  RateLimitReplacement,
} from "../utils/provider-account-telemetry";

export type RateLimitOutcome =
  | { kind: "none" }
  | { kind: "key"; rateLimitedUntil: string; spendCap?: SpendCap }
  /**
   * The key's seat cannot run the model (`credits_required`). Not a rate
   * limit: the seat rejection never marks the key by itself.
   */
  | {
      kind: "seat";
      model: ModelFamily;
      source: "event" | "text";
      /**
       * An independent key-wide rejection observed earlier in the same
       * session, still to enforce. The seat outcome never erases it.
       */
      keyRateLimitedUntil?: string;
    }
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
  providerAccount?: ProviderAccountTelemetry;
  rateLimitReplacements?: RateLimitReplacement[];
  rateLimitResetAt?: string;
  rateLimitWindows?: RateLimitWindowTelemetry;
  modelRateLimit?: { window: string; model: ModelFamily; resetAt: string; observedAt?: string };
  creditsRequired?: { observedAt: string; overageDisabledReason?: string };
}

function clampMs(candidateMs: number, nowMs: number, maxResetMs = MAX_RATE_LIMIT_RESET_MS): number {
  const minMs = nowMs + 60_000;
  const maxMs = nowMs + maxResetMs;
  return Math.min(Math.max(candidateMs, minMs), maxMs);
}

/** OpenRouter's key spend limit (403 `openrouter_key_limit`) and its out-of-credits 402. */
const SPEND_CAP_TEXT =
  /key limit exceeded|"limit_source"\s*:\s*"openrouter_key_limit"|insufficient credits|requires more credits/i;

function numberOf(text: string, pattern: RegExp): number | null {
  const value = Number(text.match(pattern)?.[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * The spend cap a failure text reports, or null when it is not a spend cap.
 * Reads the JSON metadata first (`limit_usd`, `spend_usd`, `resets_at`), then
 * the message ("$1.07 of $1.00 used; resets <ISO>").
 */
export function parseSpendCapMessage(text: string): SpendCap | null {
  if (!SPEND_CAP_TEXT.test(text)) return null;
  const resetText =
    text.match(/"resets_at"\s*:\s*"([^"]+)"/)?.[1] ??
    text.match(/resets (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)?.[1];
  const resetMs = resetText ? Date.parse(resetText) : Number.NaN;
  return {
    limitUsd: numberOf(text, /"limit_usd"\s*:\s*([\d.]+)/) ?? numberOf(text, /of \$([\d.]+) used/),
    spendUsd:
      numberOf(text, /"spend_usd"\s*:\s*([\d.]+)/) ?? numberOf(text, /\$([\d.]+) of \$[\d.]+ used/),
    resetsAt: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null,
  };
}

/**
 * Classifies a finished provider session's rate-limit signal into one of
 * four outcomes: no rate limit, a key-wide rate limit (legacy path), a
 * model-scoped weekly-window rejection (Fable/Opus/Sonnet), or a seat
 * mismatch (`credits_required`: the seat cannot run the model). Seat
 * outcomes are tested first and model outcomes before key outcomes, so
 * neither falls into the legacy key-wide gate and marks the whole key.
 *
 * `taskModelFamily` is the family of the task's model. A structured
 * `credits_required` event names no model, so without it (and without the
 * failure text) the event cannot be attributed and is not a seat outcome.
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
  taskModelFamily?: ModelFamily,
): RateLimitOutcome {
  const keyRateLimitedUntil = result.rateLimitResetAt
    ? new Date(clampMs(new Date(result.rateLimitResetAt).getTime(), nowMs)).toISOString()
    : undefined;
  const keyExtra = keyRateLimitedUntil ? { keyRateLimitedUntil } : {};

  if (failureReason != null) {
    const seatFamily = parseCreditsRequiredMessage(failureReason);
    if (seatFamily) return { kind: "seat", model: seatFamily, source: "text", ...keyExtra };
  }
  if (result.creditsRequired && taskModelFamily) {
    return { kind: "seat", model: taskModelFamily, source: "event", ...keyExtra };
  }

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

  // Before the rate-limit text check: OpenRouter's cap body says "usage limit",
  // which would read as a short rate limit and re-hand the key every 5 minutes.
  const spendCap = failureReason != null ? parseSpendCapMessage(failureReason) : null;
  if (spendCap) {
    // shortcut: a cap with no reset holds for MAX_SPEND_CAP_HOLD_MS, not forever; editing the key re-creates its status row.
    const untilMs = spendCap.resetsAt
      ? Date.parse(spendCap.resetsAt)
      : nowMs + MAX_SPEND_CAP_HOLD_MS;
    return {
      kind: "key",
      rateLimitedUntil: new Date(clampMs(untilMs, nowMs, MAX_SPEND_CAP_HOLD_MS)).toISOString(),
      spendCap,
    };
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
