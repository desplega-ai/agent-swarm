import {
  BaseSkillsRepository,
  type NewSkillInvocation,
  type SkillUsageAgentStatsRow,
  type SkillUsageDayRow,
  type SkillUsageKeyCountRow,
  type SkillUsageSkillRow,
  type SkillUsageTotalsRow,
  type SkillUsageUnusedSkillRow,
  SqlQuery,
  sql,
} from "@desplega/storage";

// bm25() takes one weight per FTS column, in declaration order.
// skills_fts (migration 239): skill_id (UNINDEXED), name, description, content.
// skills_meta_fts (migration 241): skill_id (UNINDEXED), name, description.
// FTS5 bm25 normalizes by the length of the whole row, so in skills_fts a long
// SKILL.md body buries a name or description hit. skills_meta_fts holds only
// those short fields; its score is added at this multiple.
const META_SCORE_MULTIPLE = 3;

/**
 * The window predicate. A finite window is a plain range on `createdAt`, so
 * SQLite can SEARCH `idx_skill_invocations_created`. `all` has no predicate at
 * all: a nullable `(? IS NULL OR ...)` form would force a full SCAN.
 */
function sinceFilter(since: string | null): SqlQuery {
  return since === null ? sql`1` : sql`si."createdAt" >= ${since}`;
}

/**
 * Swarm-wide aggregates pin the time index for a finite window. Without it the
 * planner may pick `idx_skill_invocations_skill_time` to serve a GROUP BY, or
 * `idx_skill_invocations_agent_time` for `agentId IS NOT NULL`, and walk the
 * whole history.
 */
function invocationsFrom(since: string | null): SqlQuery {
  return since === null
    ? sql`skill_invocations si`
    : sql`skill_invocations si INDEXED BY idx_skill_invocations_created`;
}

/** SQLite date modifier, e.g. `+120 minutes`. The offset is clamped to real zones. */
function dayModifier(tzOffsetMinutes: number): string {
  const minutes = Math.max(-14 * 60, Math.min(14 * 60, Math.trunc(tzOffsetMinutes)));
  return `${minutes >= 0 ? "+" : ""}${minutes} minutes`;
}

export class SqliteSkillsRepository extends BaseSkillsRepository {
  protected insertionOrder(): SqlQuery {
    return new SqlQuery(["rowid"], []);
  }

  searchRankedSkills<T>(
    terms: readonly string[],
    exactName: string,
    limit: number,
    columns: string,
  ): Promise<T[]> {
    if (terms.length === 0) return Promise.resolve([]);
    // Every term is quoted as an FTS5 string, so it cannot inject operators
    // (NEAR, AND, -, *, ^, column filters); the terms are OR-ed.
    const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    // `columns` is a select list written by code (src/be/db.ts), never input.
    const selectList = new SqlQuery([columns], []);
    return this.db.query<T>(sql`
      WITH hits AS (
        SELECT skill_id, bm25(skills_fts, 0.0, 3.0, 2.0, 1.0) AS score
        FROM skills_fts WHERE skills_fts MATCH ${match}
      ),
      meta AS (
        SELECT skill_id, bm25(skills_meta_fts, 0.0, 3.0, 2.0) AS score
        FROM skills_meta_fts WHERE skills_meta_fts MATCH ${match}
      )
      SELECT ${selectList} FROM skills
      LEFT JOIN hits ON hits.skill_id = skills.id
      LEFT JOIN meta ON meta.skill_id = skills.id
      WHERE skills."isEnabled" = 1
        AND (hits.skill_id IS NOT NULL OR lower(skills.name) = lower(${exactName}))
      ORDER BY lower(skills.name) = lower(${exactName}) DESC,
        COALESCE(hits.score, 0) + ${new SqlQuery([String(META_SCORE_MULTIPLE)], [])} * COALESCE(meta.score, 0) ASC,
        skills.name ASC
      LIMIT ${limit}`);
  }

  async insertSkillInvocation(i: NewSkillInvocation): Promise<boolean> {
    const result = await this.db.run(sql`
      INSERT OR IGNORE INTO skill_invocations
        (id, "skillId", "skillName", "skillVersion", "tokenCount", "agentId", "taskId", "sessionId",
         harness, via, "eventId", "createdAt")
      VALUES (
        ${i.id}, ${i.skillId}, ${i.skillName}, ${i.skillVersion}, ${i.tokenCount}, ${i.agentId},
        ${i.taskId}, ${i.sessionId}, ${i.harness}, ${i.via}, ${i.eventId}, ${i.createdAt}
      )`);
    return result.changes > 0;
  }

  usageTotals(since: string | null): Promise<SkillUsageTotalsRow | null> {
    return this.db.get<SkillUsageTotalsRow>(sql`
      SELECT COUNT(*) AS invocations,
             COUNT(DISTINCT si."skillName") AS "distinctSkills",
             COUNT(DISTINCT si."agentId") AS "distinctAgents",
             COUNT(DISTINCT si."taskId") AS "distinctTasks",
             SUM(CASE WHEN si."skillId" IS NULL THEN 1 ELSE 0 END) AS unresolved,
             SUM(si."tokenCount") AS tokens
        FROM ${invocationsFrom(since)}
       WHERE ${sinceFilter(since)}`);
  }

  usageDaily(since: string | null, tzOffsetMinutes: number): Promise<SkillUsageDayRow[]> {
    return this.db.query<SkillUsageDayRow>(sql`
      SELECT date(si."createdAt", ${dayModifier(tzOffsetMinutes)}) AS date,
             COUNT(*) AS invocations,
             COUNT(DISTINCT si."skillName") AS skills,
             COUNT(DISTINCT si."taskId") AS tasks
        FROM ${invocationsFrom(since)}
       WHERE ${sinceFilter(since)}
       GROUP BY 1
       ORDER BY 1`);
  }

  usageByHarness(since: string | null): Promise<SkillUsageKeyCountRow[]> {
    return this.db.query<SkillUsageKeyCountRow>(sql`
      SELECT COALESCE(si.harness, 'unknown') AS key, COUNT(*) AS invocations
        FROM ${invocationsFrom(since)}
       WHERE ${sinceFilter(since)}
       GROUP BY 1
       ORDER BY 2 DESC, 1`);
  }

  usageBySkill(since: string | null): Promise<SkillUsageSkillRow[]> {
    // A resolved row groups by skill id (its current name wins); an unresolved
    // one groups by the reported name.
    return this.db.query<SkillUsageSkillRow>(sql`
      SELECT si."skillId" AS "skillId",
             COALESCE(MAX(s.name), MAX(si."skillName"), 'unknown') AS "skillName",
             COUNT(*) AS invocations,
             COUNT(DISTINCT si."agentId") AS agents,
             COALESCE(SUM(si."tokenCount"), 0) AS tokens,
             MAX(si."createdAt") AS "lastInvokedAt"
        FROM ${invocationsFrom(since)}
        LEFT JOIN skills s ON s.id = si."skillId"
       WHERE ${sinceFilter(since)}
       GROUP BY si."skillId", CASE WHEN si."skillId" IS NULL THEN si."skillName" END
       ORDER BY invocations DESC, "skillName"`);
  }

  usageByAgent(since: string | null): Promise<SkillUsageAgentStatsRow[]> {
    // Installed = what getAgentSkills returns: active explicit installs plus
    // every enabled system-default or swarm-scope skill, deduplicated by name.
    // Agents that are offline and used nothing in the window are left out.
    return this.db.query<SkillUsageAgentStatsRow>(sql`
      WITH installed AS (
        SELECT x."agentId" AS "agentId", s.name AS name
          FROM agent_skills x
          JOIN skills s ON s.id = x."skillId" AND s."isEnabled" = 1
         WHERE x."isActive" = 1
        UNION
        SELECT a.id AS "agentId", s.name AS name
          FROM agents a
          JOIN skills s ON s."isEnabled" = 1 AND (s."systemDefault" = 1 OR s.scope = 'swarm')
      ),
      used AS (
        SELECT si."agentId" AS "agentId", si."skillName" AS name,
               COUNT(*) AS n, MAX(si."createdAt") AS last
          FROM ${invocationsFrom(since)}
         WHERE si."agentId" IS NOT NULL AND si."skillName" IS NOT NULL AND ${sinceFilter(since)}
         GROUP BY si."agentId", si."skillName"
      )
      SELECT a.id AS "agentId",
             a.name AS "agentName",
             a."isLead" AS "isLead",
             (SELECT COUNT(*) FROM installed i WHERE i."agentId" = a.id) AS installed,
             (SELECT COUNT(*) FROM installed i
                JOIN used u ON u."agentId" = i."agentId" AND u.name = i.name
               WHERE i."agentId" = a.id) AS "installedUsed",
             (SELECT COUNT(*) FROM used u WHERE u."agentId" = a.id) AS "skillsUsed",
             (SELECT COALESCE(SUM(u.n), 0) FROM used u WHERE u."agentId" = a.id) AS invocations,
             (SELECT MAX(u.last) FROM used u WHERE u."agentId" = a.id) AS "lastInvokedAt"
        FROM agents a
       WHERE a.status != 'offline' OR EXISTS (SELECT 1 FROM used u WHERE u."agentId" = a.id)
       ORDER BY invocations DESC, a.name`);
  }

  unusedSkills(since: string | null): Promise<SkillUsageUnusedSkillRow[]> {
    return this.db.query<SkillUsageUnusedSkillRow>(sql`
      SELECT s.id, s.name, s.scope, s.type, s."systemDefault",
             CASE WHEN s."systemDefault" = 1 OR s.scope = 'swarm' THEN 1 ELSE 0 END AS "installedEverywhere",
             (SELECT COUNT(*) FROM agent_skills x WHERE x."skillId" = s.id AND x."isActive" = 1) AS "installedAgents",
             s."invocationCount", s."lastInvokedAt"
        FROM skills s
       WHERE s."isEnabled" = 1
         AND (s."systemDefault" = 1 OR s.scope = 'swarm'
              OR EXISTS (SELECT 1 FROM agent_skills x WHERE x."skillId" = s.id AND x."isActive" = 1))
         AND NOT EXISTS (
           SELECT 1 FROM skill_invocations si WHERE si."skillId" = s.id AND ${sinceFilter(since)}
         )
       ORDER BY s.name`);
  }

  detailDaily(
    skillId: string,
    since: string | null,
    tzOffsetMinutes: number,
  ): Promise<SkillUsageDayRow[]> {
    return this.db.query<SkillUsageDayRow>(sql`
      SELECT date(si."createdAt", ${dayModifier(tzOffsetMinutes)}) AS date,
             COUNT(*) AS invocations,
             COUNT(DISTINCT si."skillName") AS skills,
             COUNT(DISTINCT si."taskId") AS tasks
        FROM skill_invocations si
       WHERE ${this.detailWhere(skillId, since)}
       GROUP BY 1
       ORDER BY 1`);
  }
}
