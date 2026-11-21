import type { SqlExecutor } from "../executor";
import { type SqlQuery, sql } from "../sql";

/**
 * Domain: skills (`skills`, `skill_invocations`, the `skills_fts` /
 * `skills_meta_fts` full-text indexes, and the read-only usage analytics over
 * `skill_invocations`). Rows come back in the SQLite value shape on every
 * engine (flags 0/1, timestamps as the text the column stores).
 */

/** The skills row an invocation resolves to; `chars` is the content length. */
export type ResolvedSkillRow = { id: string; name: string; version: number; chars: number };

export type NewSkillInvocation = {
  id: string;
  skillId: string | null;
  skillName: string | null;
  skillVersion: number | null;
  tokenCount: number | null;
  agentId: string | null;
  taskId: string | null;
  sessionId: string | null;
  harness: string | null;
  via: string | null;
  eventId: string;
  createdAt: string;
};

export type SkillUsageTotalsRow = {
  invocations: number;
  distinctSkills: number;
  distinctAgents: number;
  distinctTasks: number;
  unresolved: number | null;
  tokens: number | null;
};

export type SkillUsageDayRow = { date: string; invocations: number; skills: number; tasks: number };
export type SkillUsageKeyCountRow = { key: string; invocations: number };
export type SkillUsageSkillRow = {
  skillId: string | null;
  skillName: string;
  invocations: number;
  agents: number;
  tokens: number;
  lastInvokedAt: string;
};
export type SkillUsageAgentStatsRow = {
  agentId: string;
  agentName: string;
  isLead: number;
  installed: number;
  installedUsed: number;
  skillsUsed: number;
  invocations: number;
  lastInvokedAt: string | null;
};
export type SkillUsageUnusedSkillRow = {
  id: string;
  name: string;
  scope: string;
  type: string;
  systemDefault: number;
  installedEverywhere: number;
  installedAgents: number;
  invocationCount: number;
  lastInvokedAt: string | null;
};
export type SkillDetailTotalsRow = {
  invocations: number;
  distinctAgents: number;
  distinctTasks: number;
  tokens: number | null;
};
export type SkillDetailAgentRow = {
  agentId: string;
  agentName: string | null;
  invocations: number;
  lastInvokedAt: string;
};
export type SkillDetailRecentRow = {
  id: string;
  agentId: string | null;
  agentName: string | null;
  taskId: string | null;
  taskTitle: string | null;
  harness: string | null;
  via: string | null;
  skillVersion: number | null;
  tokenCount: number | null;
  createdAt: string;
};

export interface SkillsRepository {
  // ---- skills ----
  findResolvedSkillById(id: string): Promise<ResolvedSkillRow | null>;
  /** By name: the agent's own skill, then swarm, then global. */
  findResolvedSkillByName(name: string, agentId: string | null): Promise<ResolvedSkillRow | null>;
  /** Bumps the invocation counter and sets `lastInvokedAt`. */
  bumpInvocationCount(skillId: string, at: string): Promise<void>;
  setUpdatedBy(skillId: string, userId: string | null, agentId: string | null): Promise<void>;
  /** Swarm-scope rows with the name, ordered by createdAt, then id. */
  listSwarmSkillsByName(name: string): Promise<{ id: string; ownerAgentId: string | null }[]>;
  /** The id of the ownerless (scope, name) row. */
  findOwnerlessSkillId(name: string, scope: string): Promise<string | null>;
  /**
   * Enabled skills ranked by full-text score (exact name first, then score,
   * then name). `match` is the engine's match expression; `columns` a trusted
   * select list over `skills` written by code.
   */
  searchRankedSkills<T>(
    match: string,
    exactName: string,
    limit: number,
    columns: string,
  ): Promise<T[]>;

  // ---- skill_invocations ----
  /**
   * Inserts the invocation; a row that breaks a constraint (the
   * (sessionId, skillName) unique index) is skipped. Returns whether it landed.
   */
  insertSkillInvocation(invocation: NewSkillInvocation): Promise<boolean>;

  // ---- usage analytics; `since` null = all history ----
  usageTotals(since: string | null): Promise<SkillUsageTotalsRow | null>;
  firstInvocationAt(): Promise<string | null>;
  /** Local days (shifted by `tzOffsetMinutes`, clamped to ±14 h), ordered by date. */
  usageDaily(since: string | null, tzOffsetMinutes: number): Promise<SkillUsageDayRow[]>;
  /** Ordered by count descending, then key. */
  usageByHarness(since: string | null): Promise<SkillUsageKeyCountRow[]>;
  /** Ordered by invocations descending, then skill name; ties in engine order. */
  usageBySkill(since: string | null): Promise<SkillUsageSkillRow[]>;
  /** Started tasks created since `since`, and those of them that invoked a skill. */
  taskAdoption(since: string): Promise<{ tasks: number; tasksWithSkill: number | null } | null>;
  /** Ordered by invocations descending, then agent name; ties in engine order. */
  usageByAgent(since: string | null): Promise<SkillUsageAgentStatsRow[]>;
  /** Installed skills with no invocation in the window, ordered by name; ties in engine order. */
  unusedSkills(since: string | null): Promise<SkillUsageUnusedSkillRow[]>;
  detailTotals(skillId: string, since: string | null): Promise<SkillDetailTotalsRow | null>;
  /** Same buckets and order as `usageDaily`. */
  detailDaily(
    skillId: string,
    since: string | null,
    tzOffsetMinutes: number,
  ): Promise<SkillUsageDayRow[]>;
  /** Ordered by invocations descending, then agent name; ties in engine order. */
  detailByAgent(skillId: string, since: string | null): Promise<SkillDetailAgentRow[]>;
  /** Ordered by count descending, then key. */
  detailCountBy(
    skillId: string,
    since: string | null,
    column: "harness" | "via",
  ): Promise<SkillUsageKeyCountRow[]>;
  /** Newest first; ties in engine order. */
  detailRecent(
    skillId: string,
    since: string | null,
    limit: number,
  ): Promise<SkillDetailRecentRow[]>;
  /** Id of the oldest skill named `name` in any scope (lowest `createdAt`), or null. */
  findOldestSkillIdByName(name: string): Promise<string | null>;
}

/**
 * Tasks a worker actually started: the denominator for task adoption. A task
 * counts when its status is only reachable after starting, when a harness
 * session ran for it, or when `agent_log` recorded it entering `in_progress`.
 */
const STARTED_TASK = sql`(t.status IN ('in_progress', 'paused', 'completed')
  OR t."claudeSessionId" IS NOT NULL
  OR EXISTS (
    SELECT 1 FROM agent_log l
     WHERE l."taskId" = t.id
       AND l."eventType" IN ('task_status_change', 'task_claimed')
       AND l."newValue" = 'in_progress'
  ))`;

/** One skill's invocations in the window. A finite window is a plain range on `createdAt`. */
function detailWhere(skillId: string, since: string | null): SqlQuery {
  return since === null
    ? sql`si."skillId" = ${skillId}`
    : sql`si."skillId" = ${skillId} AND si."createdAt" >= ${since}`;
}

export abstract class BaseSkillsRepository implements SkillsRepository {
  constructor(protected readonly db: SqlExecutor) {}

  protected detailWhere(skillId: string, since: string | null): SqlQuery {
    return detailWhere(skillId, since);
  }

  findResolvedSkillById(id: string): Promise<ResolvedSkillRow | null> {
    return this.db.get<ResolvedSkillRow>(
      sql`SELECT id, name, version, length(content) AS chars FROM skills WHERE id = ${id}`,
    );
  }

  findResolvedSkillByName(name: string, agentId: string | null): Promise<ResolvedSkillRow | null> {
    return this.db.get<ResolvedSkillRow>(sql`
      SELECT id, name, version, length(content) AS chars FROM skills
      WHERE name = ${name}
        AND ((scope = 'agent' AND "ownerAgentId" = ${agentId}) OR scope IN ('swarm', 'global'))
      ORDER BY CASE scope WHEN 'agent' THEN 0 WHEN 'swarm' THEN 1 ELSE 2 END
      LIMIT 1`);
  }

  async bumpInvocationCount(skillId: string, at: string): Promise<void> {
    await this.db.run(sql`
      UPDATE skills SET "invocationCount" = "invocationCount" + 1, "lastInvokedAt" = ${at}
      WHERE id = ${skillId}`);
  }

  async setUpdatedBy(
    skillId: string,
    userId: string | null,
    agentId: string | null,
  ): Promise<void> {
    await this.db.run(
      sql`UPDATE skills SET updated_by = ${userId}, "updatedByAgentId" = ${agentId} WHERE id = ${skillId}`,
    );
  }

  listSwarmSkillsByName(name: string): Promise<{ id: string; ownerAgentId: string | null }[]> {
    return this.db.query<{ id: string; ownerAgentId: string | null }>(sql`
      SELECT id, "ownerAgentId" FROM skills WHERE name = ${name} AND scope = 'swarm'
      ORDER BY "createdAt", id`);
  }

  async findOwnerlessSkillId(name: string, scope: string): Promise<string | null> {
    const row = await this.db.get<{ id: string }>(sql`
      SELECT id FROM skills WHERE name = ${name} AND scope = ${scope} AND COALESCE("ownerAgentId", '') = ''`);
    return row ? row.id : null;
  }

  /** Engine full-text search (SQLite FTS5 MATCH and bm25). */
  abstract searchRankedSkills<T>(
    match: string,
    exactName: string,
    limit: number,
    columns: string,
  ): Promise<T[]>;

  /** SQLite `INSERT OR IGNORE` skips every constraint failure, not only conflicts. */
  abstract insertSkillInvocation(invocation: NewSkillInvocation): Promise<boolean>;

  // The usage analytics pin SQLite indexes (INDEXED BY) and bucket days with
  // SQLite date modifiers: each engine writes its own.
  abstract usageTotals(since: string | null): Promise<SkillUsageTotalsRow | null>;

  async firstInvocationAt(): Promise<string | null> {
    const row = await this.db.get<{ trackingSince: string | null }>(
      sql`SELECT MIN("createdAt") AS "trackingSince" FROM skill_invocations`,
    );
    return row?.trackingSince ?? null;
  }

  abstract usageDaily(since: string | null, tzOffsetMinutes: number): Promise<SkillUsageDayRow[]>;
  abstract usageByHarness(since: string | null): Promise<SkillUsageKeyCountRow[]>;
  abstract usageBySkill(since: string | null): Promise<SkillUsageSkillRow[]>;
  abstract usageByAgent(since: string | null): Promise<SkillUsageAgentStatsRow[]>;
  abstract unusedSkills(since: string | null): Promise<SkillUsageUnusedSkillRow[]>;
  abstract detailDaily(
    skillId: string,
    since: string | null,
    tzOffsetMinutes: number,
  ): Promise<SkillUsageDayRow[]>;

  taskAdoption(since: string): Promise<{ tasks: number; tasksWithSkill: number | null } | null> {
    return this.db.get<{ tasks: number; tasksWithSkill: number | null }>(sql`
      SELECT COUNT(*) AS tasks,
             SUM(CASE WHEN t.id IN (
                   SELECT "taskId" FROM skill_invocations
                    WHERE "taskId" IS NOT NULL AND "createdAt" >= ${since}
                 ) THEN 1 ELSE 0 END) AS "tasksWithSkill"
        FROM agent_tasks t
       WHERE t."createdAt" >= ${since} AND ${STARTED_TASK}`);
  }

  detailTotals(skillId: string, since: string | null): Promise<SkillDetailTotalsRow | null> {
    return this.db.get<SkillDetailTotalsRow>(sql`
      SELECT COUNT(*) AS invocations,
             COUNT(DISTINCT si."agentId") AS "distinctAgents",
             COUNT(DISTINCT si."taskId") AS "distinctTasks",
             SUM(si."tokenCount") AS tokens
        FROM skill_invocations si
       WHERE ${detailWhere(skillId, since)}`);
  }

  detailByAgent(skillId: string, since: string | null): Promise<SkillDetailAgentRow[]> {
    return this.db.query<SkillDetailAgentRow>(sql`
      SELECT si."agentId" AS "agentId", MAX(a.name) AS "agentName",
             COUNT(*) AS invocations, MAX(si."createdAt") AS "lastInvokedAt"
        FROM skill_invocations si
        LEFT JOIN agents a ON a.id = si."agentId"
       WHERE ${detailWhere(skillId, since)} AND si."agentId" IS NOT NULL
       GROUP BY si."agentId"
       ORDER BY invocations DESC, "agentName"`);
  }

  detailCountBy(
    skillId: string,
    since: string | null,
    column: "harness" | "via",
  ): Promise<SkillUsageKeyCountRow[]> {
    const value = column === "harness" ? sql`si.harness` : sql`si.via`;
    return this.db.query<SkillUsageKeyCountRow>(sql`
      SELECT COALESCE(${value}, 'unknown') AS key, COUNT(*) AS invocations
        FROM skill_invocations si
       WHERE ${detailWhere(skillId, since)}
       GROUP BY 1
       ORDER BY 2 DESC, 1`);
  }

  detailRecent(
    skillId: string,
    since: string | null,
    limit: number,
  ): Promise<SkillDetailRecentRow[]> {
    return this.db.query<SkillDetailRecentRow>(sql`
      SELECT si.id, si."agentId", a.name AS "agentName", si."taskId",
             COALESCE(NULLIF(t.title, ''), substr(t.task, 1, 160)) AS "taskTitle",
             si.harness, si.via, si."skillVersion", si."tokenCount", si."createdAt"
        FROM skill_invocations si
        LEFT JOIN agents a ON a.id = si."agentId"
        LEFT JOIN agent_tasks t ON t.id = si."taskId"
       WHERE ${detailWhere(skillId, since)}
       ORDER BY si."createdAt" DESC
       LIMIT ${limit}`);
  }

  async findOldestSkillIdByName(name: string): Promise<string | null> {
    const row = await this.db.get<{ id: string }>(
      sql`SELECT id FROM skills WHERE name = ${name} ORDER BY "createdAt" LIMIT 1`,
    );
    return row?.id ?? null;
  }
}
