import { useFeatureGate } from "./use-feature-gate";

/** The first API release with `/api/config/pool-keys` and `/api/codex-oauth/accounts`. */
export const POOL_KEYS_MIN_VERSION = "2.5.5";

/**
 * Which credential UI the API can serve. `legacy`: an older API, so the
 * dashboard keeps the comma-separated pool field and the old Codex section.
 * `pending`: the API version is not known yet, so show neither.
 */
export function usePoolKeysSupport(): "supported" | "legacy" | "pending" {
  const gate = useFeatureGate(POOL_KEYS_MIN_VERSION);
  if (gate.supported) return "supported";
  return gate.currentVersion === null && !gate.isError ? "pending" : "legacy";
}
