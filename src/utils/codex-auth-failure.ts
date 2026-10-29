/**
 * Codex pool auth-failure benching: shared by the runner (classifies and
 * reports failures) and the API (counts them and benches the login).
 *
 * Worker-side code imports this file, so it must never import `src/be/db`
 * or `bun:sqlite`.
 */

/** Consecutive auth failures that bench a Codex pool login. */
export const CODEX_AUTH_FAILURE_BENCH_THRESHOLD = 2;
/** Bench length. Matches the codex-auth-expiry-watch bench (benchDays = 365). */
export const CODEX_AUTH_FAILURE_BENCH_MS = 365 * 24 * 60 * 60 * 1000;
/** KV namespace and key shared with codex-auth-expiry-watch and keep-warm. */
export const CODEX_AUTH_WATCH_NAMESPACE = "codex-auth-watch";
export const codexAuthBenchMarkerKey = (keySuffix: string) => `bench:${keySuffix}`;

/** Transient `[auth-error]` texts that must not count. */
const TRANSIENT_AUTH_ERROR_MARKERS = [
  "waiting for the refresh lock",
  "refresh rejected (429",
  "refresh rejected (5",
  "refresh rejected (unknown status",
  "out of credits",
  "no credentials found in config store",
  // Revalidation threw something other than a refresh rejection (lock HTTP,
  // network, or persistence failure). See buildPoolRevalidationFailureReason.
  "not a confirmed auth rejection",
];

export function isCodexAuthFailureReason(failureReason: string | undefined | null): boolean {
  if (!failureReason || !failureReason.includes("[auth-error]")) return false;
  const lower = failureReason.toLowerCase();
  return !TRANSIENT_AUTH_ERROR_MARKERS.some((m) => lower.includes(m));
}

/**
 * Turn-level texts of a rejected ChatGPT/Codex credential: a bad API key, or
 * a pool login revoked while its access token is unexpired. That death mode
 * never enters `getValidCodexOAuth` (the token looks fresh), so this error is
 * its only artifact. The adapters tag a match `[auth-error]`.
 */
const REJECTED_ACCESS_PATTERNS = [
  "unauthorized",
  "http 401",
  " 401 ",
  "invalid api key",
  "invalid_api_key",
  "missing api key",
  "no api key",
  "authentication failed",
  "failed to refresh token",
  "invalid 'refresh_token'",
  // ChatGPT backend 401 bodies (pi on the subscription surfaces them as-is).
  "token_invalidated",
  "authentication token has been invalidated",
  "authentication token is expired",
  "refresh token was revoked",
  "could not parse your authentication token",
];

export function isCodexRejectedAccessError(text: string): boolean {
  const lower = text.toLowerCase();
  return REJECTED_ACCESS_PATTERNS.some((p) => lower.includes(p));
}
