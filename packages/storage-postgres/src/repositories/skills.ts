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
import { notOnPostgresYet } from "./not-yet";

/** The window predicate: a plain range on `createdAt`, none for `all`. */
function sinceFilter(since: string | null): SqlQuery {
  return since === null ? sql`true` : sql`si."createdAt" >= ${since}`;
}

/**
 * SQLite's `date(createdAt, '+N minutes')`: the UTC instant shifted by the
 * offset, as `YYYY-MM-DD`. The offset is clamped to real zones, as there.
 */
function localDay(tzOffsetMinutes: number): SqlQuery {
  const minutes = Math.max(-14 * 60, Math.min(14 * 60, Math.trunc(tzOffsetMinutes)));
  return sql`to_char((si."createdAt" AT TIME ZONE 'UTC') + make_interval(mins => CAST(${minutes} AS integer)), 'YYYY-MM-DD')`;
}

export class PostgresSkillsRepository extends BaseSkillsRepository {
  // Full-text search (FTS5 skills_fts / skills_meta_fts with bm25) is milestone M4.
  searchRankedSkills<T>(
    _match: string,
    _exactName: string,
    _limit: number,
    _columns: string,
  ): Promise<T[]> {
    return notOnPostgresYet("PostgresSkillsRepository.searchRankedSkills");
  }

  async insertSkillInvocation(i: NewSkillInvocation): Promise<boolean> {
    const result = await this.db.run(sql`
      INSERT INTO skill_invocations
        (id, "skillId", "skillName", "skillVersion", "tokenCount", "agentId", "taskId", "sessionId",
         harness, via, "eventId", "createdAt")
      VALUES (
        ${i.id}, ${i.skillId}, ${i.skillName}, ${i.skillVersion}, ${i.tokenCount}, ${i.agentId},
        ${i.taskId}, ${i.sessionId}, ${i.harness}, ${i.via}, ${i.eventId}, ${i.createdAt}
      )
      ON CONFLICT DO NOTHING`);
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
        FROM skill_invocations si
       WHERE ${sinceFilter(since)}`);
  }

  usageDaily(since: string | null, tzOffsetMinutes: number): Promise<SkillUsageDayRow[]> {
    return this.db.query<SkillUsageDayRow>(sql`
      SELECT ${localDay(tzOffsetMinutes)} AS date,
             COUNT(*) AS invocations,
             COUNT(DISTINCT si."skillName") AS skills,
             COUNT(DISTINCT si."taskId") AS tasks
        FROM skill_invocations si
       WHERE ${sinceFilter(since)}
       GROUP BY 1
       ORDER BY 1`);
  }

  usageByHarness(since: string | null): Promise<SkillUsageKeyCountRow[]> {
    return this.db.query<SkillUsageKeyCountRow>(sql`
      SELECT COALESCE(si.harness, 'unknown') AS key, COUNT(*) AS invocations
        FROM skill_invocations si
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
        FROM skill_invocations si
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
          JOIN skills s ON s.id = x."skillId" AND s."isEnabled" = ${true}
         WHERE x."isActive" = ${true}
        UNION
        SELECT a.id AS "agentId", s.name AS name
          FROM agents a
          JOIN skills s ON s."isEnabled" = ${true} AND (s."systemDefault" = ${true} OR s.scope = 'swarm')
      ),
      used AS (
        SELECT si."agentId" AS "agentId", si."skillName" AS name,
               COUNT(*) AS n, MAX(si."createdAt") AS last
          FROM skill_invocations si
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
             CASE WHEN s."systemDefault" = ${true} OR s.scope = 'swarm' THEN 1 ELSE 0 END AS "installedEverywhere",
             (SELECT COUNT(*) FROM agent_skills x WHERE x."skillId" = s.id AND x."isActive" = ${true}) AS "installedAgents",
             s."invocationCount", s."lastInvokedAt"
        FROM skills s
       WHERE s."isEnabled" = ${true}
         AND (s."systemDefault" = ${true} OR s.scope = 'swarm'
              OR EXISTS (SELECT 1 FROM agent_skills x WHERE x."skillId" = s.id AND x."isActive" = ${true}))
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
      SELECT ${localDay(tzOffsetMinutes)} AS date,
             COUNT(*) AS invocations,
             COUNT(DISTINCT si."skillName") AS skills,
             COUNT(DISTINCT si."taskId") AS tasks
        FROM skill_invocations si
       WHERE ${this.detailWhere(skillId, since)}
       GROUP BY 1
       ORDER BY 1`);
  }

  protected insertionOrder(): SqlQuery {
    return new SqlQuery(['"_rowid"'], []);
  }
}
