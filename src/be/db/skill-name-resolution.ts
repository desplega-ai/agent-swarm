import { getDbClient } from "./runtime";

export type SwarmSkillNameResolution =
  | { kind: "found"; skillId: string }
  | { kind: "ambiguous"; skillIds: string[] }
  | { kind: "none" };

/**
 * Resolve a swarm-scope skill name for `skill-get`.
 *
 * Migration 019 makes a name unique only per scope + owner, so a swarm name can
 * match one ownerless row plus any number of agent-owned rows. Precedence:
 * the ownerless row, then the caller's own row, then a single owned row.
 * Several foreign-owned rows are ambiguous; the caller must pass a skillId.
 *
 * `getSkillByName(name, "swarm")` stays ownerless-only: the seeder relies on it.
 */
export async function resolveSwarmSkillByName(
  name: string,
  callerAgentId?: string,
): Promise<SwarmSkillNameResolution> {
  const rows = await getDbClient().query<{ id: string; ownerAgentId: string | null }>(
    "SELECT id, ownerAgentId FROM skills WHERE name = ? AND scope = 'swarm' ORDER BY createdAt, id",
    [name],
  );

  const ownerless = rows.find((row) => !row.ownerAgentId);
  if (ownerless) return { kind: "found", skillId: ownerless.id };

  const own = callerAgentId ? rows.find((row) => row.ownerAgentId === callerAgentId) : undefined;
  if (own) return { kind: "found", skillId: own.id };

  if (rows.length === 1) return { kind: "found", skillId: rows[0]!.id };
  if (rows.length > 1) return { kind: "ambiguous", skillIds: rows.map((row) => row.id) };
  return { kind: "none" };
}
