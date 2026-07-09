/**
 * Feature-gate hook for soft-degrading new UI surfaces against older API
 * servers.
 *
 * Returns `{ supported, currentVersion, requiredVersion, isError, error }`.
 * While the version query is still pending (or it errored), `supported` is
 * `false` so the UI doesn't flash the new surface against an unknown backend
 * — render-blocking by default, opt-in to the new surface only once we've
 * confirmed the version.
 *
 * `isError`/`error` let callers distinguish "still resolving" (render a
 * skeleton) from "confirmed unreachable" (render a real error instead of a
 * skeleton that spins forever) — see `useApiVersion`'s underlying `/health`
 * query for what can fail here (dead apiUrl, bad key, CORS, network).
 */

import { compareSemver } from "@/lib/semver";
import { useApiVersion } from "./use-stats";

export interface FeatureGateResult {
  supported: boolean;
  currentVersion: string | null;
  requiredVersion: string;
  isError: boolean;
  error: Error | null;
}

export function useFeatureGate(minVersion: string): FeatureGateResult {
  const { data: currentVersion, isError, error } = useApiVersion();

  const supported =
    typeof currentVersion === "string" &&
    currentVersion.length > 0 &&
    compareSemver(currentVersion, minVersion) >= 0;

  return {
    supported,
    currentVersion: currentVersion ?? null,
    requiredVersion: minVersion,
    isError,
    error: error instanceof Error ? error : error ? new Error(String(error)) : null,
  };
}
