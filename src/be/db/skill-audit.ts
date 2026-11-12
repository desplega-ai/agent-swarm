import { getDbClient } from "./runtime";

/**
 * Record who last changed a skill when the write went through a path that does
 * not call `updateSkill` (bundled file upsert / delete): the person and the
 * agent of the same write.
 */
export async function setSkillUpdatedBy(
  skillId: string,
  actor: { agentId: string | null; userId: string | null },
): Promise<void> {
  await getDbClient().run("UPDATE skills SET updated_by = ?, updatedByAgentId = ? WHERE id = ?", [
    actor.userId,
    actor.agentId,
    skillId,
  ]);
}
