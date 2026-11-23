import type {
  SessionKeyRange,
  SessionListTriageWrite,
  SessionPageMemberRow,
  SessionRootFilterSpec,
  SessionSummarySpec,
  SessionThreadLabelRow,
  SessionTreeRow,
  SessionTreeRules,
  SessionViewerSpec,
  SourceBackfillRootRow,
  TaskChainRow,
} from "@desplega/storage";
import {
  BaseSessionsRepository,
  type BudgetRefusalNotificationRow,
  EMPTY,
  jsonText,
  KEY_WINDOW_USAGE_MAX_ROWS,
  type KeyCostSummaryRow,
  type KeyWindowUsageRow,
  type NewBudgetRefusalNotification,
  type RequestCompositionRow,
  type SessionCostAgentSummaryRow,
  type SessionCostCredentialSummaryRow,
  type SessionCostDailySummaryRow,
  type SessionCostFilter,
  type SessionCostRow,
  type SessionCostSummaryFilter,
  type SessionCostTotalsRow,
  type SessionCostUserSummaryRow,
  type SessionLogRow,
  type SessionShareRow,
  type SessionSummaryDriftRow,
  type SqlQuery,
  sql,
  sqlList,
  sqlWhere,
  type TaskAncestorRow,
} from "@desplega/storage";
import {
  isoText,
  legacySessionSummarySql,
  SESSION_ROOTS,
  sessionCountSql,
  sessionMineSql,
  sessionRootFilterSql,
  sessionSummarySql,
  sessionViewerSql,
  sourceThreadKeySql,
  threadPromptSql,
  threadRootsSql,
} from "./session-tree";

type SumRow = { total: number };

/**
 * Sessions recorded before migration 307 carry no credential of their own.
 * Those legacy rows fall back to their task's credential, as usage read it
 * before 307. Newer rows keep their own, null included. Needs `t` joined.
 */
const LEGACY_CREDENTIAL = sql`(sc."credentialKeyType" IS NULL AND sc."createdAt" < (SELECT applied_at FROM _migrations WHERE version = 307))`;
const CREDENTIAL_TYPE = sql`CASE WHEN ${LEGACY_CREDENTIAL} THEN t."credentialKeyType" ELSE sc."credentialKeyType" END`;
const CREDENTIAL_SUFFIX = sql`CASE WHEN ${LEGACY_CREDENTIAL} THEN t."credentialKeySuffix" ELSE sc."credentialKeySuffix" END`;
/**
 * True for a session whose task is structurally human-free. A session with no
 * task row is not human-free.
 */
const HUMAN_FREE = sql`(COALESCE(t."isHumanFree", false))`;
const COST_FROM = sql`FROM session_costs sc LEFT JOIN agent_tasks t ON t.id = sc."taskId"`;
/** SQLite's `DATE(createdAt)` of the stored ISO text: the UTC day. */
const UTC_DAY = (column: SqlQuery) => sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

/** The session columns of a credential window usage row. */
const KEY_WINDOW_USAGE_COLUMNS = sql`sc."taskId", sc."credentialKeyType", sc."credentialKeySuffix", sc.harness,
  sc."inputTokens", sc."outputTokens", sc."cacheReadTokens", sc."cacheWriteTokens",
  sc."reasoningOutputTokens", sc."thinkingTokens", sc.model, sc."modelBreakdown",
  sc."isError", sc."createdAt"`;

/** The session_logs columns, without the `_rowid` surrogate. */
const LOG_COLUMNS = sql`id, "taskId", "sessionId", iteration, cli, content, "lineNumber", "createdAt", "reasoningChars", "reasoningKind"`;

function costWhere(filter: SessionCostSummaryFilter): SqlQuery {
  const user = filter.user;
  return sqlWhere([
    filter.startDate ? sql`sc."createdAt" >= ${filter.startDate}` : EMPTY,
    filter.endDate ? sql`sc."createdAt" <= ${filter.endDate}` : EMPTY,
    filter.agentId ? sql`sc."agentId" = ${filter.agentId}` : EMPTY,
    user?.kind === "unattributed"
      ? sql`(t."requestedByUserId" IS NULL OR ${HUMAN_FREE})`
      : user?.kind === "user"
        ? sql`(t."requestedByUserId" = ${user.userId} AND NOT ${HUMAN_FREE})`
        : EMPTY,
  ]);
}

const subscription = (filter: SessionCostSummaryFilter) =>
  sql`${CREDENTIAL_TYPE} IN (${sqlList(filter.subscriptionKeyTypes)})`;

type DriftRowParts = {
  ord: number;
  rootId: string;
  field: string;
  en: number | null;
  et: string | null;
  sn: number | null;
  st: string | null;
};

export class PostgresSessionsRepository extends BaseSessionsRepository {
  // ---- session_logs ----
  // "_rowid" is the SQLite rowid: insert order.

  async lastLogLineNumber(sessionId: string, iteration: number): Promise<number | null> {
    const row = await this.db.get<{ lineNumber: number }>(sql`
      SELECT "lineNumber" FROM session_logs WHERE "sessionId" = ${sessionId} AND iteration = ${iteration}
      ORDER BY "_rowid" DESC LIMIT 1`);
    return row ? row.lineNumber : null;
  }

  listClaudeReasoningLines(
    sessionId: string,
    since: string,
  ): Promise<{ id: string; lineNumber: number; messageId: string | null }[]> {
    // SQLite reads these through idx_session_logs_reasoning: the ORDER BY is
    // that index's key order, then insertion order.
    return this.db.query(sql`
      SELECT id, "lineNumber", (content::jsonb)->'message'->>'id' AS "messageId"
      FROM session_logs
      WHERE "reasoningChars" IS NOT NULL AND "createdAt" >= ${since} AND cli = 'claude' AND "sessionId" = ${sessionId}
      ORDER BY "createdAt", cli, "reasoningKind" NULLS FIRST, "reasoningChars", "sessionId",
        "taskId" NULLS FIRST, "_rowid"`);
  }

  listLogsByTask(taskId: string, limit?: number): Promise<SessionLogRow[]> {
    if (typeof limit === "number" && limit > 0) {
      return this.db.query<SessionLogRow>(sql`
        SELECT * FROM (
          SELECT "_rowid" AS seq, ${LOG_COLUMNS} FROM session_logs WHERE "taskId" = ${taskId}
          ORDER BY "_rowid" DESC
          LIMIT ${limit}
        ) AS newest ORDER BY seq ASC`);
    }
    return this.db.query<SessionLogRow>(sql`
      SELECT ${LOG_COLUMNS} FROM session_logs WHERE "taskId" = ${taskId} ORDER BY "_rowid" ASC`);
  }

  listChainWithCosts(rootTaskId: string): Promise<TaskChainRow[]> {
    return this.db.query(sql`
      WITH RECURSIVE chain(id) AS (
        SELECT id FROM agent_tasks WHERE id = ${rootTaskId}
        UNION ALL
        SELECT t.id FROM agent_tasks t
        JOIN chain c ON t."parentTaskId" = c.id
      )
      SELECT t.*,
        (SELECT SUM("totalCostUsd") FROM session_costs WHERE session_costs."taskId" = t.id) AS "totalCostUsd"
      FROM chain
      JOIN agent_tasks t ON t.id = chain.id
      ORDER BY t."createdAt", t."_rowid"`);
  }

  listLogsBySession(sessionId: string, iteration: number): Promise<SessionLogRow[]> {
    return this.db.query<SessionLogRow>(sql`
      SELECT ${LOG_COLUMNS} FROM session_logs WHERE "sessionId" = ${sessionId} AND iteration = ${iteration}
      ORDER BY "_rowid" ASC`);
  }

  // ---- session_costs ----

  listSessionCostsByTask(taskId: string, limit: number): Promise<SessionCostRow[]> {
    return this.db.query<SessionCostRow>(sql`
      SELECT * FROM session_costs WHERE "taskId" = ${taskId}
      ORDER BY "createdAt" DESC, "_rowid" ASC LIMIT ${limit}`);
  }

  listSessionCostsByAgent(agentId: string, limit: number): Promise<SessionCostRow[]> {
    return this.db.query<SessionCostRow>(sql`
      SELECT * FROM session_costs WHERE "agentId" = ${agentId}
      ORDER BY "createdAt" DESC, "_rowid" DESC LIMIT ${limit}`);
  }

  listSessionCosts(filter: SessionCostFilter): Promise<SessionCostRow[]> {
    return this.db.query<SessionCostRow>(sql`
      SELECT * FROM session_costs${this.sessionCostFilter(filter)}
      ORDER BY "createdAt" DESC, "_rowid" DESC LIMIT ${filter.limit}`);
  }

  // ---- cost summaries ----
  // Grouped by select-list position: the grouped expressions hold a subquery.

  costSummaryTotals(filter: SessionCostSummaryFilter): Promise<SessionCostTotalsRow | null> {
    return this.db.get<SessionCostTotalsRow>(sql`
      SELECT
        COALESCE(SUM(sc."totalCostUsd"), 0) AS "totalCostUsd",
        COALESCE(SUM(sc."inputTokens"), 0) AS "totalInputTokens",
        COALESCE(SUM(sc."outputTokens"), 0) AS "totalOutputTokens",
        COALESCE(SUM(sc."cacheReadTokens"), 0) AS "totalCacheReadTokens",
        COALESCE(SUM(sc."cacheWriteTokens"), 0) AS "totalCacheWriteTokens",
        COALESCE(SUM(sc."durationMs"), 0) AS "totalDurationMs",
        COUNT(*) AS "totalSessions",
        COALESCE(SUM(CASE WHEN t."requestedByUserId" IS NOT NULL AND NOT ${HUMAN_FREE}
          THEN sc."totalCostUsd" ELSE 0 END), 0) AS "attributedCostUsd",
        COALESCE(SUM(CASE WHEN NOT ${HUMAN_FREE}
          THEN sc."totalCostUsd" ELSE 0 END), 0) AS "attributableCostUsd",
        COALESCE(SUM(CASE WHEN ${HUMAN_FREE}
          THEN sc."totalCostUsd" ELSE 0 END), 0) AS "excludedCostUsd",
        COUNT(DISTINCT CASE WHEN ${HUMAN_FREE} THEN t.id END) AS "excludedTaskCount",
        COALESCE(SUM(CASE WHEN ${subscription(filter)}
          THEN sc."totalCostUsd" ELSE 0 END), 0) AS "subscriptionCostUsd",
        COALESCE(SUM(CASE WHEN ${CREDENTIAL_TYPE} IS NULL
          THEN sc."totalCostUsd" ELSE 0 END), 0) AS "credentialUnattributedCostUsd",
        COUNT(CASE WHEN ${CREDENTIAL_TYPE} IS NULL THEN 1 END) AS "credentialUnattributedSessions"
      ${COST_FROM}${costWhere(filter)}`);
  }

  costSummaryDaily(filter: SessionCostSummaryFilter): Promise<SessionCostDailySummaryRow[]> {
    return this.db.query<SessionCostDailySummaryRow>(sql`
      SELECT
        ${UTC_DAY(sql`sc."createdAt"`)} AS date,
        COALESCE(SUM(sc."totalCostUsd"), 0) AS "costUsd",
        COALESCE(SUM(sc."inputTokens"), 0) AS "inputTokens",
        COALESCE(SUM(sc."outputTokens"), 0) AS "outputTokens",
        COUNT(*) AS sessions,
        COALESCE(SUM(CASE WHEN ${subscription(filter)} THEN sc."totalCostUsd" ELSE 0 END), 0)
          AS "subscriptionCostUsd",
        COALESCE(SUM(CASE WHEN ${CREDENTIAL_TYPE} IS NULL
          THEN sc."totalCostUsd" ELSE 0 END), 0) AS "credentialUnattributedCostUsd",
        COUNT(CASE WHEN ${CREDENTIAL_TYPE} IS NULL THEN 1 END) AS "credentialUnattributedSessions"
      ${COST_FROM}${costWhere(filter)}
      GROUP BY 1
      ORDER BY date ASC`);
  }

  costSummaryByAgent(filter: SessionCostSummaryFilter): Promise<SessionCostAgentSummaryRow[]> {
    const from = filter.user === undefined ? sql`FROM session_costs sc` : COST_FROM;
    return this.db.query<SessionCostAgentSummaryRow>(sql`
      SELECT
        sc."agentId" AS "agentId",
        COALESCE(SUM(sc."totalCostUsd"), 0) AS "costUsd",
        COALESCE(SUM(sc."inputTokens"), 0) AS "inputTokens",
        COALESCE(SUM(sc."outputTokens"), 0) AS "outputTokens",
        COUNT(*) AS sessions,
        COALESCE(SUM(sc."durationMs"), 0) AS "durationMs"
      ${from}${costWhere(filter)}
      GROUP BY sc."agentId"
      ORDER BY "costUsd" DESC, sc."agentId"`);
  }

  costSummaryByUser(filter: SessionCostSummaryFilter): Promise<SessionCostUserSummaryRow[]> {
    const user = sql`CASE WHEN ${HUMAN_FREE} THEN NULL ELSE t."requestedByUserId" END`;
    return this.db.query<SessionCostUserSummaryRow>(sql`
      SELECT
        ${user} AS "userId",
        COALESCE(SUM(sc."totalCostUsd"), 0) AS "costUsd",
        COALESCE(SUM(sc."inputTokens"), 0) AS "inputTokens",
        COALESCE(SUM(sc."outputTokens"), 0) AS "outputTokens",
        COUNT(DISTINCT sc."taskId") AS tasks,
        COALESCE(SUM(sc."durationMs"), 0) AS "durationMs"
      ${COST_FROM}${costWhere(filter)}
      GROUP BY 1
      ORDER BY "costUsd" DESC, "userId" NULLS FIRST`);
  }

  costSummaryByCredential(
    filter: SessionCostSummaryFilter,
  ): Promise<SessionCostCredentialSummaryRow[]> {
    return this.db.query<SessionCostCredentialSummaryRow>(sql`
      SELECT
        ${CREDENTIAL_TYPE} AS "keyType",
        ${CREDENTIAL_SUFFIX} AS "keySuffix",
        COALESCE(SUM(sc."totalCostUsd"), 0) AS "costUsd",
        COALESCE(SUM(sc."inputTokens"), 0) AS "inputTokens",
        COALESCE(SUM(sc."outputTokens"), 0) AS "outputTokens",
        COUNT(*) AS sessions,
        MIN(sc."createdAt") AS "firstSessionAt",
        MAX(sc."createdAt") AS "lastSessionAt"
      ${COST_FROM}${costWhere(filter)}
      GROUP BY 1, 2
      ORDER BY "costUsd" DESC, "keyType" NULLS FIRST, "keySuffix" NULLS FIRST`);
  }

  keyCostSummary(keyType?: string): Promise<KeyCostSummaryRow[]> {
    const where = sqlWhere([
      sql`${CREDENTIAL_SUFFIX} IS NOT NULL`,
      keyType ? sql`${CREDENTIAL_TYPE} = ${keyType}` : EMPTY,
    ]);
    return this.db.query<KeyCostSummaryRow>(sql`
      SELECT
        ${CREDENTIAL_TYPE} AS "keyType",
        ${CREDENTIAL_SUFFIX} AS "keySuffix",
        COALESCE(SUM(sc."totalCostUsd"), 0) AS "totalCost",
        COALESCE(SUM(sc."inputTokens"), 0) AS "totalInputTokens",
        COALESCE(SUM(sc."outputTokens"), 0) AS "totalOutputTokens",
        COUNT(DISTINCT sc."taskId") AS "taskCount"
      ${COST_FROM}${where}
      GROUP BY 1, 2
      ORDER BY "keyType" NULLS FIRST, "keySuffix"`);
  }

  // SQLite compares the first 10 characters of the stored ISO text: the UTC day.
  async dailySpendForAgent(agentId: string, dateUtc: string): Promise<number> {
    const row = await this.db.get<SumRow>(sql`
      SELECT COALESCE(SUM("totalCostUsd"), 0) AS total FROM session_costs
      WHERE "agentId" = ${agentId} AND ${UTC_DAY(sql`"createdAt"`)} = ${dateUtc}`);
    return row?.total ?? 0;
  }

  async dailySpendGlobal(dateUtc: string): Promise<number> {
    const row = await this.db.get<SumRow>(sql`
      SELECT COALESCE(SUM("totalCostUsd"), 0) AS total FROM session_costs
      WHERE ${UTC_DAY(sql`"createdAt"`)} = ${dateUtc}`);
    return row?.total ?? 0;
  }

  async dailySpendForUser(userId: string, dateUtc: string): Promise<number> {
    const row = await this.db.get<SumRow>(sql`
      SELECT COALESCE(SUM(sc."totalCostUsd"), 0) AS total
      FROM session_costs sc
      JOIN agent_tasks t ON sc."taskId" = t.id
      WHERE t."requestedByUserId" = ${userId} AND ${UTC_DAY(sql`sc."createdAt"`)} = ${dateUtc}`);
    return row?.total ?? 0;
  }

  // ---- request_composition ----

  listRequestCompositionsByTask(taskId: string, limit: number): Promise<RequestCompositionRow[]> {
    return this.db.query<RequestCompositionRow>(sql`
      SELECT id, "taskId", "agentId", "sessionId", seq, provider, model, source, parts, "staticEstTokens", "tokenRatio", "createdAt"
      FROM request_composition WHERE "taskId" = ${taskId}
      ORDER BY "createdAt" ASC, seq ASC, "_rowid" ASC LIMIT ${limit}`);
  }

  // ---- session summaries ----

  async findSessionSummaryDrift(
    since: string | null,
    terminalStatuses: readonly string[],
  ): Promise<SessionSummaryDriftRow[]> {
    // A UNION column has one type on Postgres: each side of the comparison
    // comes back as a number (en/sn) or as text (et/st), timestamps as ISO
    // text, and the two halves merge below. SQLite returns the same values in
    // one dynamically typed column.
    const open =
      terminalStatuses.length > 0 ? sql`t.status NOT IN (${sqlList(terminalStatuses)})` : sql`TRUE`;
    const human = sql`t."requestedByUserId" IS NOT NULL AND t."requestedByUserIdInherited" = false
      AND COALESCE(t.source, '') NOT IN ('mcp', 'system', 'schedule', 'workflow')`;
    const sinceTs = sql`CAST(${since} AS timestamptz)`;
    const iso = (column: SqlQuery) =>
      sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    const rows = await this.db.query<DriftRowParts>(sql`WITH RECURSIVE chain(root_id, id) AS (
      SELECT id, id FROM agent_tasks WHERE "parentTaskId" IS NULL
      UNION ALL SELECT c.root_id, t.id FROM chain c JOIN agent_tasks t ON t."parentTaskId" = c.id
    ), walked AS (
      SELECT c.root_id, COUNT(*) AS "chainCount",
        (array_agg(t.status ORDER BY t."lastUpdatedAt" DESC))[1] AS "latestStatus",
        MAX(t."lastUpdatedAt") AS "lastActivityAt",
        SUM(CASE WHEN ${open} THEN 1 ELSE 0 END) AS "openTasks"
      FROM chain c JOIN agent_tasks t ON t.id = c.id GROUP BY c.root_id
    ), expected AS (
      SELECT w.*,
        (SELECT COUNT(*) FROM chain c JOIN agent_tasks t ON t.id = c.id
          WHERE c.root_id = w.root_id AND t."lastUpdatedAt" = w."lastActivityAt") AS newest,
        EXISTS (SELECT 1 FROM chain c JOIN approval_requests ar ON ar."sourceTaskId" = c.id
          WHERE c.root_id = w.root_id AND ar.status = 'pending') AS "pendingApproval",
        (SELECT MAX(h.at) FROM (
          SELECT t."createdAt" AS at FROM chain c JOIN agent_tasks t ON t.id = c.id
          WHERE c.root_id = w.root_id AND ${human}
          UNION ALL SELECT sm.created_at FROM chain c JOIN task_steering_messages sm ON sm.task_id = c.id
          WHERE c.root_id = w.root_id AND sm.created_by_kind = 'user' AND sm.status != 'cancelled'
          UNION ALL SELECT ar."createdAt" FROM chain c JOIN approval_requests ar ON ar."sourceTaskId" = c.id
          WHERE c.root_id = w.root_id AND ar.status = 'pending') AS h) AS "lastHumanAt"
      FROM walked w WHERE (${sinceTs} IS NULL OR w."lastActivityAt" >= ${sinceTs})
    ), stored AS (
      SELECT * FROM session_summaries s WHERE (${sinceTs} IS NULL OR s."lastActivityAt" >= ${sinceTs})
    ), drift(ord, "rootId", field, en, et, sn, st) AS (
    SELECT 1, e.root_id, 'summary-missing', e."chainCount", NULL::text, NULL::bigint, NULL::text
      FROM expected e LEFT JOIN session_summaries s ON s."rootId" = e.root_id WHERE s."rootId" IS NULL
    UNION ALL SELECT 2, s."rootId", 'summary-extra', NULL, NULL, s."chainCount", NULL
      FROM stored s LEFT JOIN walked w ON w.root_id = s."rootId" WHERE w.root_id IS NULL
    UNION ALL SELECT 3, e.root_id, 'chainCount', e."chainCount", NULL, s."chainCount", NULL
      FROM expected e JOIN session_summaries s ON s."rootId" = e.root_id
      WHERE s."chainCount" IS DISTINCT FROM e."chainCount"
    UNION ALL SELECT 4, e.root_id, 'lastActivityAt', NULL, ${iso(sql`e."lastActivityAt"`)}, NULL,
        ${iso(sql`s."lastActivityAt"`)}
      FROM expected e JOIN session_summaries s ON s."rootId" = e.root_id
      WHERE s."lastActivityAt" IS DISTINCT FROM e."lastActivityAt"
    UNION ALL SELECT 5, e.root_id, 'latestStatus', NULL, e."latestStatus", NULL, s."latestStatus"
      FROM expected e JOIN session_summaries s ON s."rootId" = e.root_id
      WHERE e.newest = 1 AND s."latestStatus" IS DISTINCT FROM e."latestStatus"
    UNION ALL SELECT 6, e.root_id, 'pendingApproval', CASE WHEN e."pendingApproval" THEN 1 ELSE 0 END,
        NULL, CASE WHEN s."pendingApprovalCount" > 0 THEN 1 ELSE 0 END, NULL
      FROM expected e JOIN session_summaries s ON s."rootId" = e.root_id
      WHERE (s."pendingApprovalCount" > 0) IS DISTINCT FROM e."pendingApproval"
    UNION ALL SELECT 7, e.root_id, 'openTasks', e."openTasks", NULL, s."openTaskCount", NULL
      FROM expected e JOIN session_summaries s ON s."rootId" = e.root_id
      WHERE s."openTaskCount" IS DISTINCT FROM e."openTasks"
    UNION ALL SELECT 8, e.root_id, 'lastHumanAt', NULL, ${iso(sql`e."lastHumanAt"`)}, NULL,
        ${iso(sql`s."lastHumanAt"`)}
      FROM expected e JOIN session_summaries s ON s."rootId" = e.root_id
      WHERE s."lastHumanAt" IS DISTINCT FROM e."lastHumanAt"
    UNION ALL SELECT 9, c.root_id, 'member', NULL, c.id, NULL, m."rootId"
      FROM chain c JOIN expected e ON e.root_id = c.root_id
      LEFT JOIN session_members m ON m."taskId" = c.id WHERE m."rootId" IS DISTINCT FROM c.root_id
    UNION ALL SELECT 10, m."rootId", 'member', NULL, NULL, NULL, m."taskId"
      FROM session_members m LEFT JOIN chain c ON c.id = m."taskId" AND c.root_id = m."rootId"
      WHERE c.id IS NULL AND (${sinceTs} IS NULL OR m."rootId" IN (SELECT "rootId" FROM stored))
    )
    SELECT ord, "rootId", field, en, et, sn, st FROM drift ORDER BY ord`);
    return rows.map((row) => ({
      rootId: row.rootId,
      field: row.field,
      expected: row.en ?? row.et ?? null,
      stored: row.sn ?? row.st ?? null,
    }));
  }

  // ---- session_shares and session roots ----

  listTaskAncestors(taskIds: readonly string[]): Promise<TaskAncestorRow[]> {
    // Every ancestor once (`UNION` drops revisits, which also ends a cycle).
    return this.db.query<TaskAncestorRow>(sql`
      WITH RECURSIVE up(id) AS (
        SELECT id FROM agent_tasks WHERE id IN (${sqlList(taskIds)})
        UNION
        SELECT t."parentTaskId" FROM agent_tasks t JOIN up ON t.id = up.id
        WHERE t."parentTaskId" IS NOT NULL
      )
      SELECT t.id, t."parentTaskId", t."requestedByUserId", t."scheduleId"
      FROM up JOIN agent_tasks t ON t.id = up.id`);
  }

  listActiveShares(rootTaskId: string): Promise<SessionShareRow[]> {
    return this.db.query<SessionShareRow>(sql`
      SELECT id, "rootTaskId", "userId", access, "createdAt", "revokedAt", "revokedBy"
      FROM session_shares
      WHERE "rootTaskId" = ${rootTaskId} AND "revokedAt" IS NULL
      ORDER BY "createdAt", "_rowid"`);
  }

  listShareHistory(rootTaskId: string): Promise<SessionShareRow[]> {
    return this.db.query<SessionShareRow>(sql`
      SELECT id, "rootTaskId", "userId", access, "createdAt", "revokedAt", "revokedBy"
      FROM session_shares
      WHERE "rootTaskId" = ${rootTaskId}
      ORDER BY "createdAt", "_rowid"`);
  }

  // ---- budget_refusal_notifications ----

  async insertBudgetRefusalNotification(row: NewBudgetRefusalNotification): Promise<number> {
    // SQLite's INSERT OR IGNORE also skips a row that fails a NOT NULL or
    // CHECK constraint: the WHERE skips the same rows here.
    const result = await this.db.run(sql`
      INSERT INTO budget_refusal_notifications
        (task_id, date, agent_id, cause, agent_spend_usd, agent_budget_usd, global_spend_usd, global_budget_usd, user_spend_usd, user_budget_usd, follow_up_task_id, "createdAt")
      SELECT v.* FROM (VALUES (CAST(${row.task_id} AS text), CAST(${row.date} AS text),
        CAST(${row.agent_id} AS text), CAST(${row.cause} AS text),
        CAST(${row.agent_spend_usd} AS double precision), CAST(${row.agent_budget_usd} AS double precision),
        CAST(${row.global_spend_usd} AS double precision), CAST(${row.global_budget_usd} AS double precision),
        CAST(${row.user_spend_usd} AS double precision), CAST(${row.user_budget_usd} AS double precision),
        CAST(NULL AS text), CAST(${row.createdAt} AS bigint)))
        AS v(task_id, date, agent_id, cause, a1, a2, g1, g2, u1, u2, f, created)
      WHERE v.task_id IS NOT NULL AND v.date IS NOT NULL AND v.agent_id IS NOT NULL
        AND v.created IS NOT NULL AND v.cause IN ('agent', 'global', 'user')
      ON CONFLICT DO NOTHING`);
    return result.changes;
  }

  listRecentBudgetRefusalNotifications(limit: number): Promise<BudgetRefusalNotificationRow[]> {
    return this.db.query<BudgetRefusalNotificationRow>(sql`
      SELECT task_id, date, agent_id, cause, agent_spend_usd, agent_budget_usd, global_spend_usd,
             global_budget_usd, user_spend_usd, user_budget_usd, follow_up_task_id, "createdAt"
        FROM budget_refusal_notifications ORDER BY "createdAt" DESC, "_rowid" ASC LIMIT ${limit}`);
  }

  // ---- session tree ----

  sessionThreadRootsSql(rules: SessionTreeRules): SqlQuery {
    return threadRootsSql(rules);
  }

  sessionRootFilterSql(rules: SessionTreeRules, spec: SessionRootFilterSpec): SqlQuery {
    return sessionRootFilterSql(rules, spec);
  }

  sessionSummarySql(rules: SessionTreeRules, spec: SessionSummarySpec): SqlQuery {
    return sessionSummarySql(rules, spec);
  }

  legacySessionSummarySql(rules: SessionTreeRules, spec: SessionSummarySpec): SqlQuery {
    return legacySessionSummarySql(rules, spec);
  }

  sessionCountSql(rules: SessionTreeRules, spec: SessionSummarySpec, chain: boolean): SqlQuery {
    return sessionCountSql(rules, spec, chain);
  }

  protected threadRootCountsSql(rules: SessionTreeRules): SqlQuery {
    return sql`SELECT r."key", COUNT(*) AS "threadRoots" FROM session_summaries r
    WHERE r."requestedByUserId" IS NOT NULL AND ${sourceThreadKeySql(rules)} GROUP BY r."key"`;
  }

  listSessionPageMembers(rootIds: readonly string[]): Promise<SessionPageMemberRow[]> {
    return this.db.query<SessionPageMemberRow>(sql`
      SELECT m."rootId" AS root_id, t."requestedByUserId" AS id, u.name,
        CASE WHEN t.source = 'system' AND t."taskType" = 'follow-up' THEN NULL ELSE NULLIF(trim(substr(t.output, 1, 200)), '') END AS preview
      FROM session_members m JOIN agent_tasks t ON t.id = m."taskId"
      LEFT JOIN users u ON u.id = t."requestedByUserId"
      WHERE m."rootId" IN (${sqlList(rootIds)})
      ORDER BY t."lastUpdatedAt" DESC, t."createdAt" DESC, t.id DESC`);
  }

  listSessionTreeRows(
    rules: SessionTreeRules,
    spec: SessionSummarySpec,
    visibleRule: { mine: boolean; userId: string | null; readAll?: boolean } | null,
  ): Promise<SessionTreeRow[]> {
    const visible = visibleRule
      ? sql`(r."requestedByUserId" IS NOT NULL${
          visibleRule.mine
            ? sql` AND ${sessionMineSql(rules, visibleRule.userId, visibleRule.readAll)}`
            : EMPTY
        })`
      : sql`TRUE`;
    return this.db.query<SessionTreeRow>(sql`
      SELECT a.root_id, a."key", a.source, a."slackChannelId", a."lastActivityAt", a."latestStatus",
        a."readState", a."needsYou", r."scheduleId", CAST(${visible} AS integer) AS "defaultVisible"
      FROM (${sessionSummarySql(rules, spec)}) a JOIN ${SESSION_ROOTS} r ON r.id = a.root_id`);
  }

  listThreadLabels(
    rootIds: readonly string[],
    promptChars: number,
  ): Promise<SessionThreadLabelRow[]> {
    return this.db.query<SessionThreadLabelRow>(sql`
      SELECT "key", title, prompt FROM (
        SELECT r."key", NULLIF(trim(r.title), '') AS title, ${threadPromptSql(promptChars)} AS prompt,
          ROW_NUMBER() OVER (PARTITION BY r."key" ORDER BY r."createdAt", r."_rowid") AS ordinal
        FROM agent_tasks r WHERE r.id IN (${sqlList(rootIds)})
      ) AS labelled WHERE ordinal = 1`);
  }

  async triageSessionList(
    rules: SessionTreeRules,
    spec: SessionSummarySpec,
    write: SessionListTriageWrite,
  ): Promise<number> {
    // lastReadAt is a text column: the activity time goes in as SQLite's ISO text.
    const lastReadAt = !write.lastReadAt
      ? sql`CAST(NULL AS text)`
      : write.lastReadAt.kind === "activity"
        ? isoText(sql`a."lastActivityAt"`)
        : sql`CAST(${write.lastReadAt.value} AS text)`;
    const result = await this.db.run(sql`
      INSERT INTO inbox_item_state
        ("userId", "itemType", "itemId", status, "snoozeUntil", "dismissedAt", "doneAt", "readAt", "lastReadAt", "createdAt", "lastUpdatedAt")
      SELECT CAST(${write.userId} AS text), 'to_read', a.root_id, CAST(${write.status} AS text), CAST(NULL AS text),
        CAST(NULL AS timestamptz), CAST(${write.doneAt} AS timestamptz), CAST(${write.readAt} AS text), ${lastReadAt},
        CAST(${write.now} AS timestamptz), CAST(${write.now} AS timestamptz)
      FROM (${sessionSummarySql(rules, spec)}) a
      ON CONFLICT ("userId", "itemType", "itemId") DO UPDATE SET
        status = excluded.status,
        "snoozeUntil" = NULL,
        "dismissedAt" = NULL,
        "doneAt" = excluded."doneAt",
        "readAt" = COALESCE(inbox_item_state."readAt", excluded."readAt"),
        "lastReadAt" = ${write.lastReadAt ? sql`excluded."lastReadAt"` : sql`inbox_item_state."lastReadAt"`},
        "lastUpdatedAt" = excluded."lastUpdatedAt"`);
    return result.changes;
  }

  // ---- session moves ----

  async moveKeyFavorites(range: SessionKeyRange, to: string, scope?: string): Promise<void> {
    const inRange = (alias: SqlQuery) => sql`${alias}."itemType" IN ('key','hidden-key')
      AND ${alias}."itemId" >= ${range.lo} AND ${alias}."itemId" < ${range.hi}${
        scope !== undefined ? sql` AND ${alias}."favoriteScope" = ${scope}` : EMPTY
      }`;
    const moved = sql`CAST(${to} AS text) || substr(f."itemId", ${range.lo.length + 1}::integer)`;
    // SQLite's UPDATE OR IGNORE leaves a row whose new key another row of the
    // same scope and type already holds: the NOT EXISTS skips the same rows.
    await this.db.run(sql`
      UPDATE user_favorites f SET "itemId" = ${moved}
      WHERE ${inRange(sql`f`)} AND NOT EXISTS (SELECT 1 FROM user_favorites o
        WHERE o."favoriteScope" = f."favoriteScope" AND o."itemType" = f."itemType" AND o."itemId" = ${moved})`);
    await this.db.run(sql`DELETE FROM user_favorites f WHERE ${inRange(sql`f`)}`);
  }

  listVisiblePrefixRoots(
    range: SessionKeyRange,
    viewer: SessionViewerSpec,
  ): Promise<{ id: string }[]> {
    return this.db.query(sql`
      SELECT r.id FROM agent_tasks r
      WHERE r."parentTaskId" IS NULL AND r."key" >= ${range.lo} AND r."key" < ${range.hi}
        AND ${sessionViewerSql(viewer)} ORDER BY r.id`);
  }

  listSourceBackfillRoots(afterId: string, limit: number): Promise<SourceBackfillRootRow[]> {
    return this.db.query<SourceBackfillRootRow>(sql`
      SELECT id, "slackChannelId", "slackThreadTs", "contextKey" FROM agent_tasks
       WHERE "parentTaskId" IS NULL AND id > ${afterId}
         AND ("key" = 'shared/' OR "key" = 'shared/task:' || lower(id) || '/')
         AND (("slackChannelId" IS NOT NULL AND "slackThreadTs" IS NOT NULL)
           OR starts_with("contextKey", 'task:chat-sdk:'))
       ORDER BY id LIMIT ${limit}`);
  }

  listKeyWindowUsageRows(
    credentials: { keyType: string; keySuffix: string }[],
    start: string,
    through: string,
  ): Promise<KeyWindowUsageRow[]> {
    // Receipt rows and older completion-attribution rows are disjoint (see
    // the SQLite statement). No ORDER BY, as on SQLite: callers group the rows.
    const startTs = sql`CAST(${start} AS timestamptz)`;
    const throughTs = sql`CAST(${through} AS timestamptz)`;
    return this.db.query<KeyWindowUsageRow>(sql`
      WITH requested_keys AS (
        SELECT k->>'keyType' AS "keyType", k->>'keySuffix' AS "keySuffix"
        FROM jsonb_array_elements(${jsonText(JSON.stringify(credentials))}) AS k
      )
      SELECT ${KEY_WINDOW_USAGE_COLUMNS}, CASE WHEN t.status = 'completed' THEN t."finishedAt" END AS "finishedAt"
      FROM requested_keys k
      JOIN session_costs sc ON sc."credentialKeyType" = k."keyType" AND sc."credentialKeySuffix" = k."keySuffix"
      LEFT JOIN agent_tasks t ON t.id = sc."taskId"
      WHERE sc."createdAt" >= ${startTs} AND sc."createdAt" < ${throughTs}
      UNION ALL
      SELECT ${KEY_WINDOW_USAGE_COLUMNS}, t."finishedAt"
      FROM agent_tasks t
      JOIN session_costs sc ON sc."taskId" = t.id
      JOIN requested_keys k ON sc."credentialKeyType" = k."keyType" AND sc."credentialKeySuffix" = k."keySuffix"
      WHERE t.status = 'completed' AND t."finishedAt" >= ${startTs} AND t."finishedAt" < ${throughTs}
        AND sc."createdAt" < ${startTs}
      UNION ALL
      SELECT NULL, NULL, NULL, NULL, 0, 0, NULL, NULL, 0, 0, '', NULL, FALSE, sc."createdAt", NULL
      FROM session_costs sc
      WHERE (sc."credentialKeyType" IS NULL OR sc."credentialKeySuffix" IS NULL)
        AND sc.kind = 'harness'
        AND sc."createdAt" >= ${startTs} AND sc."createdAt" < ${throughTs}
      LIMIT ${KEY_WINDOW_USAGE_MAX_ROWS + 1}`);
  }

  async insertPricingSeedRow(
    provider: string,
    model: string,
    tokenClass: string,
    pricePerMillionUsd: number,
  ): Promise<boolean> {
    const result = await this.db.run(sql`
      INSERT INTO pricing
        (provider, model, token_class, effective_from, price_per_million_usd, "createdAt", "lastUpdatedAt")
      VALUES (${provider}, ${model}, ${tokenClass}, 0, ${pricePerMillionUsd}, 0, 0)
      ON CONFLICT DO NOTHING`);
    return result.changes > 0;
  }
}
