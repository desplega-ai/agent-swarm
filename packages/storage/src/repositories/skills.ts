import { likeAsciiCi } from "../dialect";
import type { SqlExecutor } from "../executor";
import { EMPTY, SqlQuery, sql, sqlIdent, sqlJoin } from "../sql";

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

/** One `skills` row. */
export type SkillRow = {
  id: string;
  name: string;
  description: string;
  content: string;
  type: string;
  scope: string;
  ownerAgentId: string | null;
  sourceUrl: string | null;
  sourceRepo: string | null;
  sourcePath: string | null;
  sourceBranch: string;
  sourceHash: string | null;
  isComplex: number;
  allowedTools: string | null;
  model: string | null;
  effort: string | null;
  context: string | null;
  agent: string | null;
  disableModelInvocation: number;
  userInvocable: number;
  version: number;
  isEnabled: number;
  systemDefault: number;
  invocationCount: number;
  lastInvokedAt: string | null;
  createdByAgentId: string | null;
  updatedByAgentId: string | null;
  created_by: string | null;
  updated_by: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  lastFetchedAt: string | null;
};

/** A skill row with its install state (`agent_skills`, or implied for swarm/default skills). */
export type SkillWithInstallRow = SkillRow & {
  isActive: number;
  installedAt: string;
  sourceRank?: number;
  typeRank?: number;
};

/** One `skill_files` row. */
export type SkillFileRow = {
  id: string;
  skillId: string;
  path: string;
  content: string;
  mimeType: string;
  isBinary: number;
  size: number | null;
  createdAt: string;
  lastUpdatedAt: string;
};

type SkillFlags =
  | "isComplex"
  | "disableModelInvocation"
  | "userInvocable"
  | "isEnabled"
  | "systemDefault";

/** The columns of a new skill (flags as JS booleans; `version` starts at 1). */
export type NewSkillRow = Omit<
  SkillRow,
  SkillFlags | "version" | "invocationCount" | "lastInvokedAt" | "lastFetchedAt"
> & { [K in SkillFlags]: boolean };

/** Columns a skill update may set (flags as JS booleans). */
export type SkillColumnUpdate = Partial<
  Pick<
    SkillRow,
    | "name"
    | "description"
    | "content"
    | "scope"
    | "allowedTools"
    | "model"
    | "effort"
    | "context"
    | "agent"
    | "sourceUrl"
    | "sourceRepo"
    | "sourcePath"
    | "sourceBranch"
    | "sourceHash"
    | "lastFetchedAt"
    | "updated_by"
    | "updatedByAgentId"
  > & { [K in SkillFlags]: boolean }
>;

export type SkillListFilter = {
  type?: string;
  scope?: string;
  ownerAgentId?: string;
  isEnabled?: boolean;
  /** Substring of the name or description (case-insensitive for ASCII). */
  search?: string;
  limit?: number;
  /** Leave out `content` (read as ''). */
  slim: boolean;
};

/**
 * Every skill column except the heavy `content` (the full SKILL.md), which
 * reads as '' so the row keeps the `SkillRow` shape. Text chosen by code.
 */
export const SKILL_SLIM_COLUMNS =
  'id, name, description, type, scope, "ownerAgentId", "sourceUrl", "sourceRepo", "sourcePath", "sourceBranch", "sourceHash", "isComplex", "allowedTools", model, effort, context, agent, "disableModelInvocation", "userInvocable", version, "isEnabled", "systemDefault", "invocationCount", "lastInvokedAt", "createdByAgentId", "updatedByAgentId", created_by, updated_by, "createdAt", "lastUpdatedAt", "lastFetchedAt", \'\' as content';

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
   * then name). `terms` are the search words, OR-ed: each term is one phrase
   * (letters, digits, `_` and `-`), and each engine builds its own query from
   * them, so no term can inject query syntax. `columns` is a trusted select
   * list over `skills` written by code. No terms: no rows.
   */
  searchRankedSkills<T>(
    terms: readonly string[],
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

  // ---- skills CRUD ----
  insertSkill(row: NewSkillRow): Promise<SkillRow | null>;
  /** Sets the given columns and `lastUpdatedAt`; bumps `version` when `content` is set. */
  updateSkill(id: string, update: SkillColumnUpdate, now: string): Promise<SkillRow | null>;
  bumpSkillVersion(skillId: string, now: string): Promise<void>;
  deleteSkill(id: string): Promise<number>;
  findSkillById(id: string): Promise<SkillRow | null>;
  /** Owner NULL matches `ownerAgentId` ''. */
  findSkillByName(name: string, scope: string, ownerAgentId: string): Promise<SkillRow | null>;
  /** By name (then insertion order). */
  listSkills(f: SkillListFilter): Promise<SkillRow[]>;
  /**
   * Enabled skills matching every token (name, description or content
   * substring): a name equal to `exactName` (case-insensitive) first, then by
   * name, then insertion order.
   */
  searchSkillsBySubstring(
    tokens: readonly string[],
    exactName: string,
    limit: number,
    slim: boolean,
  ): Promise<SkillRow[]>;
  /** Enabled system-default skills by name, then insertion order. */
  listSystemDefaultSkills(): Promise<SkillRow[]>;
  /**
   * The agent's installed skills (active only when `activeOnly`), then every
   * enabled swarm-scope or system-default skill: installed first, personal
   * before others, then by name. Rows of equal rank and name come in no fixed order.
   */
  listAgentSkills(agentId: string, activeOnly: boolean): Promise<SkillWithInstallRow[]>;
  countSkills(): Promise<number>;

  // ---- skill_files ----
  /** One skill's files by path (unique per skill). */
  listSkillFiles(skillId: string): Promise<SkillFileRow[]>;
  findSkillFile(skillId: string, path: string): Promise<SkillFileRow | null>;
  /** Insert, or replace the content of the file at (skillId, path). */
  upsertSkillFile(
    row: Omit<SkillFileRow, "isBinary"> & { isBinary: boolean },
  ): Promise<SkillFileRow | null>;
  deleteSkillFile(skillId: string, path: string): Promise<number>;
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

  /** Engine full-text search (SQLite FTS5 MATCH and bm25, Postgres tsvector and ts_rank). */
  abstract searchRankedSkills<T>(
    terms: readonly string[],
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

  /** The insertion-order column (SQLite `rowid`), for ORDER BY tiebreaks only. */
  protected abstract insertionOrder(): SqlQuery;

  // ---- skills CRUD ----

  insertSkill(r: NewSkillRow): Promise<SkillRow | null> {
    return this.db.get<SkillRow>(sql`
      INSERT INTO skills (
        id, name, description, content, type, scope, "ownerAgentId",
        "sourceUrl", "sourceRepo", "sourcePath", "sourceBranch", "sourceHash", "isComplex",
        "allowedTools", model, effort, context, agent, "disableModelInvocation", "userInvocable",
        version, "isEnabled", "systemDefault", "createdAt", "lastUpdatedAt",
        "createdByAgentId", "updatedByAgentId", created_by, updated_by
      ) VALUES (
        ${r.id}, ${r.name}, ${r.description}, ${r.content}, ${r.type}, ${r.scope}, ${r.ownerAgentId},
        ${r.sourceUrl}, ${r.sourceRepo}, ${r.sourcePath}, ${r.sourceBranch}, ${r.sourceHash},
        ${r.isComplex}, ${r.allowedTools}, ${r.model}, ${r.effort}, ${r.context}, ${r.agent},
        ${r.disableModelInvocation}, ${r.userInvocable}, 1, ${r.isEnabled}, ${r.systemDefault},
        ${r.createdAt}, ${r.lastUpdatedAt}, ${r.createdByAgentId}, ${r.updatedByAgentId},
        ${r.created_by}, ${r.updated_by}
      ) RETURNING *`);
  }

  updateSkill(id: string, u: SkillColumnUpdate, now: string): Promise<SkillRow | null> {
    const columns: (keyof SkillColumnUpdate)[] = [
      "name",
      "description",
      "content",
      "scope",
      "isEnabled",
      "systemDefault",
      "allowedTools",
      "model",
      "effort",
      "context",
      "agent",
      "disableModelInvocation",
      "userInvocable",
      "sourceUrl",
      "sourceRepo",
      "sourcePath",
      "sourceBranch",
      "sourceHash",
      "isComplex",
      "lastFetchedAt",
      "updated_by",
      "updatedByAgentId",
    ];
    const sets: SqlQuery[] = [sql`"lastUpdatedAt" = ${now}`];
    for (const column of columns) {
      const value = u[column];
      if (value !== undefined) sets.push(sql`${sqlIdent(column)} = ${value}`);
    }
    if (u.content !== undefined) sets.push(sql`version = version + 1`);
    return this.db.get<SkillRow>(
      sql`UPDATE skills SET ${sqlJoin(sets, sql`, `)} WHERE id = ${id} RETURNING *`,
    );
  }

  async bumpSkillVersion(skillId: string, now: string): Promise<void> {
    await this.db.run(sql`
      UPDATE skills SET version = version + 1, "lastUpdatedAt" = ${now} WHERE id = ${skillId}`);
  }

  async deleteSkill(id: string): Promise<number> {
    return (await this.db.run(sql`DELETE FROM skills WHERE id = ${id}`)).changes;
  }

  findSkillById(id: string): Promise<SkillRow | null> {
    return this.db.get<SkillRow>(sql`SELECT * FROM skills WHERE id = ${id}`);
  }

  findSkillByName(name: string, scope: string, ownerAgentId: string): Promise<SkillRow | null> {
    return this.db.get<SkillRow>(sql`
      SELECT * FROM skills
      WHERE name = ${name} AND scope = ${scope} AND COALESCE("ownerAgentId", '') = ${ownerAgentId}`);
  }

  private columns(slim: boolean): SqlQuery {
    return new SqlQuery([slim ? SKILL_SLIM_COLUMNS : "*"], []);
  }

  listSkills(f: SkillListFilter): Promise<SkillRow[]> {
    const c: SqlQuery[] = [sql`1=1`];
    if (f.type) c.push(sql`type = ${f.type}`);
    if (f.scope) c.push(sql`scope = ${f.scope}`);
    if (f.ownerAgentId) c.push(sql`"ownerAgentId" = ${f.ownerAgentId}`);
    if (f.isEnabled !== undefined) c.push(sql`"isEnabled" = ${f.isEnabled}`);
    if (f.search) {
      const term = sql`${`%${f.search}%`}`;
      c.push(sql`(${likeAsciiCi(sql`name`, term)} OR ${likeAsciiCi(sql`description`, term)})`);
    }
    const limit = f.limit ? sql` LIMIT ${f.limit}` : EMPTY;
    return this.db.query<SkillRow>(sql`
      SELECT ${this.columns(f.slim)} FROM skills WHERE ${sqlJoin(c, sql` AND `)}
      ORDER BY name ASC, ${this.insertionOrder()} ASC${limit}`);
  }

  searchSkillsBySubstring(
    tokens: readonly string[],
    exactName: string,
    limit: number,
    slim: boolean,
  ): Promise<SkillRow[]> {
    const clauses = tokens.map((token) => {
      const term = sql`${`%${token}%`}`;
      return sql`(${likeAsciiCi(sql`name`, term)} OR ${likeAsciiCi(sql`description`, term)}
        OR ${likeAsciiCi(sql`content`, term)})`;
    });
    clauses.push(sql`"isEnabled" = ${true}`);
    return this.db.query<SkillRow>(sql`
      SELECT ${this.columns(slim)} FROM skills WHERE ${sqlJoin(clauses, sql` AND `)}
      ORDER BY lower(name) = lower(${exactName}) DESC, name ASC, ${this.insertionOrder()} ASC
      LIMIT ${limit}`);
  }

  listSystemDefaultSkills(): Promise<SkillRow[]> {
    return this.db.query<SkillRow>(sql`
      SELECT * FROM skills WHERE "systemDefault" = ${true} AND "isEnabled" = ${true}
      ORDER BY name ASC, ${this.insertionOrder()} ASC`);
  }

  listAgentSkills(agentId: string, activeOnly: boolean): Promise<SkillWithInstallRow[]> {
    const active = activeOnly ? sql` AND as2."isActive" = ${true}` : EMPTY;
    return this.db.query<SkillWithInstallRow>(sql`
      SELECT s.*, as2."isActive", as2."installedAt", 0 as "sourceRank",
        CASE WHEN s.type = 'personal' THEN 0 ELSE 1 END as "typeRank"
      FROM skills s
      JOIN agent_skills as2 ON s.id = as2."skillId"
      WHERE as2."agentId" = ${agentId}${active}
        AND s."isEnabled" = ${true}
      UNION ALL
      SELECT s.*, ${true} as "isActive", s."createdAt" as "installedAt", 1 as "sourceRank",
        CASE WHEN s.type = 'personal' THEN 0 ELSE 1 END as "typeRank"
      FROM skills s
      WHERE (s."systemDefault" = ${true} OR s.scope = 'swarm')
        AND s."isEnabled" = ${true}
      ORDER BY "sourceRank", "typeRank", name`);
  }

  // ---- skill_files ----

  private readonly fileColumns = sql`id, "skillId", path, content, "mimeType", "isBinary", size,
    "createdAt", "lastUpdatedAt"`;

  listSkillFiles(skillId: string): Promise<SkillFileRow[]> {
    return this.db.query<SkillFileRow>(sql`
      SELECT ${this.fileColumns} FROM skill_files WHERE "skillId" = ${skillId} ORDER BY path ASC`);
  }

  findSkillFile(skillId: string, path: string): Promise<SkillFileRow | null> {
    return this.db.get<SkillFileRow>(sql`
      SELECT ${this.fileColumns} FROM skill_files WHERE "skillId" = ${skillId} AND path = ${path}`);
  }

  upsertSkillFile(
    r: Omit<SkillFileRow, "isBinary"> & { isBinary: boolean },
  ): Promise<SkillFileRow | null> {
    return this.db.get<SkillFileRow>(sql`
      INSERT INTO skill_files (${this.fileColumns})
      VALUES (${r.id}, ${r.skillId}, ${r.path}, ${r.content}, ${r.mimeType}, ${r.isBinary}, ${r.size},
        ${r.createdAt}, ${r.lastUpdatedAt})
      ON CONFLICT("skillId", path) DO UPDATE SET
        content = excluded.content,
        "mimeType" = excluded."mimeType",
        "isBinary" = excluded."isBinary",
        size = excluded.size,
        "lastUpdatedAt" = excluded."lastUpdatedAt"
      RETURNING *`);
  }

  async deleteSkillFile(skillId: string, path: string): Promise<number> {
    const result = await this.db.run(
      sql`DELETE FROM skill_files WHERE "skillId" = ${skillId} AND path = ${path}`,
    );
    return result.changes;
  }

  async countSkills(): Promise<number> {
    const row = await this.db.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM skills`);
    return row?.count ?? 0;
  }
}
