import { getDbClient } from "./db";

/**
 * Read-only skill usage analytics over `skill_invocations` (written by
 * src/be/skill-invocations.ts). Every aggregate runs in SQL; callers get
 * small, already-grouped rows.
 *
 * Windows are rolling (`7d` = the last 7 x 24 h). Daily buckets shift each
 * row by `tzOffsetMinutes` first, so a day is the viewer's local day.
 */

export const SKILL_USAGE_WINDOWS = ["7d", "30d", "all"] as const;
export type SkillUsageWindow = (typeof SKILL_USAGE_WINDOWS)[number];

const WINDOW_DAYS: Record<SkillUsageWindow, number | null> = { "7d": 7, "30d": 30, all: null };
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 25;

/**
 * Tasks a worker actually started: the denominator for task adoption. A task
 * counts when its status is only reachable after starting, when a harness
 * session ran for it, or when `agent_log` recorded it entering `in_progress`.
 * The last two keep a task cancelled or failed mid-run, and leave out one that
 * was terminalized while still pending (`failPendingResumeIfUnclaimed`).
 */
const STARTED_TASK_SQL = `(t.status IN ('in_progress', 'paused', 'completed')
  OR t.claudeSessionId IS NOT NULL
  OR EXISTS (
    SELECT 1 FROM agent_log l
     WHERE l.taskId = t.id
       AND l.eventType IN ('task_status_change', 'task_claimed')
       AND l.newValue = 'in_progress'
  ))`;

/** The `all` summary scans the whole history, so it is reused for a while. */
const ALL_WINDOW_CACHE_MS = 5 * 60 * 1000;
const allWindowCache = new Map<number, { at: number; summary: Promise<SkillUsageSummary> }>();

export function skillUsageWindowStart(window: SkillUsageWindow, now = Date.now()): string | null {
  const days = WINDOW_DAYS[window];
  return days === null ? null : new Date(now - days * DAY_MS).toISOString();
}

/** SQLite date modifier, e.g. `+120 minutes`. The offset is clamped to real zones. */
function dayModifier(tzOffsetMinutes: number): string {
  const minutes = Math.max(-14 * 60, Math.min(14 * 60, Math.trunc(tzOffsetMinutes)));
  return `${minutes >= 0 ? "+" : ""}${minutes} minutes`;
}

export interface SkillUsageDailyRow {
  date: string;
  invocations: number;
  skills: number;
  tasks: number;
}

export interface SkillUsageCountRow {
  key: string;
  invocations: number;
}

export interface SkillUsageBySkillRow {
  skillId: string | null;
  skillName: string;
  invocations: number;
  agents: number;
  tokens: number;
  lastInvokedAt: string;
}

export interface SkillUsageAgentRow {
  agentId: string;
  agentName: string;
  isLead: boolean;
  installed: number;
  installedUsed: number;
  skillsUsed: number;
  invocations: number;
  lastInvokedAt: string | null;
}

export interface SkillUsageUnusedRow {
  id: string;
  name: string;
  scope: string;
  type: string;
  systemDefault: boolean;
  /** True when every agent gets it (system default or swarm scope). */
  installedEverywhere: boolean;
  /** Agents with an explicit active install. */
  installedAgents: number;
  invocationCount: number;
  lastInvokedAt: string | null;
}

export interface SkillUsageSummary {
  window: SkillUsageWindow;
  since: string | null;
  /** First recorded invocation, swarm-wide. Older activity was never recorded. */
  trackingSince: string | null;
  generatedAt: string;
  totals: {
    invocations: number;
    distinctSkills: number;
    distinctAgents: number;
    distinctTasks: number;
    /** Invocations of a name that resolves to no `skills` row. */
    unresolved: number;
    tokens: number;
  };
  taskAdoption: { tasks: number; tasksWithSkill: number; since: string | null };
  daily: SkillUsageDailyRow[];
  byHarness: SkillUsageCountRow[];
  bySkill: SkillUsageBySkillRow[];
  agents: SkillUsageAgentRow[];
  unused: SkillUsageUnusedRow[];
}

export interface SkillUsageRecentRow {
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
}

export interface SkillUsageDetail {
  skillId: string;
  window: SkillUsageWindow;
  since: string | null;
  generatedAt: string;
  totals: { invocations: number; distinctAgents: number; distinctTasks: number; tokens: number };
  daily: SkillUsageDailyRow[];
  byAgent: {
    agentId: string;
    agentName: string | null;
    invocations: number;
    lastInvokedAt: string;
  }[];
  byHarness: SkillUsageCountRow[];
  byVia: SkillUsageCountRow[];
  recent: SkillUsageRecentRow[];
}

/**
 * The window predicate. A finite window is a plain range on `createdAt`, so
 * SQLite can SEARCH `idx_skill_invocations_created` (or a composite index
 * ending in `createdAt`). `all` has no predicate at all. A nullable
 * `(? IS NULL OR ...)` form would force a full SCAN for every window.
 */
function sinceFilter(since: string | null): { sql: string; args: string[] } {
  return since === null ? { sql: "1", args: [] } : { sql: "si.createdAt >= ?", args: [since] };
}

/**
 * Swarm-wide aggregates pin the time index for a finite window. Without it the
 * planner may pick `idx_skill_invocations_skill_time` to serve a GROUP BY, or
 * `idx_skill_invocations_agent_time` for `agentId IS NOT NULL`, and walk the
 * whole history.
 */
function invocationsFrom(since: string | null): string {
  return since === null
    ? "skill_invocations si"
    : "skill_invocations si INDEXED BY idx_skill_invocations_created";
}

export function getSkillUsageSummary(
  window: SkillUsageWindow,
  tzOffsetMinutes = 0,
  now = Date.now(),
): Promise<SkillUsageSummary> {
  if (window !== "all") return computeSkillUsageSummary(window, tzOffsetMinutes, now);

  const cached = allWindowCache.get(tzOffsetMinutes);
  if (cached && now >= cached.at && now - cached.at < ALL_WINDOW_CACHE_MS) return cached.summary;
  for (const [key, entry] of allWindowCache) {
    if (now - entry.at >= ALL_WINDOW_CACHE_MS) allWindowCache.delete(key);
  }
  const summary = computeSkillUsageSummary(window, tzOffsetMinutes, now);
  allWindowCache.set(tzOffsetMinutes, { at: now, summary });
  summary.catch(() => {
    if (allWindowCache.get(tzOffsetMinutes)?.summary === summary) {
      allWindowCache.delete(tzOffsetMinutes);
    }
  });
  return summary;
}

async function computeSkillUsageSummary(
  window: SkillUsageWindow,
  tzOffsetMinutes: number,
  now: number,
): Promise<SkillUsageSummary> {
  const db = getDbClient();
  const since = skillUsageWindowStart(window, now);
  const { sql: sinceSql, args: sinceArgs } = sinceFilter(since);
  const fromSql = invocationsFrom(since);

  const totals = await db.get<{
    invocations: number;
    distinctSkills: number;
    distinctAgents: number;
    distinctTasks: number;
    unresolved: number | null;
    tokens: number | null;
  }>(
    `SELECT COUNT(*) AS invocations,
            COUNT(DISTINCT si.skillName) AS distinctSkills,
            COUNT(DISTINCT si.agentId) AS distinctAgents,
            COUNT(DISTINCT si.taskId) AS distinctTasks,
            SUM(CASE WHEN si.skillId IS NULL THEN 1 ELSE 0 END) AS unresolved,
            SUM(si.tokenCount) AS tokens
       FROM ${fromSql}
      WHERE ${sinceSql}`,
    sinceArgs,
  );

  const first = await db.get<{ trackingSince: string | null }>(
    "SELECT MIN(createdAt) AS trackingSince FROM skill_invocations",
  );
  const trackingSince = first?.trackingSince ?? null;

  const daily = await db.query<SkillUsageDailyRow>(
    `SELECT date(si.createdAt, ?) AS date,
            COUNT(*) AS invocations,
            COUNT(DISTINCT si.skillName) AS skills,
            COUNT(DISTINCT si.taskId) AS tasks
       FROM ${fromSql}
      WHERE ${sinceSql}
      GROUP BY 1
      ORDER BY 1`,
    [dayModifier(tzOffsetMinutes), ...sinceArgs],
  );

  const byHarness = await db.query<SkillUsageCountRow>(
    `SELECT COALESCE(si.harness, 'unknown') AS key, COUNT(*) AS invocations
       FROM ${fromSql}
      WHERE ${sinceSql}
      GROUP BY 1
      ORDER BY 2 DESC, 1`,
    sinceArgs,
  );

  // A resolved row groups by skill id (its current name wins); an unresolved
  // one groups by the reported name.
  const bySkill = await db.query<SkillUsageBySkillRow>(
    `SELECT si.skillId AS skillId,
            COALESCE(MAX(s.name), MAX(si.skillName), 'unknown') AS skillName,
            COUNT(*) AS invocations,
            COUNT(DISTINCT si.agentId) AS agents,
            COALESCE(SUM(si.tokenCount), 0) AS tokens,
            MAX(si.createdAt) AS lastInvokedAt
       FROM ${fromSql}
       LEFT JOIN skills s ON s.id = si.skillId
      WHERE ${sinceSql}
      GROUP BY si.skillId, CASE WHEN si.skillId IS NULL THEN si.skillName END
      ORDER BY invocations DESC, skillName`,
    sinceArgs,
  );

  // Task adoption counts only tasks created after tracking began, so a window
  // reaching past the first recorded invocation is not deflated by tasks that
  // could never have recorded one.
  const adoptionSince =
    trackingSince === null ? null : since !== null && since > trackingSince ? since : trackingSince;
  const adoption =
    adoptionSince === null
      ? { tasks: 0, tasksWithSkill: 0 }
      : await db.get<{ tasks: number; tasksWithSkill: number | null }>(
          `SELECT COUNT(*) AS tasks,
                  SUM(CASE WHEN t.id IN (
                        SELECT taskId FROM skill_invocations
                         WHERE taskId IS NOT NULL AND createdAt >= ?
                      ) THEN 1 ELSE 0 END) AS tasksWithSkill
             FROM agent_tasks t
            WHERE t.createdAt >= ? AND ${STARTED_TASK_SQL}`,
          [adoptionSince, adoptionSince],
        );

  // Installed = what getAgentSkills returns: active explicit installs plus
  // every enabled system-default or swarm-scope skill, deduplicated by name.
  // Agents that are offline and used nothing in the window are left out.
  const agentRows = await db.query<
    Omit<SkillUsageAgentRow, "isLead"> & { isLead: number; agentName: string }
  >(
    `WITH installed AS (
       SELECT x.agentId AS agentId, s.name AS name
         FROM agent_skills x
         JOIN skills s ON s.id = x.skillId AND s.isEnabled = 1
        WHERE x.isActive = 1
       UNION
       SELECT a.id AS agentId, s.name AS name
         FROM agents a
         JOIN skills s ON s.isEnabled = 1 AND (s.systemDefault = 1 OR s.scope = 'swarm')
     ),
     used AS (
       SELECT si.agentId AS agentId, si.skillName AS name,
              COUNT(*) AS n, MAX(si.createdAt) AS last
         FROM ${fromSql}
        WHERE si.agentId IS NOT NULL AND si.skillName IS NOT NULL AND ${sinceSql}
        GROUP BY si.agentId, si.skillName
     )
     SELECT a.id AS agentId,
            a.name AS agentName,
            a.isLead AS isLead,
            (SELECT COUNT(*) FROM installed i WHERE i.agentId = a.id) AS installed,
            (SELECT COUNT(*) FROM installed i
               JOIN used u ON u.agentId = i.agentId AND u.name = i.name
              WHERE i.agentId = a.id) AS installedUsed,
            (SELECT COUNT(*) FROM used u WHERE u.agentId = a.id) AS skillsUsed,
            (SELECT COALESCE(SUM(u.n), 0) FROM used u WHERE u.agentId = a.id) AS invocations,
            (SELECT MAX(u.last) FROM used u WHERE u.agentId = a.id) AS lastInvokedAt
       FROM agents a
      WHERE a.status != 'offline' OR EXISTS (SELECT 1 FROM used u WHERE u.agentId = a.id)
      ORDER BY invocations DESC, a.name`,
    sinceArgs,
  );

  const unusedRows = await db.query<
    Omit<SkillUsageUnusedRow, "systemDefault" | "installedEverywhere"> & {
      systemDefault: number;
      installedEverywhere: number;
    }
  >(
    `SELECT s.id, s.name, s.scope, s.type, s.systemDefault,
            CASE WHEN s.systemDefault = 1 OR s.scope = 'swarm' THEN 1 ELSE 0 END AS installedEverywhere,
            (SELECT COUNT(*) FROM agent_skills x WHERE x.skillId = s.id AND x.isActive = 1) AS installedAgents,
            s.invocationCount, s.lastInvokedAt
       FROM skills s
      WHERE s.isEnabled = 1
        AND (s.systemDefault = 1 OR s.scope = 'swarm'
             OR EXISTS (SELECT 1 FROM agent_skills x WHERE x.skillId = s.id AND x.isActive = 1))
        AND NOT EXISTS (
          SELECT 1 FROM skill_invocations si WHERE si.skillId = s.id AND ${sinceSql}
        )
      ORDER BY s.name`,
    sinceArgs,
  );

  return {
    window,
    since,
    trackingSince,
    generatedAt: new Date(now).toISOString(),
    totals: {
      invocations: totals?.invocations ?? 0,
      distinctSkills: totals?.distinctSkills ?? 0,
      distinctAgents: totals?.distinctAgents ?? 0,
      distinctTasks: totals?.distinctTasks ?? 0,
      unresolved: totals?.unresolved ?? 0,
      tokens: totals?.tokens ?? 0,
    },
    taskAdoption: {
      tasks: adoption?.tasks ?? 0,
      tasksWithSkill: adoption?.tasksWithSkill ?? 0,
      since: adoptionSince,
    },
    daily,
    byHarness,
    bySkill,
    agents: agentRows.map((row) => ({ ...row, isLead: row.isLead === 1 })),
    unused: unusedRows.map((row) => ({
      ...row,
      systemDefault: row.systemDefault === 1,
      installedEverywhere: row.installedEverywhere === 1,
    })),
  };
}

export async function getSkillUsageDetail(
  skillId: string,
  window: SkillUsageWindow,
  tzOffsetMinutes = 0,
  now = Date.now(),
): Promise<SkillUsageDetail> {
  const db = getDbClient();
  const since = skillUsageWindowStart(window, now);
  const filter = sinceFilter(since);
  const args = [skillId, ...filter.args];
  const where = `si.skillId = ? AND ${filter.sql}`;

  const totals = await db.get<{
    invocations: number;
    distinctAgents: number;
    distinctTasks: number;
    tokens: number | null;
  }>(
    `SELECT COUNT(*) AS invocations,
            COUNT(DISTINCT si.agentId) AS distinctAgents,
            COUNT(DISTINCT si.taskId) AS distinctTasks,
            SUM(si.tokenCount) AS tokens
       FROM skill_invocations si
      WHERE ${where}`,
    args,
  );

  const daily = await db.query<SkillUsageDailyRow>(
    `SELECT date(si.createdAt, ?) AS date,
            COUNT(*) AS invocations,
            COUNT(DISTINCT si.skillName) AS skills,
            COUNT(DISTINCT si.taskId) AS tasks
       FROM skill_invocations si
      WHERE ${where}
      GROUP BY 1
      ORDER BY 1`,
    [dayModifier(tzOffsetMinutes), ...args],
  );

  const byAgent = await db.query<SkillUsageDetail["byAgent"][number]>(
    `SELECT si.agentId AS agentId, MAX(a.name) AS agentName,
            COUNT(*) AS invocations, MAX(si.createdAt) AS lastInvokedAt
       FROM skill_invocations si
       LEFT JOIN agents a ON a.id = si.agentId
      WHERE ${where} AND si.agentId IS NOT NULL
      GROUP BY si.agentId
      ORDER BY invocations DESC, agentName`,
    args,
  );

  const countBy = (column: "harness" | "via") =>
    db.query<SkillUsageCountRow>(
      `SELECT COALESCE(si.${column}, 'unknown') AS key, COUNT(*) AS invocations
         FROM skill_invocations si
        WHERE ${where}
        GROUP BY 1
        ORDER BY 2 DESC, 1`,
      args,
    );
  const byHarness = await countBy("harness");
  const byVia = await countBy("via");

  const recent = await db.query<SkillUsageRecentRow>(
    `SELECT si.id, si.agentId, a.name AS agentName, si.taskId,
            COALESCE(NULLIF(t.title, ''), substr(t.task, 1, 160)) AS taskTitle,
            si.harness, si.via, si.skillVersion, si.tokenCount, si.createdAt
       FROM skill_invocations si
       LEFT JOIN agents a ON a.id = si.agentId
       LEFT JOIN agent_tasks t ON t.id = si.taskId
      WHERE ${where}
      ORDER BY si.createdAt DESC
      LIMIT ${RECENT_LIMIT}`,
    args,
  );

  return {
    skillId,
    window,
    since,
    generatedAt: new Date(now).toISOString(),
    totals: {
      invocations: totals?.invocations ?? 0,
      distinctAgents: totals?.distinctAgents ?? 0,
      distinctTasks: totals?.distinctTasks ?? 0,
      tokens: totals?.tokens ?? 0,
    },
    daily,
    byAgent,
    byHarness,
    byVia,
    recent,
  };
}
