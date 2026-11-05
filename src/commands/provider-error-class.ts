/**
 * Which provider errors move a task to its next fallback profile
 * (runbooks/model-tiers.md § Fallbacks on provider errors).
 *
 * Pure and worker-side: the runner classifies a finished session, and the API
 * picks the next profile. A hit means another profile on the same agent may
 * run the work where this one cannot right now. Task failures, tool errors,
 * harness-side exceptions (`errorOrigin: "harness"`), context overflow,
 * cancellation and budget refusals never hit.
 */
import type { ProviderResult } from "../providers/types";
import type { ProviderErrorClass } from "../types";
import { isCodexAuthFailureReason } from "../utils/codex-auth-failure";
import { isCodexCreditsExhaustedMessage } from "../utils/error-tracker";
import { modelFamilyOf } from "../utils/model-rate-limit-windows";
import { classifyRateLimitOutcome, type RateLimitOutcome } from "./rate-limit-outcome";

type ClassifiableProviderResult = Parameters<typeof classifyRateLimitOutcome>[0] & {
  exitCode: number;
  errorCategory?: string;
  errorOrigin?: ProviderResult["errorOrigin"];
};

/** Endings that are the task's own, whatever the text around them says. */
const NEVER_FALLBACK =
  /max turns exceeded|budget limit exceeded|error_max_budget|context (window|length|limit)|prompt is too long|maximum context length|context_length_exceeded/i;

/** Claude stream `authentication_failed`, plus the usual 401 texts of every harness. */
const AUTH_FAILURE =
  /authentication[ _](?:failed|error)|invalid[ _]api[ _]key|\bhttp 401\b|\b401 unauthori[sz]ed/i;

/** Anthropic 529 and every "overloaded" text. */
const OVERLOADED = /overloaded|\b529\b/i;

/** Any 5xx status (500-599) or a 5xx reason phrase. */
const SERVER_ERROR =
  /\b(?:status|http|error|code)[ :]*5\d\d\b|internal server error|bad gateway|service unavailable|gateway time-?out|insufficient storage|server_error/i;

/**
 * The fallback class of a finished session, or null when it is not a provider
 * error. `rateLimitOutcome` is the runner's `classifyRateLimitOutcome` result
 * for the same session.
 */
export function classifyProviderError(
  result: ClassifiableProviderResult,
  failureReason: string | undefined,
  rateLimitOutcome: RateLimitOutcome,
): { errorClass: ProviderErrorClass } | null {
  if (result.exitCode === 0) return null;
  if (result.errorCategory === "cancelled") return null;
  // A harness-side exception (MCP, transport): its text may quote a tool's
  // HTTP status or rate limit, which says nothing about the provider.
  if (result.errorOrigin === "harness") return null;
  const text = failureReason ?? "";
  if (NEVER_FALLBACK.test(text)) return null;

  switch (rateLimitOutcome.kind) {
    case "seat":
      return { errorClass: "seat" };
    case "model":
      return { errorClass: "model_window" };
    case "key":
      return {
        errorClass: isCodexCreditsExhaustedMessage(text) ? "credits" : "rate_limit",
      };
    case "none":
      break;
  }
  if (!text) return null;
  if (isCodexAuthFailureReason(text) || AUTH_FAILURE.test(text)) return { errorClass: "auth" };
  if (OVERLOADED.test(text)) return { errorClass: "overloaded" };
  if (SERVER_ERROR.test(text)) return { errorClass: "server_error" };
  return null;
}

/**
 * `classifyProviderError` with the runner's own rate-limit classification of
 * the session (the same one its credential report uses). Returns the class
 * alone, or null.
 */
export function classifyProviderErrorOf(
  result: ClassifiableProviderResult,
  failureReason: string | undefined,
  model: string | undefined,
  codexCreditsExhaustedCooldownMs?: number,
  nowMs = Date.now(),
): ProviderErrorClass | null {
  if (result.exitCode === 0) return null;
  const outcome = classifyRateLimitOutcome(
    result,
    failureReason,
    nowMs,
    codexCreditsExhaustedCooldownMs,
    modelFamilyOf(model),
  );
  return classifyProviderError(result, failureReason, outcome)?.errorClass ?? null;
}
