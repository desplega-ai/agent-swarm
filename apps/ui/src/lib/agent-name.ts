/**
 * An agent's display name: its name from the agents list, a short id while
 * the list loads, or `pool` for work no agent has taken yet.
 */
export function agentName(
  agents: readonly { id: string; name: string }[] | undefined,
  agentId: string | null | undefined,
  pool = "A worker",
): string {
  if (!agentId) return pool;
  return agents?.find((agent) => agent.id === agentId)?.name ?? `${agentId.slice(0, 8)}…`;
}
