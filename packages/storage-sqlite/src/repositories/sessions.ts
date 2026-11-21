import {
  BaseSessionsRepository,
  type BudgetRefusalNotificationRow,
  type NewBudgetRefusalNotification,
  type RequestCompositionRow,
  type SessionCostFilter,
  type SessionCostRow,
  type SessionLogRow,
  type SessionShareRow,
  type SessionSummaryDriftRow,
  sql,
  sqlList,
  type TaskAncestorRow,
} from "@desplega/storage";

type SumRow = { total: number };

export class SqliteSessionsRepository extends BaseSessionsRepository {
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
}
