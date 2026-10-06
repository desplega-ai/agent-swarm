import type { DbExecutor } from "./db-client";

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

/**
 * The skills row an invocation refers to. An id wins. A name follows
 * `skill-get`'s precedence: the invoking agent's own skill, then swarm, then
 * global. Anything else (another agent's personal skill, a harness-native
 * skill the swarm does not manage) stays unresolved.
 */
async function resolveSkill(
  db: DbExecutor,
  input: { skillId?: string; skillName?: string; agentId?: string },
): Promise<{ id: string; name: string } | null> {
  if (input.skillId) {
    const byId = await db.get<{ id: string; name: string }>(
      "SELECT id, name FROM skills WHERE id = ?",
      [input.skillId],
    );
    if (byId) return byId;
  }
  if (!input.skillName) return null;
  return db.get<{ id: string; name: string }>(
    `SELECT id, name FROM skills
      WHERE name = ?
        AND ((scope = 'agent' AND ownerAgentId = ?) OR scope IN ('swarm', 'global'))
      ORDER BY CASE scope WHEN 'agent' THEN 0 WHEN 'swarm' THEN 1 ELSE 2 END
      LIMIT 1`,
    [input.skillName, input.agentId ?? null],
  );
}

/**
 * No-op for any event other than `skill.invoke`. Returns whether the skills
 * counter moved. The insert is `OR IGNORE` against the (sessionId, skillName)
 * unique index, and the counter moves only when the insert landed, so a repeat
 * of the same skill in the same session never counts twice.
 */
export async function recordSkillInvocation(
  db: DbExecutor,
  input: SkillInvokeEventInput,
  eventId: string,
): Promise<boolean> {
  if (input.event !== "skill.invoke") return false;

  const reportedName = stringField(input.data, "skillName");
  const skill = await resolveSkill(db, {
    skillId: stringField(input.data, "skillId"),
    skillName: reportedName,
    agentId: input.agentId,
  });
  const now = new Date().toISOString();

  const inserted = await db.run(
    `INSERT OR IGNORE INTO skill_invocations
       (id, skillId, skillName, agentId, taskId, sessionId, harness, via, eventId, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      skill?.id ?? null,
      skill?.name ?? reportedName ?? null,
      input.agentId ?? null,
      input.taskId ?? null,
      input.sessionId ?? null,
      stringField(input.data, "harness") ?? null,
      stringField(input.data, "via") ?? null,
      eventId,
      now,
    ],
  );
  if (inserted.changes === 0 || !skill) return false;

  await db.run(
    "UPDATE skills SET invocationCount = invocationCount + 1, lastInvokedAt = ? WHERE id = ?",
    [now, skill.id],
  );
  return true;
}
