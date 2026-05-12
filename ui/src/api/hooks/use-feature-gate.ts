/**
 * Feature-gate hook for soft-degrading new UI surfaces against older API
 * servers.
 *
 * Returns `{ supported, currentVersion, requiredVersion }`. While the version
 * query is still pending (or it errored), `supported` is `false` so the UI
 * doesn't flash the new surface against an unknown backend — render-blocking
 * by default, opt-in to the new surface only once we've confirmed the version.
 */

import { compareSemver } from "@/lib/semver";
import { useApiVersion } from "./use-stats";

export interface FeatureGateResult {
  supported: boolean;
  currentVersion: string | null;
  requiredVersion: string;
}

export function useFeatureGate(minVersion: string): FeatureGateResult {
  const { data: currentVersion } = useApiVersion();

  const supported =
    typeof currentVersion === "string" &&
    currentVersion.length > 0 &&
    compareSemver(currentVersion, minVersion) >= 0;

  return {
    supported,
    currentVersion: currentVersion ?? null,
    requiredVersion: minVersion,
  };
}
