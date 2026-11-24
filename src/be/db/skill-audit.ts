import { getStorage } from "../storage";

/**
 * Record who last changed a skill when the write went through a path that does
 * not call `updateSkill` (bundled file upsert / delete): the person and the
 * agent of the same write.
 */
export async function setSkillUpdatedBy(
  skillId: string,
  actor: { agentId: string | null; userId: string | null },
): Promise<void> {
  await getStorage().repos.skills.setUpdatedBy(skillId, actor.userId, actor.agentId);
}
