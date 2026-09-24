/** What onboarding calls a swarm that has no `SWARM_ORG_NAME` yet (plan decision). */
export const DEFAULT_SWARM_NAME = "Your Swarm";

// `/status` reports this when `SWARM_ORG_NAME` is unset (`src/http/status.ts`).
const SERVER_FALLBACK_NAME = "Swarm";

/** The `/status` identity name, or "Your Swarm" when the server has none. */
export function swarmDisplayName(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed && trimmed !== SERVER_FALLBACK_NAME ? trimmed : DEFAULT_SWARM_NAME;
}
