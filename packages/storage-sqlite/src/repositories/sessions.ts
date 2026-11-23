import {
  BaseSessionsRepository,
  type BudgetRefusalNotificationRow,
  EMPTY,
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
  type SessionKeyRange,
  type SessionListTriageWrite,
  type SessionLogRow,
  type SessionPageMemberRow,
  type SessionRootFilterSpec,
  type SessionShareRow,
  type SessionSummaryDriftRow,
  type SessionSummarySpec,
  type SessionThreadLabelRow,
  type SessionTreeRow,
  type SessionTreeRules,
  type SessionViewerSpec,
  type SourceBackfillRootRow,
  SqlQuery,
  sql,
  sqlList,
  sqlWhere,
  type TaskAncestorRow,
  type TaskChainRow,
} from "@desplega/storage";
import { keyWindowUsageQuery } from "./key-window-usage";
import {
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
const HUMAN_FREE = sql`(COALESCE(t."isHumanFree", 0) = 1)`;
// INDEXED BY: without ANALYZE statistics (production has none) the planner
// probes tasks through the primary key and reads each full row, which follows
// the task's overflow pages. The covering index answers the same probe from
// the index alone (migration 182).
const COST_FROM = sql`FROM session_costs sc LEFT JOIN agent_tasks t INDEXED BY idx_agent_tasks_usage_cover ON t.id = sc."taskId"`;

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

export class SqliteSessionsRepository extends BaseSessionsRepository {
  /** CROSS JOIN pins the loop order: page rows outer, the root primary key inner. */
  protected override sessionPageJoin(): SqlQuery {
    return sql`CROSS JOIN`;
  }

  // ---- session_logs ----
  // Session log reads order by rowid, which is insert order. Rows written
  // before lineNumber was assigned server-side restart at 0 on every worker
  // flush, so only rowid orders them.

  async lastLogLineNumber(sessionId: string, iteration: number): Promise<number | null> {
    // Reading the newest row by rowid walks the sessionId index backwards and
    // stops at the first hit, where MAX() would scan the whole session.
    const row = await this.db.get<{ lineNumber: number }>(sql`
      SELECT "lineNumber" FROM session_logs WHERE "sessionId" = ${sessionId} AND iteration = ${iteration}
      ORDER BY rowid DESC LIMIT 1`);
    return row ? row.lineNumber : null;
  }

  listClaudeReasoningLines(
    sessionId: string,
    since: string,
  ): Promise<{ id: string; lineNumber: number; messageId: string | null }[]> {
    // INDEXED BY: with `sessionId = ?` the planner would pick the sessionId
    // index and read every line of the session.
    return this.db.query(sql`
      SELECT id, "lineNumber", json_extract(content, '$.message.id') AS "messageId"
      FROM session_logs INDEXED BY idx_session_logs_reasoning
      WHERE "reasoningChars" IS NOT NULL AND "createdAt" >= ${since} AND cli = 'claude' AND "sessionId" = ${sessionId}`);
  }

  listLogsByTask(taskId: string, limit?: number): Promise<SessionLogRow[]> {
    if (typeof limit === "number" && limit > 0) {
      return this.db.query<SessionLogRow>(sql`
        SELECT * FROM (
          SELECT rowid AS seq, * FROM session_logs WHERE "taskId" = ${taskId}
          ORDER BY rowid DESC
          LIMIT ${limit}
        ) ORDER BY seq ASC`);
    }
    return this.db.query<SessionLogRow>(
      sql`SELECT * FROM session_logs WHERE "taskId" = ${taskId} ORDER BY rowid ASC`,
    );
  }

  listChainWithCosts(rootTaskId: string): Promise<TaskChainRow[]> {
    // rowid breaks createdAt ties as idx_agent_tasks_created did. CROSS JOIN
    // keeps the chain as the outer loop: with a plain JOIN, SQLite scanned all
    // of agent_tasks to skip the sort.
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
      CROSS JOIN agent_tasks t ON t.id = chain.id
      ORDER BY t."createdAt", t.rowid`);
  }

  listLogsBySession(sessionId: string, iteration: number): Promise<SessionLogRow[]> {
    return this.db.query<SessionLogRow>(sql`
      SELECT * FROM session_logs WHERE "sessionId" = ${sessionId} AND iteration = ${iteration}
      ORDER BY rowid ASC`);
  }

  // ---- session_costs ----
  // The tiebreakers spell out the order the plans give today: the taskId index
  // sorts in a temp b-tree (ties in rowid order), the createdAt indexes are
  // walked backwards (ties newest rowid first).

  listSessionCostsByTask(taskId: string, limit: number): Promise<SessionCostRow[]> {
    return this.db.query<SessionCostRow>(sql`
      SELECT * FROM session_costs WHERE "taskId" = ${taskId}
      ORDER BY "createdAt" DESC, rowid ASC LIMIT ${limit}`);
  }

  listSessionCostsByAgent(agentId: string, limit: number): Promise<SessionCostRow[]> {
    return this.db.query<SessionCostRow>(sql`
      SELECT * FROM session_costs WHERE "agentId" = ${agentId}
      ORDER BY "createdAt" DESC, rowid DESC LIMIT ${limit}`);
  }

  listSessionCosts(filter: SessionCostFilter): Promise<SessionCostRow[]> {
    return this.db.query<SessionCostRow>(sql`
      SELECT * FROM session_costs${this.sessionCostFilter(filter)}
      ORDER BY "createdAt" DESC, rowid DESC LIMIT ${filter.limit}`);
  }

  // ---- cost summaries ----
  // Every column is `sc.`-qualified because `createdAt`/`agentId` exist on
  // both sides. The tiebreakers spell out today's order: grouped rows come out
  // in group-key order and the sort keeps ties in that order.

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
        DATE(sc."createdAt") AS date,
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
      GROUP BY DATE(sc."createdAt")
      ORDER BY date ASC`);
  }

  costSummaryByAgent(filter: SessionCostSummaryFilter): Promise<SessionCostAgentSummaryRow[]> {
    // Only a user filter reads the task, and the join adds no rows (task id is unique).
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
    // Structurally-human-free work goes to the autonomous bucket even if a
    // stale requester id survives on the task.
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
      GROUP BY ${user}
      ORDER BY "costUsd" DESC, "userId"`);
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
      GROUP BY ${CREDENTIAL_TYPE}, ${CREDENTIAL_SUFFIX}
      ORDER BY "costUsd" DESC, "keyType", "keySuffix"`);
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
      GROUP BY ${CREDENTIAL_TYPE}, ${CREDENTIAL_SUFFIX}
      ORDER BY "keyType", "keySuffix"`);
  }

  // `createdAt` is ISO text: the left-anchored substr keeps the
  // (agentId, createdAt) index usable.
  async dailySpendForAgent(agentId: string, dateUtc: string): Promise<number> {
    const row = await this.db.get<SumRow>(sql`
      SELECT COALESCE(SUM("totalCostUsd"), 0) AS total FROM session_costs
      WHERE "agentId" = ${agentId} AND substr("createdAt", 1, 10) = ${dateUtc}`);
    return row?.total ?? 0;
  }

  async dailySpendGlobal(dateUtc: string): Promise<number> {
    const row = await this.db.get<SumRow>(sql`
      SELECT COALESCE(SUM("totalCostUsd"), 0) AS total FROM session_costs
      WHERE substr("createdAt", 1, 10) = ${dateUtc}`);
    return row?.total ?? 0;
  }

  listKeyWindowUsageRows(
    credentials: { keyType: string; keySuffix: string }[],
    start: string,
    through: string,
  ): Promise<KeyWindowUsageRow[]> {
    return this.db.query<KeyWindowUsageRow>(keyWindowUsageQuery(credentials, start, through));
  }

  async dailySpendForUser(userId: string, dateUtc: string): Promise<number> {
    const row = await this.db.get<SumRow>(sql`
      SELECT COALESCE(SUM(sc."totalCostUsd"), 0) AS total
      FROM session_costs sc
      JOIN agent_tasks t ON sc."taskId" = t.id
      WHERE t."requestedByUserId" = ${userId} AND substr(sc."createdAt", 1, 10) = ${dateUtc}`);
    return row?.total ?? 0;
  }

  // ---- request_composition ----

  listRequestCompositionsByTask(taskId: string, limit: number): Promise<RequestCompositionRow[]> {
    return this.db.query<RequestCompositionRow>(sql`
      SELECT id, "taskId", "agentId", "sessionId", seq, provider, model, source, parts, "staticEstTokens", "tokenRatio", "createdAt"
      FROM request_composition WHERE "taskId" = ${taskId}
      ORDER BY "createdAt" ASC, seq ASC, rowid ASC LIMIT ${limit}`);
  }

  // ---- session summaries ----

  findSessionSummaryDrift(
    since: string | null,
    terminalStatuses: readonly string[],
  ): Promise<SessionSummaryDriftRow[]> {
    const open =
      terminalStatuses.length > 0 ? sql`t.status NOT IN (${sqlList(terminalStatuses)})` : sql`1`;
    const human = sql`t."requestedByUserId" IS NOT NULL AND t."requestedByUserIdInherited" = 0
      AND COALESCE(t.source, '') NOT IN ('mcp', 'system', 'schedule', 'workflow')`;
    return this.db.query<SessionSummaryDriftRow>(sql`WITH RECURSIVE chain(root_id, id) AS (
      SELECT id, id FROM agent_tasks WHERE "parentTaskId" IS NULL
      UNION ALL SELECT c.root_id, t.id FROM chain c JOIN agent_tasks t ON t."parentTaskId" = c.id
    ), walked AS (
      SELECT c.root_id, COUNT(*) AS "chainCount", t.status AS "latestStatus",
        MAX(t."lastUpdatedAt") AS "lastActivityAt", SUM(${open}) AS "openTasks"
      FROM chain c JOIN agent_tasks t ON t.id = c.id GROUP BY c.root_id
    ), expected AS (
      SELECT w.*,
        (SELECT COUNT(*) FROM chain c JOIN agent_tasks t ON t.id = c.id
          WHERE c.root_id = w.root_id AND t."lastUpdatedAt" = w."lastActivityAt") AS newest,
        EXISTS (SELECT 1 FROM chain c JOIN approval_requests ar ON ar."sourceTaskId" = c.id
          WHERE c.root_id = w.root_id AND ar.status = 'pending') AS "pendingApproval",
        (SELECT MAX(at) FROM (
          SELECT t."createdAt" AS at FROM chain c JOIN agent_tasks t ON t.id = c.id
          WHERE c.root_id = w.root_id AND ${human}
          UNION ALL SELECT sm.created_at FROM chain c JOIN task_steering_messages sm ON sm.task_id = c.id
          WHERE c.root_id = w.root_id AND sm.created_by_kind = 'user' AND sm.status != 'cancelled'
          UNION ALL SELECT ar."createdAt" FROM chain c JOIN approval_requests ar ON ar."sourceTaskId" = c.id
          WHERE c.root_id = w.root_id AND ar.status = 'pending')) AS "lastHumanAt"
      FROM walked w WHERE (${since} IS NULL OR w."lastActivityAt" >= ${since})
    ), stored AS (
      SELECT * FROM session_summaries s WHERE (${since} IS NULL OR s."lastActivityAt" >= ${since})
    )
    SELECT e.root_id AS "rootId", 'summary-missing' AS field, e."chainCount" AS expected, NULL AS stored
      FROM expected e LEFT JOIN session_summaries s ON s."rootId" = e.root_id WHERE s."rootId" IS NULL
    UNION ALL SELECT s."rootId", 'summary-extra', NULL, s."chainCount"
      FROM stored s LEFT JOIN walked w ON w.root_id = s."rootId" WHERE w.root_id IS NULL
    UNION ALL SELECT e.root_id, 'chainCount', e."chainCount", s."chainCount"
      FROM expected e JOIN session_summaries s ON s."rootId" = e.root_id WHERE s."chainCount" IS NOT e."chainCount"
    UNION ALL SELECT e.root_id, 'lastActivityAt', e."lastActivityAt", s."lastActivityAt"
      FROM expected e JOIN session_summaries s ON s."rootId" = e.root_id
      WHERE s."lastActivityAt" IS NOT e."lastActivityAt"
    UNION ALL SELECT e.root_id, 'latestStatus', e."latestStatus", s."latestStatus"
      FROM expected e JOIN session_summaries s ON s."rootId" = e.root_id
      WHERE e.newest = 1 AND s."latestStatus" IS NOT e."latestStatus"
    UNION ALL SELECT e.root_id, 'pendingApproval', e."pendingApproval", s."pendingApprovalCount" > 0
      FROM expected e JOIN session_summaries s ON s."rootId" = e.root_id
      WHERE (s."pendingApprovalCount" > 0) IS NOT e."pendingApproval"
    UNION ALL SELECT e.root_id, 'openTasks', e."openTasks", s."openTaskCount"
      FROM expected e JOIN session_summaries s ON s."rootId" = e.root_id
      WHERE s."openTaskCount" IS NOT e."openTasks"
    UNION ALL SELECT e.root_id, 'lastHumanAt', e."lastHumanAt", s."lastHumanAt"
      FROM expected e JOIN session_summaries s ON s."rootId" = e.root_id
      WHERE s."lastHumanAt" IS NOT e."lastHumanAt"
    UNION ALL SELECT c.root_id, 'member', c.id, m."rootId"
      FROM chain c JOIN expected e ON e.root_id = c.root_id
      LEFT JOIN session_members m ON m."taskId" = c.id WHERE m."rootId" IS NOT c.root_id
    UNION ALL SELECT m."rootId", 'member', NULL, m."taskId"
      FROM session_members m LEFT JOIN chain c ON c.id = m."taskId" AND c.root_id = m."rootId"
      WHERE c.id IS NULL AND (${since} IS NULL OR m."rootId" IN (SELECT "rootId" FROM stored))`);
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
      FROM up CROSS JOIN agent_tasks t ON t.id = up.id`);
  }

  listActiveShares(rootTaskId: string): Promise<SessionShareRow[]> {
    return this.db.query<SessionShareRow>(sql`
      SELECT id, "rootTaskId", "userId", access, "createdAt", "revokedAt", "revokedBy"
      FROM session_shares
      WHERE "rootTaskId" = ${rootTaskId} AND "revokedAt" IS NULL
      ORDER BY "createdAt", rowid`);
  }

  listShareHistory(rootTaskId: string): Promise<SessionShareRow[]> {
    return this.db.query<SessionShareRow>(sql`
      SELECT id, "rootTaskId", "userId", access, "createdAt", "revokedAt", "revokedBy"
      FROM session_shares
      WHERE "rootTaskId" = ${rootTaskId}
      ORDER BY "createdAt", rowid`);
  }

  // ---- budget_refusal_notifications ----

  async insertPricingSeedRow(
    provider: string,
    model: string,
    tokenClass: string,
    pricePerMillionUsd: number,
  ): Promise<boolean> {
    const result = await this.db.run(sql`
      INSERT OR IGNORE INTO pricing
        (provider, model, token_class, effective_from, price_per_million_usd, "createdAt", "lastUpdatedAt")
      VALUES (${provider}, ${model}, ${tokenClass}, 0, ${pricePerMillionUsd}, 0, 0)`);
    return result.changes > 0;
  }

  async insertBudgetRefusalNotification(row: NewBudgetRefusalNotification): Promise<number> {
    const result = await this.db.run(sql`
      INSERT OR IGNORE INTO budget_refusal_notifications
        (task_id, date, agent_id, cause, agent_spend_usd, agent_budget_usd, global_spend_usd, global_budget_usd, user_spend_usd, user_budget_usd, follow_up_task_id, "createdAt")
      VALUES (${row.task_id}, ${row.date}, ${row.agent_id}, ${row.cause}, ${row.agent_spend_usd},
        ${row.agent_budget_usd}, ${row.global_spend_usd}, ${row.global_budget_usd},
        ${row.user_spend_usd}, ${row.user_budget_usd}, NULL, ${row.createdAt})`);
    return result.changes;
  }

  listRecentBudgetRefusalNotifications(limit: number): Promise<BudgetRefusalNotificationRow[]> {
    // No index on createdAt: the sort keeps ties in rowid order.
    return this.db.query<BudgetRefusalNotificationRow>(sql`
      SELECT * FROM budget_refusal_notifications ORDER BY "createdAt" DESC, rowid ASC LIMIT ${limit}`);
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
      FROM session_members m CROSS JOIN agent_tasks t ON t.id = m."taskId"
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
      : sql`1`;
    return this.db.query<SessionTreeRow>(sql`
      SELECT a.root_id, a."key", a.source, a."slackChannelId", a."lastActivityAt", a."latestStatus",
        a."readState", a."needsYou", r."scheduleId", (${visible}) AS "defaultVisible"
      FROM (${sessionSummarySql(rules, spec)}) a JOIN ${SESSION_ROOTS} r ON r.id = a.root_id`);
  }

  listThreadLabels(
    rootIds: readonly string[],
    promptChars: number,
  ): Promise<SessionThreadLabelRow[]> {
    return this.db.query<SessionThreadLabelRow>(sql`
      SELECT "key", title, prompt FROM (
        SELECT r."key", NULLIF(trim(r.title), '') AS title, ${threadPromptSql(promptChars)} AS prompt,
          ROW_NUMBER() OVER (PARTITION BY r."key" ORDER BY r."createdAt", r.rowid) AS ordinal
        FROM agent_tasks r WHERE r.id IN (${sqlList(rootIds)})
      ) WHERE ordinal = 1`);
  }

  async triageSessionList(
    rules: SessionTreeRules,
    spec: SessionSummarySpec,
    write: SessionListTriageWrite,
  ): Promise<number> {
    const lastReadAt = !write.lastReadAt
      ? sql`NULL`
      : write.lastReadAt.kind === "activity"
        ? sql`a."lastActivityAt"`
        : sql`${write.lastReadAt.value}`;
    // Sticky readAt, lastReadAt only when the write sets it, snooze and dismiss
    // cleared (the rules of the single-row inbox upsert). `WHERE true` is
    // required: SQLite cannot parse INSERT ... SELECT ... ON CONFLICT when the
    // SELECT has no WHERE clause.
    const result = await this.db.run(sql`
      INSERT INTO inbox_item_state
        ("userId", "itemType", "itemId", status, "snoozeUntil", "dismissedAt", "doneAt", "readAt", "lastReadAt", "createdAt", "lastUpdatedAt")
      SELECT ${write.userId}, 'to_read', a.root_id, ${write.status}, NULL, NULL, ${write.doneAt}, ${write.readAt}, ${lastReadAt}, ${write.now}, ${write.now}
      FROM (${sessionSummarySql(rules, spec)}) a WHERE true
      ON CONFLICT("userId", "itemType", "itemId") DO UPDATE SET
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
    const inRange = sql`"itemType" IN ('key','hidden-key') AND "itemId" >= ${range.lo} AND "itemId" < ${range.hi}${
      scope !== undefined ? sql` AND "favoriteScope" = ${scope}` : EMPTY
    }`;
    await this.db.run(
      sql`UPDATE OR IGNORE user_favorites SET "itemId" = ${to} || substr("itemId", ${range.lo.length + 1}) WHERE ${inRange}`,
    );
    await this.db.run(sql`DELETE FROM user_favorites WHERE ${inRange}`);
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
    // The select list stays unquoted: session-source-backfill.test.ts matches
    // the statement by its leading text.
    const select = new SqlQuery(["SELECT id, slackChannelId, slackThreadTs, contextKey"], []);
    return this.db.query<SourceBackfillRootRow>(sql`${select} FROM agent_tasks
       WHERE "parentTaskId" IS NULL AND id > ${afterId}
         AND ("key" = 'shared/' OR "key" = 'shared/task:' || lower(id) || '/')
         AND (("slackChannelId" IS NOT NULL AND "slackThreadTs" IS NOT NULL)
           OR "contextKey" GLOB 'task:chat-sdk:*')
       ORDER BY id LIMIT ${limit}`);
  }
}
