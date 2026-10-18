import { OLD_DEFAULT_ORG_NAME, storedOrgName } from "@/lib/company-profile";

/**
 * What the setup top bar shows for a swarm with no `SWARM_ORG_NAME` yet
 * (display only). Older setups stored it, so a stored one counts as unset.
 */
export const DEFAULT_SWARM_NAME = OLD_DEFAULT_ORG_NAME;

// `/status` reports this when `SWARM_ORG_NAME` is unset (`src/http/status.ts`).
const SERVER_FALLBACK_NAME = "Swarm";

/** The `/status` identity name, or "Your Swarm" when the server has none. */
export function swarmDisplayName(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed && trimmed !== SERVER_FALLBACK_NAME ? trimmed : DEFAULT_SWARM_NAME;
}

/**
 * Step 2's starting value: the stored `SWARM_ORG_NAME` row when one exists
 * (even "Swarm"), else the `/status` name unless it is the server default,
 * else `suggestion` (from a company domain), else empty. Never "Your Swarm",
 * also not a stored one: the name is required.
 */
export function initialSwarmName(
  storedName: string | undefined,
  statusName: string | null | undefined,
  suggestion: string | null,
): string {
  const stored = storedOrgName(storedName);
  if (stored) return stored;
  const fromStatus = storedOrgName(statusName);
  if (fromStatus && fromStatus !== SERVER_FALLBACK_NAME) return fromStatus;
  return suggestion ?? "";
}
