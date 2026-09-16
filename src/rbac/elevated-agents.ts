/**
 * Agents that act with lead privileges without carrying the `isLead` flag.
 *
 * Extension system agents (`ext:<name>`) run operator-enabled code inside the
 * API process. Their `ctx.swarm` calls must pass lead-only checks such as
 * posting to Slack, but the agent row keeps `isLead: false` so lead selection
 * (Slack routing, follow-ups, heartbeat triage) never picks them.
 *
 * The registry is process-local and mirrors the loaded-extension set: the
 * extension dispatcher grants on load and revokes on dispose.
 */
const leadEquivalentAgentIds = new Set<string>();

export function grantLeadEquivalence(agentId: string): void {
  leadEquivalentAgentIds.add(agentId);
}

export function revokeLeadEquivalence(agentId: string): void {
  leadEquivalentAgentIds.delete(agentId);
}

export function hasLeadEquivalence(agentId: string | null | undefined): boolean {
  return !!agentId && leadEquivalentAgentIds.has(agentId);
}
