import type { ResolvedSkillRow } from "@desplega/storage";
import { estimateTokens } from "./memory/key-browser";
import { getStorage } from "./storage";

/**
 * Persists a `skill.invoke` event as a `skill_invocations` row and, when the
 * invoked skill resolves to a `skills` row, bumps that row's
 * `invocationCount` / `lastInvokedAt`. Callers run it in the transaction that
 * inserts the event, so the event, the history row and the counter commit
 * together.
 */

export interface SkillInvokeEventInput {
  event: string;
  agentId?: string;
  taskId?: string;
  sessionId?: string;
  data?: Record<string, unknown>;
}

function stringField(data: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = data?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** `chars` is the content length, so the content itself never leaves the database. */
type ResolvedSkill = ResolvedSkillRow;

/**
 * The skills row an invocation refers to. An id wins. A name follows
 * `skill-get`'s precedence: the invoking agent's own skill, then swarm, then
 * global. Anything else (another agent's personal skill, a harness-native
 * skill the swarm does not manage) stays unresolved.
 */
async function resolveSkill(input: {
  skillId?: string;
  skillName?: string;
  agentId?: string;
}): Promise<ResolvedSkill | null> {
  const skills = getStorage().repos.skills;
  if (input.skillId) {
    const byId = await skills.findResolvedSkillById(input.skillId);
    if (byId) return byId;
  }
  if (!input.skillName) return null;
  return skills.findResolvedSkillByName(input.skillName, input.agentId ?? null);
}

/**
 * No-op for any event other than `skill.invoke`. Returns whether the skills
 * counter moved. The insert is `OR IGNORE` against the (sessionId, skillName)
 * unique index, and the counter moves only when the insert landed, so a repeat
 * of the same skill in the same session never counts twice.
 */
export async function recordSkillInvocation(
  // The repository calls below join the caller's transaction (or run alone
  // outside one).
  input: SkillInvokeEventInput,
  eventId: string,
): Promise<boolean> {
  if (input.event !== "skill.invoke") return false;

  const reportedName = stringField(input.data, "skillName");
  const skill = await resolveSkill({
    skillId: stringField(input.data, "skillId"),
    skillName: reportedName,
    agentId: input.agentId,
  });
  const now = new Date().toISOString();

  const skills = getStorage().repos.skills;
  const inserted = await skills.insertSkillInvocation({
    id: crypto.randomUUID(),
    skillId: skill?.id ?? null,
    skillName: skill?.name ?? reportedName ?? null,
    skillVersion: skill?.version ?? null,
    tokenCount: skill ? estimateTokens(skill.chars) : null,
    agentId: input.agentId ?? null,
    taskId: input.taskId ?? null,
    sessionId: input.sessionId ?? null,
    harness: stringField(input.data, "harness") ?? null,
    via: stringField(input.data, "via") ?? null,
    eventId,
    createdAt: now,
  });
  if (!inserted || !skill) return false;

  await skills.bumpInvocationCount(skill.id, now);
  return true;
}
