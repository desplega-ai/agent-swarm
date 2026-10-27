import { compareSemver } from "../../lib/semver";
import { useFeatureGate } from "./use-feature-gate";

/** The first API release with `POST /api/invites` and `/api/invites/exchange`. */
export const INVITES_MIN_VERSION = "2.6.1";

/**
 * The version check `useInvitesSupport` makes through `useFeatureGate`
 * (without the dev-mode bypass). Null (an unknown version) is unsupported.
 */
export function invitesSupportedBy(version: string | null | undefined): boolean {
  return (
    typeof version === "string" &&
    version.length > 0 &&
    compareSemver(version, INVITES_MIN_VERSION) >= 0
  );
}

/**
 * Whether the API can create and exchange invites. False while the version is
 * unknown, so no invite entry point flashes on an older API.
 */
export function useInvitesSupport(): boolean {
  return useFeatureGate(INVITES_MIN_VERSION).supported;
}
