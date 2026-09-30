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
