import { nowIso } from "../dialect";
import type { SqlExecutor } from "../executor";
import { EMPTY, type SqlQuery, sql, sqlIdent, sqlList, sqlWhere } from "../sql";
import type { TaskRow } from "./tasks";

/** One task of a root chain (`t.*`) with the summed session cost of that task. */
export type TaskChainRow = Omit<TaskRow, "totalCostUsd"> & { totalCostUsd: number | null };

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

// ---- tool_call_intents ----

export type ToolCallIntentRow = {
  id: string;
  taskId: string;
  agentId: string | null;
  toolCallId: string;
  toolName: string;
  argsSummary: string | null;
  createdAt: string;
};

export type NewToolCallIntent = Omit<ToolCallIntentRow, "createdAt">;

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

/** The most rows `listKeyWindowUsageRows` reads before it stops (it returns one more). */
export const KEY_WINDOW_USAGE_MAX_ROWS = 100_000;

/** One session of a credential window usage read (see `listKeyWindowUsageRows`). */
export type KeyWindowUsageRow = {
  taskId: string | null;
  credentialKeyType: string | null;
  credentialKeySuffix: string | null;
  harness: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningOutputTokens: number;
  thinkingTokens: number;
  model: string;
  modelBreakdown: string | null;
  isError: number;
  createdAt: string;
  finishedAt: string | null;
};

export type PricingRowDb = {
  provider: string;
  model: string;
  token_class: string;
  effective_from: number;
  price_per_million_usd: number;
  createdAt: number;
  lastUpdatedAt: number;
};

// ---- session tree (session_summaries roots, inbox_item_state, session_shares, session_members) ----

/** A `[lo, hi)` range of canonical asset keys. */
export type SessionKeyRange = { lo: string; hi: string };
export type SessionSourceRange = SessionKeyRange & { source: string };

/**
 * The key and status rules the session tree SQL applies, resolved by the
 * caller (the asset key grammar lives in the application).
 */
export type SessionTreeRules = {
  /** The `shared/<source>/` key range of each session source. */
  sourceRanges: readonly SessionSourceRange[];
  /** A source thread with at least this many owned roots nests as its own group. */
  nestedThreadMinRoots: number;
  /** Terminal task statuses. Plain lower-case words: written into the SQL as literals. */
  terminalStatuses: readonly string[];
  /** Task sources agents and the server create. Plain lower-case words, written as literals. */
  agentTaskSources: readonly string[];
  /** Root sources a machine starts. */
  machineSources: readonly string[];
  /** `system` task types a person starts. */
  humanSystemTaskTypes: readonly string[];
};

/** One group's roots: the group key itself and its direct resource leaves. */
export type SessionGroupSpec = SessionKeyRange & {
  /** Keep the key index out of the range: a broad prefix reads faster as one pass. */
  scan: boolean;
  /** 1-based code point position right after the group prefix. */
  start: number;
  /** GLOB patterns a direct leaf segment matches (`<kind>:?*` + `/`). */
  leafPatterns: readonly string[];
};

/** The roots the Inbox holds: the source and resource key ranges, plus No group. */
export type SessionInboxScope = {
  ranges: readonly SessionKeyRange[];
  noGroup: readonly SessionGroupSpec[];
};

/** Session-list visibility: see `sessionViewerSql`. */
export type SessionViewerSpec = {
  userId: string | null;
  scope: "all" | "mine" | "shared";
  readAll?: boolean;
};

/** Conditions on a session root `r` (a `session_summaries` row or a root task). */
export type SessionRootFilterSpec = {
  /** Schedule runs pass the shown-source, tree-owner and Mine conditions. */
  includeScheduleRuns?: boolean;
  rootId?: string;
  /** An empty list matches no root. */
  rootIds?: readonly string[];
  exceptRootIds?: readonly string[];
  /** Raw task sources. */
  sources?: readonly string[];
  /** Effective sources to leave out. */
  hideSources?: readonly string[];
  /** Effective sources to keep; an empty list matches no root. */
  showSources?: readonly string[];
  /** Lower-case `%text%` matched against the root task text and title. */
  textLike?: string;
  requestedByUserId?: string;
  /** LIKE pattern on `contextKey`, escaped with backslash. */
  contextKeyPattern?: string;
  viewer?: SessionViewerSpec;
  /** With a viewer: owned roots only. */
  tree?: boolean;
  /** With a viewer: the Mine view. */
  mine?: boolean;
  keyRange?: SessionKeyRange;
  keyRanges?: readonly SessionKeyRange[];
  group?: SessionGroupSpec;
  /** No group: any of these groups. */
  noGroup?: readonly SessionGroupSpec[];
  /** Triage inbox or working: roots in the Inbox scope. */
  inbox?: SessionInboxScope;
  /** Triage later or done: the user's marked roots, or (`orInbox`) auto-Done Inbox roots. */
  marked?: { triage: "later" | "done"; userId: string | null; orInbox?: SessionInboxScope };
};

/** The viewer read-state rule's bound times. */
export type SessionReadStateSpec = {
  now: string;
  /** Activity after this reads unread on a root with no triage row. */
  unreadSince: string;
  /** Auto-Done quiet bound: last activity and triage write at or before it. */
  quietBefore: string;
  inbox: SessionInboxScope;
};

/** One row per visible session root, filtered after aggregation. */
export type SessionSummarySpec = {
  root: SessionRootFilterSpec;
  /** The viewer's read state; NULL readState without it. */
  read?: SessionReadStateSpec;
  viewerUserId: string | null;
  withUserId?: string;
  triage?: "inbox" | "working" | "later" | "done" | "unread";
  status?: "running" | "failed" | "needs";
  /** Leave the viewer's Later and Done rows out (a group list). */
  excludesTriaged?: boolean;
};

export type SessionPageMemberRow = {
  root_id: string;
  id: string | null;
  name: string | null;
  preview: string | null;
};

export type SessionPageShareRow = {
  root_id: string;
  id: string | null;
  name: string | null;
  access: "read" | "write";
};

export type SessionTreeRow = {
  root_id: string;
  key: string;
  source: string;
  slackChannelId: string | null;
  lastActivityAt: string;
  latestStatus: string;
  readState: string | null;
  needsYou: number;
  scheduleId: string | null;
  defaultVisible: number;
};

export type SessionThreadLabelRow = { key: string; title: string | null; prompt: string };

/** One triage write applied to every root of a list. */
export type SessionListTriageWrite = {
  userId: string;
  status: "done" | "open";
  doneAt: string | null;
  readAt: string | null;
  now: string;
  /** Move the read cursor: to each root's newest activity, or to a fixed time. Omitted: keep it. */
  lastReadAt?: { kind: "activity" } | { kind: "value"; value: string };
};

/** Resource kinds a session group names (`getResourceSessionLabels`). */
export type SessionResourceKind = "page" | "workflow" | "schedule" | "app" | "script" | "fs";

// ---- session_tokens ----

export type NewSessionToken = {
  id: string;
  tokenHash: string;
  tokenPreview: string;
  agentId: string;
  taskId: string | null;
  runtimeId: string | null;
  parentRuntimeId: string | null;
  expiresAt: string;
  createdAt: string;
  controllerId: string | null;
  parentTokenId: string | null;
  scriptRun: boolean;
};

/** A session token by hash, with its controller's placement. */
export type SessionTokenLookupRow = {
  id: string;
  agentId: string;
  taskId: string | null;
  runtimeId: string | null;
  controllerId: string | null;
  placement: string | null;
  expiresAt: string;
  revokedAt: string | null;
  sourceStepId: string | null;
  sourceScriptRunId: string | null;
  objectChain: string | null;
  depth: number;
};

export type SourceBackfillRootRow = {
  id: string;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  contextKey: string | null;
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
  /** Points a runner session's lines at `taskId`; lines with no task stay. Returns rows changed. */
  reassignLogsToTask(sessionId: string, taskId: string): Promise<number>;
  /**
   * Every task of the chain rooted at `rootTaskId` (whole `agent_tasks` rows)
   * with the sum of its session costs as `totalCostUsd`, oldest first; ties
   * in insert order.
   */
  listChainWithCosts(rootTaskId: string): Promise<TaskChainRow[]>;
  /** A task's lines in insert order; with `limit`, only the newest `limit` lines (still oldest first). */
  listLogsByTask(taskId: string, limit?: number): Promise<SessionLogRow[]>;
  /** One iteration's lines in insert order. */
  listLogsBySession(sessionId: string, iteration: number): Promise<SessionLogRow[]>;

  // ---- tool_call_intents ----
  /**
   * Inserts once per `(taskId, toolCallId)`: a retried insert keeps the first
   * row. `createdAt` is the engine's current time. Returns the stored row.
   */
  insertToolCallIntent(intent: NewToolCallIntent): Promise<ToolCallIntentRow | null>;
  /** Deletes the intent of one call; returns the number of rows deleted. */
  deleteToolCallIntent(taskId: string, toolCallId: string): Promise<number>;
  /** A task's intents, oldest first (ties by id), at most `limit`. */
  listToolCallIntents(taskId: string, limit: number): Promise<ToolCallIntentRow[]>;

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
  /**
   * The sessions of the given credentials in [start, through): the receipt rows
   * created in the range, the older rows of tasks completed in the range, and
   * one marker row (credential null) per harness session without a credential.
   * At most `KEY_WINDOW_USAGE_MAX_ROWS + 1` rows; the caller rejects more.
   * Unordered: the caller groups and sorts what it needs.
   */
  listKeyWindowUsageRows(
    credentials: { keyType: string; keySuffix: string }[],
    start: string,
    through: string,
  ): Promise<KeyWindowUsageRow[]>;

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
  /**
   * Inserts one boot-seed rate at `effective_from` 0 (createdAt and
   * lastUpdatedAt 0); a row already there is kept. Returns true when inserted.
   */
  insertPricingSeedRow(
    provider: string,
    model: string,
    tokenClass: string,
    pricePerMillionUsd: number,
  ): Promise<boolean>;
  /** Keeps the newest `keepLatest` rows of each triple; returns the rows deleted. */
  prunePricingHistory(keepLatest: number): Promise<number>;
  deletePricingRow(
    provider: string,
    model: string,
    tokenClass: string,
    effectiveFrom: number,
  ): Promise<number>;
  /** Sets the price and lastUpdatedAt of one pricing row (the triple at `effectiveFrom`). */
  updatePricingPrice(
    provider: string,
    model: string,
    tokenClass: string,
    effectiveFrom: number,
    pricePerMillionUsd: number,
    now: number,
  ): Promise<void>;
  // ---- session tree ----
  /**
   * Owned roots at the source thread key of the root `r` (0 off a thread
   * key), as a correlated SQL expression.
   */
  sessionThreadRootsSql(rules: SessionTreeRules): SqlQuery;
  /** The root conditions as one SQL condition on `r` (`1` when none). */
  sessionRootFilterSql(rules: SessionTreeRules, spec: SessionRootFilterSpec): SqlQuery;
  /**
   * One row per visible session root over `session_summaries`, with its chain
   * aggregates, read state and `needsYou` (a SELECT to wrap; rows unordered).
   */
  sessionSummarySql(rules: SessionTreeRules, spec: SessionSummarySpec): SqlQuery;
  /** The chain walk {@link sessionSummarySql} replaces (tests compare the two). */
  legacySessionSummarySql(rules: SessionTreeRules, spec: SessionSummarySpec): SqlQuery;
  /** `SELECT COUNT(*) AS count`: over the summaries when `chain`, else over the root filter. */
  sessionCountSql(rules: SessionTreeRules, spec: SessionSummarySpec, chain: boolean): SqlQuery;
  /** The count {@link sessionCountSql} selects. */
  countSessions(rules: SessionTreeRules, spec: SessionSummarySpec, chain: boolean): Promise<number>;
  /** Owned roots per source thread key. Unordered: the caller indexes them by key. */
  listThreadRootCounts(rules: SessionTreeRules): Promise<{ key: string; threadRoots: number }[]>;
  /** {@link sessionThreadRootsSql} of one task, or null without the task. */
  findTaskThreadRoots(rules: SessionTreeRules, taskId: string): Promise<number | null>;
  /** Read state and last activity of the one root the spec matches. */
  findSessionReadState(
    rules: SessionTreeRules,
    spec: SessionSummarySpec,
  ): Promise<{ readState: string | null; lastActivityAt: string } | null>;
  /** True when any session row of the summary has read state `read`. */
  hasReadSession(rules: SessionTreeRules, spec: SessionSummarySpec): Promise<boolean>;
  /**
   * One page of the session list: the summary rows paged first, then each page
   * root's `agent_tasks` row (`r.*`) with the summary columns as `__chainCount`,
   * `__lastActivityAt`, `__latestStatus`, `__readState`, `__snoozeUntil`,
   * `__needsYou` and `__threadRoots`. Order: with `snoozeFirst`, snooze time
   * ascending (no snooze first); then last activity, root creation and root id,
   * each descending.
   */
  listSessionPage<T>(
    rules: SessionTreeRules,
    spec: SessionSummarySpec,
    page: { snoozeFirst: boolean; limit: number; offset: number },
  ): Promise<T[]>;
  /**
   * Chain tasks of the roots with requester name and output preview, newest
   * activity first, then newest created, then id descending.
   */
  listSessionPageMembers(rootIds: readonly string[]): Promise<SessionPageMemberRow[]>;
  /** Active shares of the roots with the user name, oldest first, then id. */
  listSessionPageShares(rootIds: readonly string[]): Promise<SessionPageShareRow[]>;
  /**
   * Summary rows of the tree with each root's schedule and whether the default
   * owner (and, with `mine`, Mine) rule shows it. `visibleRule` null: every row is
   * visible. Unordered: the caller aggregates them.
   */
  listSessionTreeRows(
    rules: SessionTreeRules,
    spec: SessionSummarySpec,
    visibleRule: { mine: boolean; userId: string | null; readAll?: boolean } | null,
  ): Promise<SessionTreeRow[]>;
  /**
   * The oldest root (created time, then insert order) of each key among the
   * given roots: its trimmed title and its prompt without the first thread
   * context block, cut to `promptChars`. Unordered: one row per key.
   */
  listThreadLabels(
    rootIds: readonly string[],
    promptChars: number,
  ): Promise<SessionThreadLabelRow[]>;
  /** Upsert the user's triage row of every root the spec matches. Returns the rows written. */
  triageSessionList(
    rules: SessionTreeRules,
    spec: SessionSummarySpec,
    write: SessionListTriageWrite,
  ): Promise<number>;

  // ---- session moves ----
  /**
   * File mappings attached to a task: those sourced by one of its attachments,
   * and those with no attachment source. Unordered (DISTINCT, as before).
   */
  listTaskAttachmentMappings(taskId: string): Promise<{ id: string; key: string }[]>;
  /** Set a task's namespace key; `lastUpdatedAt` stays (it tracks activity). */
  setTaskKey(taskId: string, key: string, changedBy: string | null): Promise<void>;
  setAssetMappingKey(id: string, key: string, now: string, changedBy: string | null): Promise<void>;
  /**
   * Point `key` and `hidden-key` favorites in `[range.lo, range.hi)` at `to` +
   * the rest of the item id; a principal that already has the new item keeps
   * it and the old row goes. `scope` limits it to one favorite scope.
   */
  moveKeyFavorites(range: SessionKeyRange, to: string, scope?: string): Promise<void>;
  /** Root tasks in a key range (optionally of one requester), ordered by id. */
  listPrefixRoots(filter: {
    range: SessionKeyRange;
    userId?: string | null;
    limit: number;
    offset: number;
  }): Promise<{ id: string; key: string }[]>;
  /** Root task ids in a key range visible to the viewer, ordered by id. */
  listVisiblePrefixRoots(
    range: SessionKeyRange,
    viewer: SessionViewerSpec,
  ): Promise<{ id: string }[]>;
  /** A task's key and parent, or null. */
  findTaskKeyAndParent(
    taskId: string,
  ): Promise<{ key: string; parentTaskId: string | null } | null>;
  /** The task and all its descendants, each once. Unordered. */
  listChainTaskIds(rootId: string): Promise<string[]>;
  /**
   * Source-key backfill batch: root tasks after `afterId` whose key is still
   * the default (`shared/` or `shared/task:<lower id>/`) and that came from a
   * Slack thread or a chat-sdk context. Ordered by id, at most `limit`.
   */
  listSourceBackfillRoots(afterId: string, limit: number): Promise<SourceBackfillRootRow[]>;

  // ---- session labels ----
  /** Live (`expires_at` NULL or after `nowMs`) kv values of the keys. Unordered. */
  listLiveKvValues(
    namespace: string,
    keys: readonly string[],
    nowMs: number,
  ): Promise<{ key: string; value: string }[]>;
  /** Lower-cased id and trimmed name (NULL when empty) of the resources. Unordered. */
  listResourceNames(
    kind: SessionResourceKind,
    ids: readonly string[],
  ): Promise<{ id: string; name: string | null }[]>;

  // ---- session_tokens (minting, revocation, resolution) ----
  /**
   * Expiry of a live (unrevoked, `expiresAt > now`) parent token of `agentId`:
   * bound to `runtimeId`, or (runtimeId null) an agent token with no binding.
   */
  findLiveParentTokenExpiry(
    tokenId: string,
    agentId: string,
    runtimeId: string | null,
    now: string,
  ): Promise<string | null>;
  insertSessionToken(token: NewSessionToken): Promise<void>;
  setSessionTokenProvenance(
    tokenId: string,
    provenance: {
      sourceStepId: string | null;
      sourceScriptRunId: string | null;
      objectChain: string | null;
      depth: number;
    },
  ): Promise<void>;
  /** The token's `scriptRun` flag (0/1), or null without the token. */
  findSessionTokenScriptRun(tokenId: string): Promise<number | null>;
  /** The token's runtime binding, or null without the token. */
  findSessionTokenRuntime(tokenId: string): Promise<{ runtimeId: string | null } | null>;
  /** Ids of tokens minted by any of the parent tokens. Unordered. */
  listChildSessionTokenIds(parentTokenIds: readonly string[]): Promise<string[]>;
  /** Stamp `revokedAt` on the unrevoked tokens among `ids`. */
  revokeSessionTokens(ids: readonly string[], now: string): Promise<void>;
  /** Ids of the tokens bound to, or minted for, a runtime (revoked ones too). Unordered. */
  listRuntimeSessionTokenIds(runtimeId: string): Promise<string[]>;
  /** Stamp `revokedAt` on the unrevoked tokens bound to, or minted for, a runtime. */
  revokeRuntimeSessionTokens(runtimeId: string, now: string): Promise<void>;
  /** Live agent (worker) tokens of `agentId`: no binding, not a script run. Unordered. */
  listActiveAgentTokenIds(agentId: string, now: string): Promise<string[]>;
  /** Cut the expiry of the tokens and their children to `expiresAt` where it is later. */
  expireSessionTokensWithChildren(ids: readonly string[], expiresAt: string): Promise<void>;
  /** Unrevoked tokens that authenticate as `agentId` (not controller tokens). Unordered. */
  listUnrevokedAgentSessionTokenIds(agentId: string): Promise<string[]>;
  findSessionTokenByHash(tokenHash: string): Promise<SessionTokenLookupRow | null>;
  touchSessionToken(id: string, now: string): Promise<void>;
}

/** The table and name column of each resource kind a session group can name. */
const RESOURCE_NAMES: Record<SessionResourceKind, { table: string; column: string }> = {
  page: { table: "pages", column: "title" },
  workflow: { table: "workflows", column: "name" },
  schedule: { table: "scheduled_tasks", column: "name" },
  app: { table: "apps", column: "name" },
  script: { table: "scripts", column: "name" },
  fs: { table: "asset_key_mappings", column: "provider_key" },
};

/**
 * An agent (worker) token: bound to its agent and nothing else. A false `scriptRun`
 * leaves out a script run's ephemeral token (same all-null binding shape).
 */
const AGENT_TOKEN_BINDING = sql`"taskId" IS NULL AND "runtimeId" IS NULL AND "controllerId" IS NULL AND "parentRuntimeId" IS NULL AND "scriptRun" = ${false}`;

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

  async reassignLogsToTask(sessionId: string, taskId: string): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE session_logs SET "taskId" = ${taskId} WHERE "sessionId" = ${sessionId} AND "taskId" != ${taskId}`);
    return result.changes;
  }

  /** Insert order and the join-order hint are engine-specific. */
  abstract listChainWithCosts(rootTaskId: string): Promise<TaskChainRow[]>;

  /** Insert order needs the engine's insert sequence. */
  abstract listLogsByTask(taskId: string, limit?: number): Promise<SessionLogRow[]>;
  abstract listLogsBySession(sessionId: string, iteration: number): Promise<SessionLogRow[]>;

  // ---- tool_call_intents ----

  async insertToolCallIntent(intent: NewToolCallIntent): Promise<ToolCallIntentRow | null> {
    await this.db.run(sql`
      INSERT INTO tool_call_intents (id, "taskId", "agentId", "toolCallId", "toolName", "argsSummary", "createdAt")
      VALUES (${intent.id}, ${intent.taskId}, ${intent.agentId}, ${intent.toolCallId}, ${intent.toolName}, ${intent.argsSummary}, ${nowIso})
      ON CONFLICT ("taskId", "toolCallId") DO NOTHING`);
    return this.db.get<ToolCallIntentRow>(sql`
      SELECT * FROM tool_call_intents WHERE "taskId" = ${intent.taskId} AND "toolCallId" = ${intent.toolCallId}`);
  }

  async deleteToolCallIntent(taskId: string, toolCallId: string): Promise<number> {
    const result = await this.db.run(sql`
      DELETE FROM tool_call_intents WHERE "taskId" = ${taskId} AND "toolCallId" = ${toolCallId}`);
    return result.changes;
  }

  listToolCallIntents(taskId: string, limit: number): Promise<ToolCallIntentRow[]> {
    return this.db.query<ToolCallIntentRow>(sql`
      SELECT * FROM tool_call_intents WHERE "taskId" = ${taskId}
      ORDER BY "createdAt" ASC, id ASC LIMIT ${limit}`);
  }

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
  abstract listKeyWindowUsageRows(
    credentials: { keyType: string; keySuffix: string }[],
    start: string,
    through: string,
  ): Promise<KeyWindowUsageRow[]>;

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
  abstract insertPricingSeedRow(
    provider: string,
    model: string,
    tokenClass: string,
    pricePerMillionUsd: number,
  ): Promise<boolean>;

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

  async updatePricingPrice(
    provider: string,
    model: string,
    tokenClass: string,
    effectiveFrom: number,
    pricePerMillionUsd: number,
    now: number,
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE pricing SET price_per_million_usd = ${pricePerMillionUsd}, "lastUpdatedAt" = ${now}
      WHERE provider = ${provider} AND model = ${model} AND token_class = ${tokenClass}
        AND effective_from = ${effectiveFrom}`);
  }

  // ---- session tree (SQLite syntax throughout: kept per engine) ----

  abstract sessionThreadRootsSql(rules: SessionTreeRules): SqlQuery;
  abstract sessionRootFilterSql(rules: SessionTreeRules, spec: SessionRootFilterSpec): SqlQuery;
  abstract sessionSummarySql(rules: SessionTreeRules, spec: SessionSummarySpec): SqlQuery;
  abstract legacySessionSummarySql(rules: SessionTreeRules, spec: SessionSummarySpec): SqlQuery;
  abstract sessionCountSql(
    rules: SessionTreeRules,
    spec: SessionSummarySpec,
    chain: boolean,
  ): SqlQuery;

  async countSessions(
    rules: SessionTreeRules,
    spec: SessionSummarySpec,
    chain: boolean,
  ): Promise<number> {
    const row = await this.db.get<{ count: number }>(this.sessionCountSql(rules, spec, chain));
    return row?.count ?? 0;
  }

  listThreadRootCounts(rules: SessionTreeRules): Promise<{ key: string; threadRoots: number }[]> {
    return this.db.query(this.threadRootCountsSql(rules));
  }

  /** The grouped thread-root count statement (thread key match is per engine). */
  protected abstract threadRootCountsSql(rules: SessionTreeRules): SqlQuery;

  async findTaskThreadRoots(rules: SessionTreeRules, taskId: string): Promise<number | null> {
    const row = await this.db.get<{ threadRoots: number }>(
      sql`SELECT ${this.sessionThreadRootsSql(rules)} AS "threadRoots" FROM agent_tasks r WHERE r.id = ${taskId}`,
    );
    return row ? row.threadRoots : null;
  }

  findSessionReadState(
    rules: SessionTreeRules,
    spec: SessionSummarySpec,
  ): Promise<{ readState: string | null; lastActivityAt: string } | null> {
    return this.db.get(
      sql`SELECT "readState", "lastActivityAt" FROM (${this.sessionSummarySql(rules, spec)})`,
    );
  }

  async hasReadSession(rules: SessionTreeRules, spec: SessionSummarySpec): Promise<boolean> {
    const row = await this.db.get<{ found: number }>(
      sql`SELECT 1 AS found FROM (${this.sessionSummarySql(rules, spec)}) WHERE "readState" = 'read' LIMIT 1`,
    );
    return row !== null;
  }

  listSessionPage<T>(
    rules: SessionTreeRules,
    spec: SessionSummarySpec,
    page: { snoozeFirst: boolean; limit: number; offset: number },
  ): Promise<T[]> {
    const order = (alias: string) => {
      const a = sqlIdent(alias);
      return sql`${page.snoozeFirst ? sql`${a}."snoozeUntil" ASC NULLS FIRST,` : EMPTY}
        ${a}."lastActivityAt" DESC, ${a}."rootCreatedAt" DESC, ${a}.root_id DESC`;
    };
    // Page first on the summaries, then read agent_tasks for the page roots only.
    return this.db.query<T>(sql`SELECT r.*, a."chainCount" AS "__chainCount",
        a."lastActivityAt" AS "__lastActivityAt", a."latestStatus" AS "__latestStatus",
        a."readState" AS "__readState", a."snoozeUntil" AS "__snoozeUntil",
        a."needsYou" AS "__needsYou", ${this.sessionThreadRootsSql(rules)} AS "__threadRoots"
      FROM (SELECT * FROM (${this.sessionSummarySql(rules, spec)}) page
            ORDER BY ${order("page")} LIMIT ${page.limit} OFFSET ${page.offset}) a
      ${this.sessionPageJoin()} agent_tasks r ON r.id = a.root_id
      ORDER BY ${order("a")}`);
  }

  /** The join from the page to its roots (SQLite pins the loop order with CROSS JOIN). */
  protected sessionPageJoin(): SqlQuery {
    return sql`JOIN`;
  }

  abstract listSessionPageMembers(rootIds: readonly string[]): Promise<SessionPageMemberRow[]>;

  listSessionPageShares(rootIds: readonly string[]): Promise<SessionPageShareRow[]> {
    return this.db.query<SessionPageShareRow>(sql`
      SELECT sh."rootTaskId" AS root_id, sh."userId" AS id, u.name, sh.access FROM session_shares sh
      LEFT JOIN users u ON u.id = sh."userId"
      WHERE sh."revokedAt" IS NULL AND sh."rootTaskId" IN (${sqlList(rootIds)})
      ORDER BY sh."createdAt", sh.id`);
  }

  abstract listSessionTreeRows(
    rules: SessionTreeRules,
    spec: SessionSummarySpec,
    visibleRule: { mine: boolean; userId: string | null; readAll?: boolean } | null,
  ): Promise<SessionTreeRow[]>;
  abstract listThreadLabels(
    rootIds: readonly string[],
    promptChars: number,
  ): Promise<SessionThreadLabelRow[]>;
  abstract triageSessionList(
    rules: SessionTreeRules,
    spec: SessionSummarySpec,
    write: SessionListTriageWrite,
  ): Promise<number>;

  // ---- session moves ----

  listTaskAttachmentMappings(taskId: string): Promise<{ id: string; key: string }[]> {
    return this.db.query(sql`
      SELECT DISTINCT m.id, m."key" AS key
       FROM asset_key_mappings m
       JOIN task_attachments a
         ON m.provider_id = COALESCE(NULLIF(a.provider_id, ''), 'agent-fs')
        AND m.provider_org_id = COALESCE(a.agent_fs_org_id, '')
        AND m.provider_drive_id = COALESCE(a.agent_fs_drive_id, '')
        AND m.provider_key = COALESCE(NULLIF(a.provider_key, ''), a.path)
       WHERE a.task_id = ${taskId}
         AND (m.source_entity_type IS DISTINCT FROM 'task-attachment'
           OR m.source_entity_id IN (SELECT id FROM task_attachments WHERE task_id = ${taskId}))`);
  }

  async setTaskKey(taskId: string, key: string, changedBy: string | null): Promise<void> {
    await this.db.run(
      sql`UPDATE agent_tasks SET "key" = ${key}, updated_by = COALESCE(${changedBy}, updated_by) WHERE id = ${taskId}`,
    );
  }

  async setAssetMappingKey(
    id: string,
    key: string,
    now: string,
    changedBy: string | null,
  ): Promise<void> {
    await this.db.run(
      sql`UPDATE asset_key_mappings SET "key" = ${key}, updated_at = ${now}, updated_by = COALESCE(${changedBy}, updated_by) WHERE id = ${id}`,
    );
  }

  /** `UPDATE OR IGNORE`: kept per engine. */
  abstract moveKeyFavorites(range: SessionKeyRange, to: string, scope?: string): Promise<void>;

  listPrefixRoots(filter: {
    range: SessionKeyRange;
    userId?: string | null;
    limit: number;
    offset: number;
  }): Promise<{ id: string; key: string }[]> {
    return this.db.query(sql`
      SELECT r.id, r."key" FROM agent_tasks r
      WHERE r."parentTaskId" IS NULL AND r."key" >= ${filter.range.lo} AND r."key" < ${filter.range.hi}
        ${filter.userId !== undefined ? sql`AND r."requestedByUserId" = ${filter.userId}` : EMPTY}
      ORDER BY r.id LIMIT ${filter.limit} OFFSET ${filter.offset}`);
  }

  /** The viewer condition uses `IS NOT <value>`: kept per engine. */
  abstract listVisiblePrefixRoots(
    range: SessionKeyRange,
    viewer: SessionViewerSpec,
  ): Promise<{ id: string }[]>;

  findTaskKeyAndParent(
    taskId: string,
  ): Promise<{ key: string; parentTaskId: string | null } | null> {
    return this.db.get(sql`SELECT "key", "parentTaskId" FROM agent_tasks WHERE id = ${taskId}`);
  }

  /** The chat-sdk context match uses GLOB: kept per engine. */
  abstract listSourceBackfillRoots(
    afterId: string,
    limit: number,
  ): Promise<SourceBackfillRootRow[]>;

  async listChainTaskIds(rootId: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(sql`
      WITH RECURSIVE chain(id) AS (
        SELECT id FROM agent_tasks WHERE id = ${rootId}
        UNION
        SELECT t.id FROM agent_tasks t JOIN chain c ON t."parentTaskId" = c.id
      ) SELECT id FROM chain`);
    return rows.map((row) => row.id);
  }

  // ---- session labels ----

  listLiveKvValues(
    namespace: string,
    keys: readonly string[],
    nowMs: number,
  ): Promise<{ key: string; value: string }[]> {
    return this.db.query(sql`
      SELECT key, value FROM kv_entries
      WHERE namespace = ${namespace} AND key IN (${sqlList(keys)})
        AND (expires_at IS NULL OR expires_at > ${nowMs})`);
  }

  listResourceNames(
    kind: SessionResourceKind,
    ids: readonly string[],
  ): Promise<{ id: string; name: string | null }[]> {
    const { table, column } = RESOURCE_NAMES[kind];
    // Keys are lower case, and so are generated ids: `id IN` keeps the primary key index.
    return this.db.query(sql`
      SELECT lower(id) AS id, NULLIF(trim(${sqlIdent(column)}), '') AS name FROM ${sqlIdent(table)}
      WHERE id IN (${sqlList(ids)})`);
  }

  // ---- session_tokens (minting, revocation, resolution) ----

  async findLiveParentTokenExpiry(
    tokenId: string,
    agentId: string,
    runtimeId: string | null,
    now: string,
  ): Promise<string | null> {
    const binding = runtimeId ? sql`"runtimeId" = ${runtimeId}` : AGENT_TOKEN_BINDING;
    const row = await this.db.get<{ expiresAt: string }>(sql`
      SELECT "expiresAt" FROM session_tokens WHERE id = ${tokenId} AND "agentId" = ${agentId} AND ${binding}
      AND "revokedAt" IS NULL AND "expiresAt" > ${now}`);
    return row?.expiresAt ?? null;
  }

  async insertSessionToken(t: NewSessionToken): Promise<void> {
    await this.db.run(sql`
      INSERT INTO session_tokens
      (id, "tokenHash", "tokenPreview", "agentId", "taskId", "runtimeId", "parentRuntimeId", "expiresAt", "createdAt", "controllerId", "parentTokenId", "scriptRun")
      VALUES (${t.id}, ${t.tokenHash}, ${t.tokenPreview}, ${t.agentId}, ${t.taskId}, ${t.runtimeId},
        ${t.parentRuntimeId}, ${t.expiresAt}, ${t.createdAt}, ${t.controllerId}, ${t.parentTokenId}, ${t.scriptRun})`);
  }

  async setSessionTokenProvenance(
    tokenId: string,
    p: {
      sourceStepId: string | null;
      sourceScriptRunId: string | null;
      objectChain: string | null;
      depth: number;
    },
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE session_tokens SET "sourceStepId" = ${p.sourceStepId}, "sourceScriptRunId" = ${p.sourceScriptRunId},
        "objectChain" = ${p.objectChain}, depth = ${p.depth}
      WHERE id = ${tokenId}`);
  }

  async findSessionTokenScriptRun(tokenId: string): Promise<number | null> {
    const row = await this.db.get<{ scriptRun: number }>(
      sql`SELECT "scriptRun" FROM session_tokens WHERE id = ${tokenId}`,
    );
    return row ? row.scriptRun : null;
  }

  findSessionTokenRuntime(tokenId: string): Promise<{ runtimeId: string | null } | null> {
    return this.db.get(sql`SELECT "runtimeId" FROM session_tokens WHERE id = ${tokenId}`);
  }

  async listChildSessionTokenIds(parentTokenIds: readonly string[]): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(
      sql`SELECT id FROM session_tokens WHERE "parentTokenId" IN (${sqlList(parentTokenIds)})`,
    );
    return rows.map((row) => row.id);
  }

  async revokeSessionTokens(ids: readonly string[], now: string): Promise<void> {
    await this.db.run(sql`
      UPDATE session_tokens SET "revokedAt" = ${now}
      WHERE id IN (${sqlList(ids)}) AND "revokedAt" IS NULL`);
  }

  async listRuntimeSessionTokenIds(runtimeId: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(
      sql`SELECT id FROM session_tokens WHERE "runtimeId" = ${runtimeId} OR "parentRuntimeId" = ${runtimeId}`,
    );
    return rows.map((row) => row.id);
  }

  async revokeRuntimeSessionTokens(runtimeId: string, now: string): Promise<void> {
    await this.db.run(sql`
      UPDATE session_tokens SET "revokedAt" = ${now}
      WHERE ("runtimeId" = ${runtimeId} OR "parentRuntimeId" = ${runtimeId}) AND "revokedAt" IS NULL`);
  }

  async listActiveAgentTokenIds(agentId: string, now: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(sql`
      SELECT id FROM session_tokens WHERE "agentId" = ${agentId} AND ${AGENT_TOKEN_BINDING}
      AND "revokedAt" IS NULL AND "expiresAt" > ${now}`);
    return rows.map((row) => row.id);
  }

  async expireSessionTokensWithChildren(ids: readonly string[], expiresAt: string): Promise<void> {
    await this.db.run(sql`
      UPDATE session_tokens SET "expiresAt" = ${expiresAt}
      WHERE (id IN (${sqlList(ids)}) OR "parentTokenId" IN (${sqlList(ids)})) AND "expiresAt" > ${expiresAt}`);
  }

  async listUnrevokedAgentSessionTokenIds(agentId: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(sql`
      SELECT id FROM session_tokens WHERE "agentId" = ${agentId} AND "controllerId" IS NULL AND "revokedAt" IS NULL`);
    return rows.map((row) => row.id);
  }

  findSessionTokenByHash(tokenHash: string): Promise<SessionTokenLookupRow | null> {
    return this.db.get<SessionTokenLookupRow>(sql`
      SELECT s.id, s."agentId", s."taskId", s."runtimeId", s."controllerId", s."expiresAt", s."revokedAt",
      s."sourceStepId", s."sourceScriptRunId", s."objectChain", s.depth, c.placement FROM session_tokens s LEFT JOIN runtime_controllers c ON c.id = s."controllerId"
      WHERE s."tokenHash" = ${tokenHash}`);
  }

  async touchSessionToken(id: string, now: string): Promise<void> {
    await this.db.run(sql`UPDATE session_tokens SET "lastUsedAt" = ${now} WHERE id = ${id}`);
  }
}
