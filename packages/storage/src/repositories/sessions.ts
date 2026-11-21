import { nowIso } from "../dialect";
import type { SqlExecutor } from "../executor";
import { type SqlQuery, sql, sqlWhere } from "../sql";

/**
 * Domain: sessions and cost (`session_logs`, `session_costs`,
 * `session_members`, `session_shares`, `session_summaries`,
 * `session_summary_recompute`, `session_tokens`, `request_composition`,
 * `budgets`, `budget_refusal_notifications`, `pricing`). Rows come back in the
 * SQLite value shape on every engine (flags 0/1, JSON as text, timestamps as
 * the text the column stores; `budgets`, `budget_refusal_notifications` and
 * `pricing` store epoch-ms integers).
 */

// ---- session_logs ----

export type SessionLogRow = {
  id: string;
  taskId: string | null;
  sessionId: string;
  iteration: number;
  cli: string;
  content: string;
  lineNumber: number;
  createdAt: string;
};

export type NewSessionLog = {
  id: string;
  taskId: string | null;
  sessionId: string;
  iteration: number;
  cli: string;
  content: string;
  lineNumber: number;
  reasoningChars: number | null;
  reasoningKind: string | null;
};

// ---- session_costs ----

export type SessionCostRow = {
  id: string;
  sessionId: string;
  taskId: string | null;
  agentId: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  credentialKeyType: string | null;
  credentialKeySuffix: string | null;
  harness: string | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningOutputTokens: number;
  thinkingTokens: number;
  durationMs: number;
  numTurns: number | null;
  model: string;
  isError: number;
  costSource: string;
  kind: string;
  harnessCostUsd: number | null;
  cacheWrite5mTokens: number | null;
  cacheWrite1hTokens: number | null;
  modelBreakdown: string | null;
  createdAt: string;
};

export type NewSessionCost = {
  id: string;
  sessionId: string;
  taskId: string | null;
  agentId: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningOutputTokens: number;
  thinkingTokens: number;
  durationMs: number;
  numTurns: number | null;
  model: string;
  isError: boolean;
  costSource: string;
  harnessCostUsd: number | null;
  cacheWrite5mTokens: number | null;
  cacheWrite1hTokens: number | null;
  modelBreakdown: string | null;
  credentialKeyType: string | null;
  credentialKeySuffix: string | null;
  harness: string | null;
  kind: string;
};

export type SessionCostFilter = {
  agentId?: string;
  startDate?: string;
  endDate?: string;
  limit: number;
};

/** Filter of the cost summary reads. Dates are inclusive bounds on `createdAt`. */
export type SessionCostSummaryFilter = {
  startDate?: string;
  endDate?: string;
  agentId?: string;
  /** Spend of one requester, or spend with no human requester. */
  user?: { kind: "user"; userId: string } | { kind: "unattributed" };
  /** Credential types billed as a flat subscription. Never empty. */
  subscriptionKeyTypes: readonly string[];
};

export type SessionCostTotalsRow = {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalDurationMs: number;
  totalSessions: number;
  attributedCostUsd: number;
  attributableCostUsd: number;
  excludedCostUsd: number;
  excludedTaskCount: number;
  subscriptionCostUsd: number;
  credentialUnattributedCostUsd: number;
  credentialUnattributedSessions: number;
};

export type SessionCostDailySummaryRow = {
  date: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  sessions: number;
  subscriptionCostUsd: number;
  credentialUnattributedCostUsd: number;
  credentialUnattributedSessions: number;
};

export type SessionCostAgentSummaryRow = {
  agentId: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  sessions: number;
  durationMs: number;
};

export type SessionCostUserSummaryRow = {
  userId: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  tasks: number;
  durationMs: number;
};

export type SessionCostCredentialSummaryRow = {
  keyType: string | null;
  keySuffix: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  sessions: number;
  firstSessionAt: string;
  lastSessionAt: string;
};

export type KeyCostSummaryRow = {
  keyType: string;
  keySuffix: string;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  taskCount: number;
};

// ---- request_composition ----

export type RequestCompositionRow = {
  id: string;
  taskId: string;
  agentId: string;
  sessionId: string;
  seq: number;
  provider: string;
  model: string | null;
  source: "worker" | "harness-hook";
  parts: string;
  staticEstTokens: number;
  tokenRatio: number;
  createdAt: string;
};

// ---- session summaries ----

export type SessionSummaryDriftRow = {
  rootId: string;
  field: string;
  expected: string | number | null;
  stored: string | number | null;
};

// ---- session_shares and session roots ----

export type SessionShareRow = {
  id: string;
  rootTaskId: string;
  /** NULL = everyone. */
  userId: string | null;
  access: "read" | "write";
  createdAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
};

export type NewSessionShare = {
  id: string;
  rootTaskId: string;
  userId: string | null;
  access: string;
  createdAt: string;
  actor: string | null;
};

export type TaskAncestorRow = {
  id: string;
  parentTaskId: string | null;
  requestedByUserId: string | null;
  scheduleId: string | null;
};

// ---- budgets, refusals, pricing ----

export type BudgetRow = {
  scope: string;
  scope_id: string;
  daily_budget_usd: number;
  createdAt: number;
  lastUpdatedAt: number;
};

export type BudgetRefusalNotificationRow = {
  task_id: string;
  date: string;
  agent_id: string;
  cause: string;
  agent_spend_usd: number | null;
  agent_budget_usd: number | null;
  global_spend_usd: number | null;
  global_budget_usd: number | null;
  user_spend_usd: number | null;
  user_budget_usd: number | null;
  follow_up_task_id: string | null;
  createdAt: number;
};

export type NewBudgetRefusalNotification = Omit<BudgetRefusalNotificationRow, "follow_up_task_id">;

export type PricingRowDb = {
  provider: string;
  model: string;
  token_class: string;
  effective_from: number;
  price_per_million_usd: number;
  createdAt: number;
  lastUpdatedAt: number;
};

export interface SessionsRepository {
  // ---- session_logs ----
  /** `lineNumber` of the newest stored line of `(sessionId, iteration)`, by insert order. */
  lastLogLineNumber(sessionId: string, iteration: number): Promise<number | null>;
  /** Inserts one line; `createdAt` is the engine's current time. */
  insertLog(log: NewSessionLog): Promise<void>;
  /**
   * Claude reasoning lines of a session written at or after `since`, with the
   * message id read from the content. Unordered: the caller indexes them by
   * `lineNumber`.
   */
  listClaudeReasoningLines(
    sessionId: string,
    since: string,
  ): Promise<{ id: string; lineNumber: number; messageId: string | null }[]>;
  markLogReasoningUpdate(id: string): Promise<void>;
  /** A task's lines in insert order; with `limit`, only the newest `limit` lines (still oldest first). */
  listLogsByTask(taskId: string, limit?: number): Promise<SessionLogRow[]>;
  /** One iteration's lines in insert order. */
  listLogsBySession(sessionId: string, iteration: number): Promise<SessionLogRow[]>;

  // ---- session_costs ----
  /**
   * The agent and the task row id of the active session registered under
   * `sessionId` (runner session id or active session id). `taskId` is null
   * when the session has no task row.
   */
  findActiveSessionIdentity(
    sessionId: string,
  ): Promise<{ agentId: string; taskId: string | null } | null>;
  /** The row whose id is `id`, else the oldest row of `sessionId` (then by id). */
  findSessionCostByIdOrSession(id: string, sessionId: string): Promise<SessionCostRow | null>;
  findSessionCostById(id: string): Promise<SessionCostRow | null>;
  /** Inserts once (`ON CONFLICT (id) DO NOTHING`); `createdAt` is the engine's current time. */
  insertSessionCost(cost: NewSessionCost): Promise<void>;
  /** Newest first; ties in insert order. */
  listSessionCostsByTask(taskId: string, limit: number): Promise<SessionCostRow[]>;
  /** Newest first; ties newest insert first. */
  listSessionCostsByAgent(agentId: string, limit: number): Promise<SessionCostRow[]>;
  /** Newest first; ties newest insert first. Dates are inclusive bounds on `createdAt`. */
  listSessionCosts(filter: SessionCostFilter): Promise<SessionCostRow[]>;
  // Cost summaries. A session's credential is its own; rows recorded before
  // migration 307 fall back to their task's credential.
  costSummaryTotals(filter: SessionCostSummaryFilter): Promise<SessionCostTotalsRow | null>;
  /** Per UTC day, oldest first. */
  costSummaryDaily(filter: SessionCostSummaryFilter): Promise<SessionCostDailySummaryRow[]>;
  /** Per agent, highest cost first; ties by agent id. */
  costSummaryByAgent(filter: SessionCostSummaryFilter): Promise<SessionCostAgentSummaryRow[]>;
  /** Per requester (null: no human requester), highest cost first; ties by user id, null first. */
  costSummaryByUser(filter: SessionCostSummaryFilter): Promise<SessionCostUserSummaryRow[]>;
  /** Per credential, highest cost first; ties by key type, then suffix, null first. */
  costSummaryByCredential(
    filter: SessionCostSummaryFilter,
  ): Promise<SessionCostCredentialSummaryRow[]>;
  /** Spend per known credential, by key type then suffix. */
  keyCostSummary(keyType?: string): Promise<KeyCostSummaryRow[]>;
  /** Spend since `startOfDay`, and since `startOfMonth`. */
  dashboardCost(
    startOfDay: string,
    startOfMonth: string,
  ): Promise<{ costToday: number; costMtd: number } | null>;
  /** Sum of `totalCostUsd` of an agent's sessions on a UTC day (`YYYY-MM-DD`). */
  dailySpendForAgent(agentId: string, dateUtc: string): Promise<number>;
  /** Sum of `totalCostUsd` of every session on a UTC day (`YYYY-MM-DD`). */
  dailySpendGlobal(dateUtc: string): Promise<number>;
  /** Sum of `totalCostUsd` of sessions whose task the user requested, on a UTC day. */
  dailySpendForUser(userId: string, dateUtc: string): Promise<number>;

  // ---- request_composition ----
  countRequestCompositionsByTask(taskId: string): Promise<number>;
  maxRequestCompositionSeq(sessionId: string): Promise<number | null>;
  insertRequestComposition(row: RequestCompositionRow): Promise<void>;
  /** Oldest first, then by seq; ties in insert order. */
  listRequestCompositionsByTask(taskId: string, limit: number): Promise<RequestCompositionRow[]>;
  /** The session's highest-seq `worker` manifest. */
  latestWorkerComposition(sessionId: string): Promise<RequestCompositionRow | null>;

  // ---- session summaries and members ----
  /** Deletes the `session_members` rows of every descendant of `taskId`. */
  dropSessionDescendants(taskId: string): Promise<void>;
  /**
   * Read-only drift check of the stored summaries and members against a fresh
   * chain walk. `terminalStatuses` are the task statuses that do not count as
   * open. Rows come in the order of the check's parts.
   */
  findSessionSummaryDrift(
    since: string | null,
    terminalStatuses: readonly string[],
  ): Promise<SessionSummaryDriftRow[]>;

  // ---- session_shares and session roots ----
  /**
   * The given tasks and every ancestor of them, each once (a parent cycle
   * ends). Unordered: the caller indexes them by id.
   */
  listTaskAncestors(taskIds: readonly string[]): Promise<TaskAncestorRow[]>;
  /** Access of the active shares of a root that name `userId` or everyone. Unordered. */
  listShareAccess(rootTaskId: string, userId: string | null): Promise<{ access: string }[]>;
  /** Active shares of a root, oldest first; ties in insert order. */
  listActiveShares(rootTaskId: string): Promise<SessionShareRow[]>;
  /** Every share row of a root, revoked ones included, oldest first; ties in insert order. */
  listShareHistory(rootTaskId: string): Promise<SessionShareRow[]>;
  revokeShare(id: string, now: string, actor: string | null): Promise<void>;
  insertShare(share: NewSessionShare): Promise<void>;

  // ---- session_tokens ----
  /** Whether `tokenId` is a task token of `agentId` minted by the given parent token or runtime. */
  hasChildTaskToken(
    tokenId: string,
    agentId: string,
    parent: { runtimeId: string } | { tokenId: string },
  ): Promise<boolean>;

  // ---- budgets ----
  findBudget(scope: string, scopeId: string): Promise<BudgetRow | null>;
  /** Ordered by scope, then scope id (the primary key). */
  listBudgets(): Promise<BudgetRow[]>;
  upsertBudget(scope: string, scopeId: string, dailyBudgetUsd: number, now: number): Promise<void>;
  deleteBudget(scope: string, scopeId: string): Promise<number>;

  // ---- budget_refusal_notifications ----
  /** Inserts unless `(task_id, date)` exists. Returns the number of rows inserted. */
  insertBudgetRefusalNotification(row: NewBudgetRefusalNotification): Promise<number>;
  findBudgetRefusalNotification(
    taskId: string,
    date: string,
  ): Promise<BudgetRefusalNotificationRow | null>;
  /** Newest first; ties in insert order. */
  listRecentBudgetRefusalNotifications(limit: number): Promise<BudgetRefusalNotificationRow[]>;
  hasBudgetRefusalNotification(taskId: string, date: string): Promise<boolean>;
  setBudgetRefusalFollowUpTaskId(
    taskId: string,
    date: string,
    followUpTaskId: string,
  ): Promise<void>;

  // ---- pricing ----
  /** Ordered by provider, model, token class, then newest `effective_from` (the primary key). */
  listPricingRows(): Promise<PricingRowDb[]>;
  /** One triple's rows, newest `effective_from` first. */
  listPricingRowsFor(provider: string, model: string, tokenClass: string): Promise<PricingRowDb[]>;
  /** The row with the largest `effective_from <= atEpochMs`. */
  findActivePricingRow(
    provider: string,
    model: string,
    tokenClass: string,
    atEpochMs: number,
  ): Promise<PricingRowDb | null>;
  /** Plain insert: a primary key collision throws. */
  insertPricingRow(row: PricingRowDb): Promise<void>;
  /** Keeps the newest `keepLatest` rows of each triple; returns the rows deleted. */
  prunePricingHistory(keepLatest: number): Promise<number>;
  deletePricingRow(
    provider: string,
    model: string,
    tokenClass: string,
    effectiveFrom: number,
  ): Promise<number>;
}

const PRICING_COLUMNS = sql`provider, model, token_class, effective_from, price_per_million_usd, "createdAt", "lastUpdatedAt"`;
const COMPOSITION_COLUMNS = sql`id, "taskId", "agentId", "sessionId", seq, provider, model, source, parts, "staticEstTokens", "tokenRatio", "createdAt"`;

export abstract class BaseSessionsRepository implements SessionsRepository {
  constructor(protected readonly db: SqlExecutor) {}

  // ---- session_logs ----

  /** "Newest by insert order" needs the engine's insert sequence. */
  abstract lastLogLineNumber(sessionId: string, iteration: number): Promise<number | null>;

  async insertLog(log: NewSessionLog): Promise<void> {
    await this.db.run(sql`
      INSERT INTO session_logs (id, "taskId", "sessionId", iteration, cli, content, "lineNumber", "createdAt", "reasoningChars", "reasoningKind")
      VALUES (${log.id}, ${log.taskId}, ${log.sessionId}, ${log.iteration}, ${log.cli}, ${log.content}, ${log.lineNumber}, ${nowIso}, ${log.reasoningChars}, ${log.reasoningKind})`);
  }

  /** JSON extraction and the index hint are engine-specific. */
  abstract listClaudeReasoningLines(
    sessionId: string,
    since: string,
  ): Promise<{ id: string; lineNumber: number; messageId: string | null }[]>;

  async markLogReasoningUpdate(id: string): Promise<void> {
    await this.db.run(sql`UPDATE session_logs SET "reasoningKind" = 'update' WHERE id = ${id}`);
  }

  /** Insert order needs the engine's insert sequence. */
  abstract listLogsByTask(taskId: string, limit?: number): Promise<SessionLogRow[]>;
  abstract listLogsBySession(sessionId: string, iteration: number): Promise<SessionLogRow[]>;

  // ---- session_costs ----

  findActiveSessionIdentity(
    sessionId: string,
  ): Promise<{ agentId: string; taskId: string | null } | null> {
    return this.db.get(sql`
      SELECT a."agentId", t.id AS "taskId" FROM active_sessions a
      LEFT JOIN agent_tasks t ON t.id = a."taskId"
      WHERE a."runnerSessionId" = ${sessionId} OR a.id = ${sessionId} LIMIT 1`);
  }

  findSessionCostByIdOrSession(id: string, sessionId: string): Promise<SessionCostRow | null> {
    return this.db.get<SessionCostRow>(sql`
      SELECT * FROM session_costs WHERE id = ${id} OR "sessionId" = ${sessionId}
      ORDER BY CASE WHEN id = ${id} THEN 0 ELSE 1 END, "createdAt", id LIMIT 1`);
  }

  findSessionCostById(id: string): Promise<SessionCostRow | null> {
    return this.db.get<SessionCostRow>(sql`SELECT * FROM session_costs WHERE id = ${id}`);
  }

  async insertSessionCost(cost: NewSessionCost): Promise<void> {
    await this.db.run(sql`
      INSERT INTO session_costs (
        id, "sessionId", "taskId", "agentId",
        "totalCostUsd", "inputTokens", "outputTokens",
        "cacheReadTokens", "cacheWriteTokens",
        "reasoningOutputTokens", "thinkingTokens",
        "durationMs", "numTurns", model, "isError",
        "costSource", "harnessCostUsd", "cacheWrite5mTokens", "cacheWrite1hTokens",
        "modelBreakdown", "credentialKeyType", "credentialKeySuffix", harness, kind, "createdAt"
      )
      VALUES (
        ${cost.id}, ${cost.sessionId}, ${cost.taskId}, ${cost.agentId},
        ${cost.totalCostUsd}, ${cost.inputTokens}, ${cost.outputTokens},
        ${cost.cacheReadTokens}, ${cost.cacheWriteTokens},
        ${cost.reasoningOutputTokens}, ${cost.thinkingTokens},
        ${cost.durationMs}, ${cost.numTurns}, ${cost.model}, ${cost.isError},
        ${cost.costSource}, ${cost.harnessCostUsd}, ${cost.cacheWrite5mTokens}, ${cost.cacheWrite1hTokens},
        ${cost.modelBreakdown}, ${cost.credentialKeyType}, ${cost.credentialKeySuffix}, ${cost.harness}, ${cost.kind}, ${nowIso}
      )
      ON CONFLICT (id) DO NOTHING`);
  }

  /** The tie order follows the engine's insert sequence. */
  abstract listSessionCostsByTask(taskId: string, limit: number): Promise<SessionCostRow[]>;
  abstract listSessionCostsByAgent(agentId: string, limit: number): Promise<SessionCostRow[]>;
  abstract listSessionCosts(filter: SessionCostFilter): Promise<SessionCostRow[]>;

  protected sessionCostFilter(filter: SessionCostFilter): SqlQuery {
    return sqlWhere([
      filter.agentId ? sql`"agentId" = ${filter.agentId}` : sql``,
      filter.startDate ? sql`"createdAt" >= ${filter.startDate}` : sql``,
      filter.endDate ? sql`"createdAt" <= ${filter.endDate}` : sql``,
    ]);
  }

  /** Index hints, the UTC day and the migration-307 fallback are engine-specific. */
  abstract costSummaryTotals(
    filter: SessionCostSummaryFilter,
  ): Promise<SessionCostTotalsRow | null>;
  abstract costSummaryDaily(
    filter: SessionCostSummaryFilter,
  ): Promise<SessionCostDailySummaryRow[]>;
  abstract costSummaryByAgent(
    filter: SessionCostSummaryFilter,
  ): Promise<SessionCostAgentSummaryRow[]>;
  abstract costSummaryByUser(
    filter: SessionCostSummaryFilter,
  ): Promise<SessionCostUserSummaryRow[]>;
  abstract costSummaryByCredential(
    filter: SessionCostSummaryFilter,
  ): Promise<SessionCostCredentialSummaryRow[]>;
  abstract keyCostSummary(keyType?: string): Promise<KeyCostSummaryRow[]>;

  dashboardCost(
    startOfDay: string,
    startOfMonth: string,
  ): Promise<{ costToday: number; costMtd: number } | null> {
    return this.db.get(sql`
      SELECT
        COALESCE(SUM(CASE WHEN "createdAt" >= ${startOfDay} THEN "totalCostUsd" ELSE 0 END), 0) AS "costToday",
        COALESCE(SUM("totalCostUsd"), 0) AS "costMtd"
      FROM session_costs
      WHERE "createdAt" >= ${startOfMonth}`);
  }

  /** The UTC day of a timestamp column is engine-specific. */
  abstract dailySpendForAgent(agentId: string, dateUtc: string): Promise<number>;
  abstract dailySpendGlobal(dateUtc: string): Promise<number>;
  abstract dailySpendForUser(userId: string, dateUtc: string): Promise<number>;

  // ---- request_composition ----

  async countRequestCompositionsByTask(taskId: string): Promise<number> {
    const row = await this.db.get<{ count: number | string }>(
      sql`SELECT COUNT(*) AS count FROM request_composition WHERE "taskId" = ${taskId}`,
    );
    return Number(row?.count ?? 0);
  }

  async maxRequestCompositionSeq(sessionId: string): Promise<number | null> {
    const row = await this.db.get<{ seq: number | string | null }>(
      sql`SELECT MAX(seq) AS seq FROM request_composition WHERE "sessionId" = ${sessionId}`,
    );
    return row?.seq == null ? null : Number(row.seq);
  }

  async insertRequestComposition(row: RequestCompositionRow): Promise<void> {
    await this.db.run(sql`
      INSERT INTO request_composition (${COMPOSITION_COLUMNS})
      VALUES (${row.id}, ${row.taskId}, ${row.agentId}, ${row.sessionId}, ${row.seq}, ${row.provider},
        ${row.model}, ${row.source}, ${row.parts}, ${row.staticEstTokens}, ${row.tokenRatio}, ${row.createdAt})`);
  }

  /** The tie order follows the engine's insert sequence. */
  abstract listRequestCompositionsByTask(
    taskId: string,
    limit: number,
  ): Promise<RequestCompositionRow[]>;

  latestWorkerComposition(sessionId: string): Promise<RequestCompositionRow | null> {
    return this.db.get<RequestCompositionRow>(sql`
      SELECT ${COMPOSITION_COLUMNS} FROM request_composition
      WHERE "sessionId" = ${sessionId} AND source = 'worker'
      ORDER BY seq DESC LIMIT 1`);
  }

  // ---- session summaries and members ----

  async dropSessionDescendants(taskId: string): Promise<void> {
    // UNION, not UNION ALL: a parentTaskId cycle written before migration 253
    // must not loop.
    await this.db.run(sql`
      WITH RECURSIVE descendant(id) AS (
        SELECT id FROM agent_tasks WHERE "parentTaskId" = ${taskId}
        UNION SELECT t.id FROM descendant d JOIN agent_tasks t ON t."parentTaskId" = d.id
      ) DELETE FROM session_members WHERE "taskId" IN (SELECT id FROM descendant)`);
  }

  /** Uses value `IS NOT` comparisons and boolean sums (SQLite forms). */
  abstract findSessionSummaryDrift(
    since: string | null,
    terminalStatuses: readonly string[],
  ): Promise<SessionSummaryDriftRow[]>;

  // ---- session_shares and session roots ----

  /** Recursive walk with a join-order hint (CROSS JOIN) on SQLite. */
  abstract listTaskAncestors(taskIds: readonly string[]): Promise<TaskAncestorRow[]>;

  listShareAccess(rootTaskId: string, userId: string | null): Promise<{ access: string }[]> {
    return this.db.query<{ access: string }>(sql`
      SELECT access FROM session_shares
      WHERE "rootTaskId" = ${rootTaskId} AND "revokedAt" IS NULL AND ("userId" IS NULL OR "userId" = ${userId})`);
  }

  /** Insert order needs the engine's insert sequence. */
  abstract listActiveShares(rootTaskId: string): Promise<SessionShareRow[]>;
  abstract listShareHistory(rootTaskId: string): Promise<SessionShareRow[]>;

  async revokeShare(id: string, now: string, actor: string | null): Promise<void> {
    await this.db.run(sql`
      UPDATE session_shares SET "revokedAt" = ${now}, "revokedBy" = ${actor}, updated_by = ${actor}
      WHERE id = ${id}`);
  }

  async insertShare(share: NewSessionShare): Promise<void> {
    await this.db.run(sql`
      INSERT INTO session_shares (id, "rootTaskId", "userId", access, "createdAt", created_by, updated_by)
      VALUES (${share.id}, ${share.rootTaskId}, ${share.userId}, ${share.access}, ${share.createdAt}, ${share.actor}, ${share.actor})`);
  }

  // ---- session_tokens ----

  async hasChildTaskToken(
    tokenId: string,
    agentId: string,
    parent: { runtimeId: string } | { tokenId: string },
  ): Promise<boolean> {
    const parentMatch =
      "runtimeId" in parent
        ? sql`"parentRuntimeId" = ${parent.runtimeId}`
        : sql`"parentTokenId" = ${parent.tokenId}`;
    const row = await this.db.get<{ id: string }>(sql`
      SELECT id FROM session_tokens WHERE id = ${tokenId} AND "agentId" = ${agentId} AND "taskId" IS NOT NULL
      AND ${parentMatch}`);
    return row !== null;
  }

  // ---- budgets ----

  findBudget(scope: string, scopeId: string): Promise<BudgetRow | null> {
    return this.db.get<BudgetRow>(sql`
      SELECT scope, scope_id, daily_budget_usd, "createdAt", "lastUpdatedAt" FROM budgets
      WHERE scope = ${scope} AND scope_id = ${scopeId}`);
  }

  listBudgets(): Promise<BudgetRow[]> {
    return this.db.query<BudgetRow>(sql`
      SELECT scope, scope_id, daily_budget_usd, "createdAt", "lastUpdatedAt" FROM budgets
      ORDER BY scope, scope_id`);
  }

  async upsertBudget(
    scope: string,
    scopeId: string,
    dailyBudgetUsd: number,
    now: number,
  ): Promise<void> {
    await this.db.run(sql`
      INSERT INTO budgets (scope, scope_id, daily_budget_usd, "createdAt", "lastUpdatedAt")
      VALUES (${scope}, ${scopeId}, ${dailyBudgetUsd}, ${now}, ${now})
      ON CONFLICT (scope, scope_id) DO UPDATE SET
        daily_budget_usd = excluded.daily_budget_usd,
        "lastUpdatedAt" = excluded."lastUpdatedAt"`);
  }

  async deleteBudget(scope: string, scopeId: string): Promise<number> {
    const result = await this.db.run(
      sql`DELETE FROM budgets WHERE scope = ${scope} AND scope_id = ${scopeId}`,
    );
    return result.changes;
  }

  // ---- budget_refusal_notifications ----

  /** `INSERT OR IGNORE` also ignores CHECK and NOT NULL failures: kept per engine. */
  abstract insertBudgetRefusalNotification(row: NewBudgetRefusalNotification): Promise<number>;

  findBudgetRefusalNotification(
    taskId: string,
    date: string,
  ): Promise<BudgetRefusalNotificationRow | null> {
    return this.db.get<BudgetRefusalNotificationRow>(sql`
      SELECT * FROM budget_refusal_notifications WHERE task_id = ${taskId} AND date = ${date}`);
  }

  /** The tie order follows the engine's insert sequence. */
  abstract listRecentBudgetRefusalNotifications(
    limit: number,
  ): Promise<BudgetRefusalNotificationRow[]>;

  async hasBudgetRefusalNotification(taskId: string, date: string): Promise<boolean> {
    const row = await this.db.get<{ one: number }>(sql`
      SELECT 1 AS one FROM budget_refusal_notifications
      WHERE task_id = ${taskId} AND date = ${date} LIMIT 1`);
    return row !== null;
  }

  async setBudgetRefusalFollowUpTaskId(
    taskId: string,
    date: string,
    followUpTaskId: string,
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE budget_refusal_notifications SET follow_up_task_id = ${followUpTaskId}
      WHERE task_id = ${taskId} AND date = ${date}`);
  }

  // ---- pricing ----

  listPricingRows(): Promise<PricingRowDb[]> {
    return this.db.query<PricingRowDb>(sql`
      SELECT ${PRICING_COLUMNS} FROM pricing
      ORDER BY provider, model, token_class, effective_from DESC`);
  }

  listPricingRowsFor(provider: string, model: string, tokenClass: string): Promise<PricingRowDb[]> {
    return this.db.query<PricingRowDb>(sql`
      SELECT ${PRICING_COLUMNS} FROM pricing
      WHERE provider = ${provider} AND model = ${model} AND token_class = ${tokenClass}
      ORDER BY effective_from DESC`);
  }

  findActivePricingRow(
    provider: string,
    model: string,
    tokenClass: string,
    atEpochMs: number,
  ): Promise<PricingRowDb | null> {
    return this.db.get<PricingRowDb>(sql`
      SELECT ${PRICING_COLUMNS} FROM pricing
      WHERE provider = ${provider} AND model = ${model} AND token_class = ${tokenClass}
        AND effective_from <= ${atEpochMs}
      ORDER BY effective_from DESC LIMIT 1`);
  }

  async insertPricingRow(row: PricingRowDb): Promise<void> {
    await this.db.run(sql`
      INSERT INTO pricing (${PRICING_COLUMNS})
      VALUES (${row.provider}, ${row.model}, ${row.token_class}, ${row.effective_from},
        ${row.price_per_million_usd}, ${row.createdAt}, ${row.lastUpdatedAt})`);
  }

  async prunePricingHistory(keepLatest: number): Promise<number> {
    // effective_from is part of the primary key, so the rank inside a triple is total.
    const result = await this.db.run(sql`
      DELETE FROM pricing
      WHERE (provider, model, token_class, effective_from) IN (
        SELECT provider, model, token_class, effective_from
        FROM (
          SELECT provider, model, token_class, effective_from,
            ROW_NUMBER() OVER (
              PARTITION BY provider, model, token_class
              ORDER BY effective_from DESC
            ) AS rn
          FROM pricing
        ) ranked
        WHERE rn > ${keepLatest}
      )`);
    return result.changes;
  }

  async deletePricingRow(
    provider: string,
    model: string,
    tokenClass: string,
    effectiveFrom: number,
  ): Promise<number> {
    const result = await this.db.run(sql`
      DELETE FROM pricing
      WHERE provider = ${provider} AND model = ${model} AND token_class = ${tokenClass}
        AND effective_from = ${effectiveFrom}`);
    return result.changes;
  }
}
