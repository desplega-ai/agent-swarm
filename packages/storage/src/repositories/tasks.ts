import {
  forUpdate,
  forUpdateSkipLocked,
  greatestStrict,
  jsonText,
  likeAsciiCi,
  nowIso,
} from "../dialect";
import type { SqlExecutor } from "../executor";
import { EMPTY, SqlQuery, sql, sqlIdent, sqlJoin, sqlList, sqlWhere } from "../sql";

/**
 * Domain: tasks (`agent_tasks`, `agent_tasks_fts*`, `task_attachments`,
 * `task_citations`, `task_context_snapshots`, `task_idempotency_keys`,
 * `task_steering_messages`, `task_templates`, `task_ui_action_runs`,
 * `task_ui_specs`, `deferred_task_waits`, `deferred_task_wait_members`,
 * `deferred_event_waits`, `routing_decisions`, `human_free_reclassify_queue`,
 * `checklist_items`). Rows come back in the SQLite value shape on every engine
 * (flags 0/1, JSON as text, timestamps as the text the column stores).
 */

/**
 * The `agent_tasks.status` values. No CHECK constraint guards this column:
 * the typed writes below are the only writers. `src/types.ts`
 * (`AgentTaskStatusSchema`) must list the same values; `src/be/db/tasks/read.ts`
 * fails to compile when they drift.
 */
export const TASK_STATUSES = [
  "draft",
  "backlog",
  "unassigned",
  "offered",
  "reviewing",
  "pending",
  "in_progress",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "superseded",
  "skipped",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * The `agent_tasks.source` values. Migration 056 dropped the column's CHECK so
 * a new source needs no table rebuild; the typed writes below are the only
 * writers. `AgentTaskSourceSchema` in `src/types.ts` must list the same values.
 */
export const TASK_SOURCES = [
  "mcp",
  "slack",
  "api",
  "ui",
  "github",
  "gitlab",
  "azure-devops",
  "bitbucket",
  "agentmail",
  "system",
  "schedule",
  "workflow",
  "linear",
  "jira",
  "comb",
  "chat",
  "alert",
] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

/** The values the `agent_tasks.routing_reason` CHECK constraint allows, on both engines. */
export const TASK_ROUTING_REASONS = [
  "skill",
  "continuity",
  "overflow",
  "human_pinned",
  "reroute_fault",
] as const;
export type TaskRoutingReason = (typeof TASK_ROUTING_REASONS)[number];

/** The values the `agent_tasks.routing_source` CHECK constraint allows, on both engines. */
export const TASK_ROUTING_SOURCES = ["declared", "engine_default"] as const;
export type TaskRoutingSource = (typeof TASK_ROUTING_SOURCES)[number];

/** One `agent_tasks` row. */
export type TaskRow = {
  id: string;
  key: string;
  agentId: string | null;
  creatorAgentId: string | null;
  task: string;
  title: string | null;
  status: TaskStatus;
  source: TaskSource;
  routing_reason: TaskRoutingReason | null;
  routing_source: TaskRoutingSource | null;
  routing_note: string | null;
  pool_wake_at: string | null;
  taskType: string | null;
  tags: string | null;
  priority: number;
  dependsOn: string | null;
  offeredTo: string | null;
  offeredAt: string | null;
  acceptedAt: string | null;
  rejectionReason: string | null;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  slackTriggerMessageTs: string | null;
  slackUserId: string | null;
  slackParticipants?: string | null;
  slackReplySent: number;
  slackProgressMessageTs: string | null;
  slackTreeRootMessageTs: string | null;
  vcsProvider: string | null;
  vcsRepo: string | null;
  vcsEventType: string | null;
  vcsNumber: number | null;
  vcsCommentId: number | null;
  vcsAuthor: string | null;
  vcsUrl: string | null;
  vcsInstallationId: number | null;
  vcsNodeId: string | null;
  agentmailInboxId: string | null;
  agentmailMessageId: string | null;
  agentmailThreadId: string | null;
  mentionMessageId: string | null;
  mentionChannelId: string | null;
  dir: string | null;
  parentTaskId: string | null;
  dispatchedByTaskId?: string | null;
  claudeSessionId: string | null;
  model: string | null;
  modelTier: string | null;
  effort: string | null;
  resolvedEffort?: string | null;
  resolvedModel?: string | null;
  modelSource?: string | null;
  modelAlias?: string | null;
  profile?: string | null;
  resolvedProfile?: string | null;
  modelGroup?: string | null;
  fallbackHops?: string | null;
  scheduleId: string | null;
  workflowRunId: string | null;
  workflowRunStepId: string | null;
  outputSchema: string | null;
  followUpConfig: string | null;
  contextKey: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  finishedAt: string | null;
  notifiedAt: string | null;
  failureReason: string | null;
  statusKind: string | null;
  output: string | null;
  progress: string | null;
  compactionCount: number | null;
  peakContextPercent: number | null;
  peakContextTokens: number | null;
  contextWindowSize: number | null;
  was_paused: number;
  deferredAt: string | null;
  deferredUntil: string | null;
  credentialKeySuffix: string | null;
  credentialKeyType: string | null;
  requestedByUserId: string | null;
  requestedByUserIdInherited: number;
  swarmVersion: string | null;
  provider: string | null;
  providerMeta: string | null;
  harnessVariant: string | null;
  harnessVariantMeta: string | null;
  totalCostUsd?: number | null;
  routingAffinity: string | null;
};

export type TaskIdempotencyKeyRow = {
  id: string;
  principal: string;
  keyHash: string;
  requestFingerprint: string;
  taskId: string;
  createdAt: string;
  created_by: string | null;
  updated_by: string | null;
};

/** VCS scope of a task lookup. `includeNullProvider` also matches legacy rows with no provider. */
export type TaskVcsScope = {
  repo: string;
  number: number;
  provider: string;
  includeNullProvider: boolean;
};

export type TaskStatsRow = {
  total: number;
  unassigned: number;
  offered: number;
  reviewing: number;
  pending: number;
  in_progress: number;
  paused: number;
  completed: number;
  failed: number;
};

/** Statuses after which a task never runs again (the SQL twin of `TERMINAL_TASK_STATUSES`). */
const TERMINAL = sql`('completed', 'failed', 'cancelled', 'superseded', 'skipped')`;

/**
 * The SQL twin of `sessionAccessForRoot` (src/be/session-shares). A session's
 * root is its topmost existing task; the session is hidden when the root has an
 * owner other than the user, is not a schedule run, and no active share names
 * the user or everyone. `taskIdColumn` is a column chosen by code. With
 * `nullable`, task-less rows (NULL column) stay.
 */
export function readableSessionSql(
  userId: string | null,
  taskIdColumn: SqlQuery,
  opts: { nullable?: boolean } = {},
): SqlQuery {
  const otherOwner = userId
    ? sql`r."requestedByUserId" IS NOT NULL AND r."requestedByUserId" != ${userId}`
    : sql`r."requestedByUserId" IS NOT NULL`;
  const shareMatch = userId
    ? sql`(s."userId" IS NULL OR s."userId" = ${userId})`
    : sql`s."userId" IS NULL`;
  const notHidden = sql`${taskIdColumn} NOT IN (
      WITH RECURSIVE hidden(id) AS (
        SELECT r.id FROM agent_tasks r
        WHERE (r."parentTaskId" IS NULL
            OR NOT EXISTS (SELECT 1 FROM agent_tasks p WHERE p.id = r."parentTaskId"))
          AND ${otherOwner}
          AND r."scheduleId" IS NULL
          AND NOT EXISTS (SELECT 1 FROM session_shares s
            WHERE s."rootTaskId" = r.id AND s."revokedAt" IS NULL AND ${shareMatch})
        UNION ALL
        SELECT c.id FROM agent_tasks c JOIN hidden ON c."parentTaskId" = hidden.id
      )
      SELECT id FROM hidden
    )`;
  return opts.nullable ? sql`(${taskIdColumn} IS NULL OR ${notHidden})` : notHidden;
}

/** A column reference chosen by code (`agent_tasks.id`, `events."taskId"`). Never input. */
export function sqlColumnRef(text: string): SqlQuery {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.("?)[A-Za-z_][A-Za-z0-9_]*\2)?$/.test(text)) {
    throw new Error(`Not a column reference: ${text}`);
  }
  return new SqlQuery([text], []);
}

/** Preview length of a task's `task` text in the list projections. */
export const TASK_PREVIEW_LENGTH = 300;

/**
 * The generated `<sibling_tasks_in_progress>` block a task text may start
 * with (`src/tasks/sibling-block.ts`); list previews start after it.
 */
export const TASK_SIBLING_BLOCK = {
  open: "<sibling_tasks_in_progress>",
  close: "</sibling_tasks_in_progress>",
} as const;

/** `agent_tasks_fts_state.indexedThrough` once every row is indexed (migration 256). */
export const TASK_FTS_COMPLETE = Number.MAX_SAFE_INTEGER;

/**
 * The agent_tasks_fts MATCH expression for free text: the whole input as one
 * FTS5 phrase, so user text cannot inject operators (NEAR, AND, -, ^, column
 * filters), with a prefix match on its last token. Returns null when the input
 * has no indexable token (the phrase would match nothing).
 */
export function buildTaskFtsMatch(search: string): string | null {
  if (!/[\p{L}\p{N}]/u.test(search)) return null;
  return `"${search.replaceAll('"', '""')}"*`;
}

/** Normalized list filters (`src/` resolves keys and prefix patterns first). */
export type TaskListFilters = {
  statuses?: readonly string[];
  statusKind?: string;
  agentId?: string;
  search?: string;
  unassigned?: boolean;
  offeredTo?: string;
  taskType?: string;
  tags?: readonly string[];
  scheduleId?: string;
  workflowRunId?: string;
  /** Exact, already normalized asset key. */
  key?: string;
  /** LIKE pattern with `\` escapes for a key subtree. */
  keyPrefixPattern?: string;
  sources?: readonly string[];
  createdAfter?: string;
  createdBefore?: string;
  requestedByUserId?: string;
  requestedByUserIdIsNull?: boolean;
  includeHeartbeat?: boolean;
  readableBy?: { userId: string | null };
};

/** Which columns a task list returns. */
export type TaskListFields = "full" | "slim" | "timeline";

/** Every list row carries the summed session cost of its task. */
type TaskListCost = { totalCostUsd: number | null };

/** Same ordering as the session-cost list. Used only after selecting the task page. */
export function taskRunModelColumn(rowId: "rowid" | "_rowid"): SqlQuery {
  return sql`, (SELECT model FROM session_costs
    WHERE "taskId" = agent_tasks.id
      AND COALESCE(kind, 'harness') <> 'system-one'
      AND model NOT IN ('', 'default')
    ORDER BY "createdAt" DESC, ${sqlIdent(rowId)} ASC LIMIT 1) AS "runModel"`;
}
/** The slim and timeline `task`: the UTF-8 byte prefix the list projection cuts. */
type TaskListPreview = Omit<TaskRow, "task" | "totalCostUsd"> & { task: Uint8Array };

/** The slim list projection (`LIST_COLUMNS.slim` of each engine). */
export type TaskSlimListRow = Pick<
  TaskListPreview,
  | "id"
  | "key"
  | "agentId"
  | "creatorAgentId"
  | "task"
  | "title"
  | "status"
  | "source"
  | "taskType"
  | "tags"
  | "priority"
  | "dependsOn"
  | "offeredTo"
  | "acceptedAt"
  | "parentTaskId"
  | "scheduleId"
  | "model"
  | "modelTier"
  | "resolvedModel"
  | "modelSource"
  | "modelAlias"
  | "effort"
  | "resolvedEffort"
  | "profile"
  | "resolvedProfile"
  | "modelGroup"
  | "provider"
  | "requestedByUserId"
  | "progress"
  | "createdAt"
  | "lastUpdatedAt"
  | "finishedAt"
  | "statusKind"
  | "peakContextPercent"
> &
  TaskListCost;

/** The timeline list projection (`LIST_COLUMNS.timeline` of each engine). */
export type TaskTimelineListRow = Pick<
  TaskListPreview,
  | "id"
  | "agentId"
  | "parentTaskId"
  | "task"
  | "title"
  | "status"
  | "createdAt"
  | "lastUpdatedAt"
  | "finishedAt"
  | "peakContextTokens"
> &
  TaskListCost;

/** The row `listTasks` returns for a projection: only the selected columns. */
export type TaskListRow<F extends TaskListFields> = F extends "slim"
  ? TaskSlimListRow & { runModel: string | null }
  : F extends "timeline"
    ? TaskTimelineListRow
    : Omit<TaskRow, "totalCostUsd"> & TaskListCost;

/** A task list page. */
export type TaskListPage = {
  orderBy?: "lastUpdatedAt" | "createdAt";
  limit: number;
  offset: number;
};

/** One row of a lineage walk: the slim list columns, the workflow run and the cost. */
export type TaskLineageRow = Record<string, unknown> & {
  id: string;
  workflowRunId: string | null;
};

/** A plain task row `createTask` inserts. */
export type NewSimpleTask = {
  id: string;
  key: string;
  agentId: string;
  task: string;
  status: TaskStatus;
  source: TaskSource;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  slackUserId: string | null;
  swarmVersion: string;
  isHumanFree: boolean;
};

/** Columns the session-init path may set on a task. */
export type TaskSessionColumn =
  | "claudeSessionId"
  | "provider"
  | "providerMeta"
  | "model"
  | "harnessVariant"
  | "harnessVariantMeta"
  | "resolvedEffort";

/** The session columns that hold JSON (bound through `jsonText`). */
const TASK_JSON_SESSION_COLUMNS: ReadonlySet<string> = new Set([
  "providerMeta",
  "harnessVariantMeta",
]);

/** A move to a terminal status. */
export type TaskFinish = {
  status: "completed" | "failed" | "cancelled" | "skipped" | "superseded";
  statusKind: string | null;
  finishedAt: string;
  /** Written when set; left as stored when undefined. */
  failureReason?: string;
  /** Compare-and-swap on the observed `lastUpdatedAt`. */
  expectedLastUpdatedAt?: string;
};

/** Optional guards of a pool assignment, re-checked in the write itself. */
export type TaskAssignGuards = {
  /** The task and agent `lastUpdatedAt` the router read; also checks the agent's capacity. */
  snapshot?: { taskLastUpdatedAt: string; agentLastUpdatedAt: string };
  /** The pool must be unchanged, enabled and not circuit-open at `at`. */
  pool?: { id: string; updatedAt: string; at: string };
};

/**
 * The tags the human-free classification reads. Keep each entry to plain word
 * characters: the SQL matches it with `LIKE`, where `%` and `_` are wildcards.
 */
export const HUMAN_FREE_TAGS = ["heartbeat"] as const;

/** The classifying inputs of a task about to be inserted. */
export type HumanFreeClassifyInput = {
  taskType: string | null;
  tags: string | null;
  source: string | null;
  requestedByUserId: string | null;
  requestedByUserIdInherited: boolean;
  parentTaskId: string | null;
  workflowRunId: string | null;
};

export type HumanFreeQueueRow = {
  seq: number;
  taskId: string;
  scope: "self" | "children";
  afterRowid: number;
  hops: number;
};

export type TaskUiSpecRow = {
  taskId: string;
  spec: string;
  actions: string | null;
  fallbackText: string;
};

/** A task UI action run as the lease check reads it. */
export type TaskUiActionLeaseRow = { lockedUntil: string | null; lastRunAt: string | null };

/** A `checklist_items` row (columns as stored), plus the joined changer name in lists. */
export type ChecklistItemRow = Record<string, unknown> & { id: string };

export type NewChecklistItem = {
  id: string;
  scope: string;
  userId: string | null;
  kind: string;
  label: string;
  href: string | null;
  meta: string | null;
  sortOrder: number;
  now: string;
  actor: string;
};

/** A `task_citations` row in API names (`general` 0/1). */
export type TaskCitationRow = {
  index: number;
  kind: string;
  ref: string;
  label: string | null;
  quote: string | null;
  resolvedUrl: string | null;
  verified: string;
  general: number;
};

export type DeferredTaskWaitRow = {
  scheduleId: string;
  eventName: string;
  mode: "all" | "any";
  status: "pending" | "fired";
};

export type DeferredEventWaitRow = {
  scheduleId: string;
  source: string;
  event: string;
  matchKey: string;
  matchJson: string;
  status: "pending" | "fired";
};

export type DeferredWaitTable = "deferred_task_waits" | "deferred_event_waits";

/** One `task_attachments` row. */
export type TaskAttachmentRow = {
  id: string;
  task_id: string;
  agent_id: string | null;
  name: string;
  kind: string;
  url: string | null;
  path: string | null;
  page_id: string | null;
  provider_id: string | null;
  provider_key: string | null;
  capabilities: string | null;
  agent_fs_org_id: string | null;
  agent_fs_drive_id: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  intent: string | null;
  description: string | null;
  is_primary: number;
  created_at: string;
  created_by: string | null;
  updated_by: string | null;
};

/** The writable columns of a `task_attachments` row (`is_primary` as a JS boolean). */
export type TaskAttachmentWrite = Omit<
  TaskAttachmentRow,
  "id" | "task_id" | "created_at" | "created_by" | "is_primary"
> & { is_primary: boolean };

/** One `task_steering_messages` row, with `sender_name` resolved from `users` / `agents`. */
export type TaskSteeringMessageRow = {
  id: string;
  task_id: string;
  body: string;
  mode: string;
  status: string;
  delivered_mode: string | null;
  source: string;
  sender_name?: string | null;
  created_by_kind: string;
  created_by_user_id: string | null;
  created_by_agent_id: string | null;
  promoted_task_id: string | null;
  created_at: string;
  delivered_at: string | null;
  handled_at: string | null;
  handled_note: string | null;
};

export type NewSteeringMessage = {
  id: string;
  task_id: string;
  body: string;
  mode: string;
  source: string;
  created_by_kind: string;
  created_by_user_id: string | null;
  created_by_agent_id: string | null;
};

/** The columns `createTaskExtended` writes on a new `agent_tasks` row (flags as JS booleans). */
export type NewTaskRow = {
  id: string;
  key: string;
  agentId: string | null;
  creatorAgentId: string | null;
  task: string;
  status: TaskStatus;
  source: TaskSource;
  routing_reason: TaskRoutingReason | null;
  routing_source: TaskRoutingSource | null;
  routing_note: string | null;
  taskType: string | null;
  tags: string;
  priority: number;
  dependsOn: string;
  offeredTo: string | null;
  offeredAt: string | null;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  slackTriggerMessageTs: string | null;
  slackUserId: string | null;
  slackParticipants: string | null;
  vcsProvider: string | null;
  vcsRepo: string | null;
  vcsEventType: string | null;
  vcsNumber: number | null;
  vcsCommentId: number | null;
  vcsAuthor: string | null;
  vcsUrl: string | null;
  vcsInstallationId: number | null;
  vcsNodeId: string | null;
  agentmailInboxId: string | null;
  agentmailMessageId: string | null;
  agentmailThreadId: string | null;
  mentionMessageId: string | null;
  mentionChannelId: string | null;
  dir: string | null;
  parentTaskId: string | null;
  dispatchedByTaskId: string | null;
  model: string | null;
  modelTier: string | null;
  effort: string | null;
  profile: string | null;
  modelGroup: string | null;
  fallbackHops: string | null;
  scheduleId: string | null;
  workflowRunId: string | null;
  workflowRunStepId: string | null;
  outputSchema: string | null;
  followUpConfig: string | null;
  requestedByUserId: string | null;
  requestedByUserIdInherited: boolean;
  contextKey: string | null;
  routingAffinity: string | null;
  swarmVersion: string;
  createdAt: string;
  lastUpdatedAt: string;
  created_by: string | null;
  updated_by: string | null;
  isHumanFree: boolean;
  sourceStepId: string | null;
  sourceScriptRunId: string | null;
};

/** A `routing_decisions` row (JSON columns as text). */
export type RoutingDecisionRow = {
  task_id: string;
  selected_agent_id: string | null;
  captured_at: string;
  worker_statuses: string;
  continuity_candidates: string;
  created_by: string | null;
  updated_by: string | null;
};

/** The task columns a routing continuity candidate matches on (all must equal). */
export type RoutingCandidateMatch = Partial<{
  vcsRepo: string;
  vcsNumber: number;
  slackChannelId: string;
  slackThreadTs: string;
  agentmailThreadId: string;
}>;

/** One `task_context_snapshots` row. */
export type ContextSnapshotRow = {
  id: string;
  taskId: string;
  agentId: string;
  sessionId: string;
  contextUsedTokens: number | null;
  contextTotalTokens: number | null;
  contextPercent: number | null;
  eventType: string;
  compactTrigger: string | null;
  preCompactTokens: number | null;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  contextFormula: string | null;
  createdAt: string;
};

/** One `task_templates` row (`payload` and `tags` as JSON text). */
export type TaskTemplateRow = {
  id: string;
  title: string;
  description: string;
  prompt: string;
  kind: string;
  payload: string;
  category: string | null;
  tags: string;
  createdAt: string;
};

/** A task of the lead's concurrent-context digest. */
export type ConcurrentTaskRow = {
  id: string;
  task: string;
  agentId: string | null;
  agentName: string | null;
  creatorAgentId?: string | null;
  status: string;
  createdAt: string;
  progress?: string | null;
};

export interface TasksRepository {
  // ---- agent_tasks: drafts and Slack folds ----
  /** Appends `suffix` to a draft's text. Returns the changed row count (0: not a draft). */
  appendDraftTaskText(taskId: string, suffix: string, now: string): Promise<number>;
  /**
   * Compare-and-set of a pending task's text: changes the row only while it is
   * `pending` with text `expectedTask`. `toDraft` also moves it to `draft`; a
   * null `slackParticipants` keeps the stored value. Returns the changed row count.
   */
  foldPendingTaskText(args: {
    taskId: string;
    expectedTask: string;
    nextTask: string;
    toDraft: boolean;
    slackParticipants: string | null;
    now: string;
  }): Promise<number>;
  /**
   * Slack message timestamps already delivered into tasks of a thread: each
   * task's trigger message and each `task_steering`/`slack_reaction` log entry's
   * `slackMessageTs`. Distinct values in no particular order (callers build a set).
   */
  listDeliveredSlackMessageTs(channelId: string, threadTs: string): Promise<(string | null)[]>;

  // ---- agent_tasks: reads ----
  findTaskById(id: string): Promise<TaskRow | null>;
  /** Children of a task, oldest first (ties: insertion order). */
  listChildTasks(parentTaskId: string): Promise<TaskRow[]>;
  /** True when the task has a non-terminal child of `taskType`. */
  hasOpenChildOfType(parentId: string, taskType: string): Promise<boolean>;
  /**
   * Superseded tasks finished in `(finishedAfter, finishedBefore)` with no
   * workflow step, a failure reason other than `workflowReason`, and no resume
   * child. Oldest finish first (ties: engine order, as today).
   */
  listSupersededWithoutResume(
    finishedBefore: string,
    finishedAfter: string,
    workflowReason: string,
  ): Promise<TaskRow[]>;
  /**
   * Superseded tasks finished in the window with a resume child and a
   * dependent in one of `neverStartedStatuses`, paired with the latest resume.
   * Oldest finish first (ties: engine order, as today).
   */
  listSupersededWithUnsettledDependents(
    finishedBefore: string,
    finishedAfter: string,
    neverStartedStatuses: readonly string[],
  ): Promise<{ taskId: string; resumeTaskId: string }[]>;
  /** The agent's tasks, newest first (ties: engine order, as today). */
  listTasksByAgent(agentId: string, readableBy?: { userId: string | null }): Promise<TaskRow[]>;
  /**
   * Tasks dispatched by one of `taskIds` and not in `taskIds`, with
   * `totalCostUsd`; oldest first (ties: insertion order). Empty input: no rows.
   */
  listTasksDispatchedFrom(taskIds: readonly string[]): Promise<TaskRow[]>;
  /** The agent's most recently updated in-progress task. */
  findAgentCurrentTask(agentId: string): Promise<TaskRow | null>;
  /** Tasks in `status`, newest first (ties: engine order, as today). */
  listTasksByStatus(status: string): Promise<TaskRow[]>;
  /** Newest non-terminal task of a VCS entity. */
  findActiveTaskByVcs(scope: TaskVcsScope): Promise<TaskRow | null>;
  /** Every non-terminal task of a VCS entity, newest first (ties: engine order, as today). */
  listActiveTasksByVcs(scope: TaskVcsScope): Promise<TaskRow[]>;
  /** Counts of all tasks and of the main statuses. */
  taskStats(): Promise<TaskStatsRow | null>;
  /** Up to 200 completed/failed Slack tasks, last updated first (ties: engine order, as today). */
  listFinishedSlackTasks(): Promise<TaskRow[]>;
  /**
   * Up to 50 finished, un-notified tasks of non-lead (or no) agents, last
   * finished first (ties: engine order, as today).
   */
  listUnnotifiedFinishedWorkerTasks(): Promise<TaskRow[]>;
  /** Sets `notifiedAt` on the given tasks that have none. Returns the changed count. */
  markTasksNotified(taskIds: readonly string[], now: string): Promise<number>;
  /** Clears `notifiedAt` on the given tasks that have one. Returns the changed count. */
  resetTasksNotified(taskIds: readonly string[]): Promise<number>;
  /** Up to 200 in-progress Slack tasks, last updated first (ties: engine order, as today). */
  listInProgressSlackTasks(): Promise<TaskRow[]>;
  /** Up to 200 tasks of a contextKey in `statuses`, last updated first (ties: engine order). */
  listTasksByContextKey(contextKey: string, statuses: readonly string[]): Promise<TaskRow[]>;
  /**
   * Latest-updated task of a Linear tracker contextKey outside the lineage of
   * `delegatingParentTaskId` (its root and every descendant). `active`: any
   * non-terminal task; `linkedPr`: a completed task with full VCS PR metadata.
   */
  findTrackerContextTask(
    contextKey: string,
    delegatingParentTaskId: string | null,
    kind: "active" | "linkedPr",
  ): Promise<TaskRow | null>;
  /**
   * Newest task of a contextKey. `requestedByUserId` keeps that user's tasks;
   * `notRequestedByUserId` keeps everyone else's, unowned tasks included.
   */
  findLatestTaskByContextKey(
    contextKey: string,
    opts: { requestedByUserId?: string; notRequestedByUserId?: string },
  ): Promise<TaskRow | null>;
  /** Newest `script-run-step` task of a contextKey (ties: the later insert). */
  findLatestScriptRunStepTask(contextKey: string): Promise<TaskRow | null>;
  /** Newest Slack-ingress task of a thread. */
  findLatestSlackIngressTaskInThread(channelId: string, threadTs: string): Promise<TaskRow | null>;
  /** Newest pending/in-progress Slack-ingress task of a thread (ties: the later insert). */
  findLatestActiveSlackTaskInThread(channelId: string, threadTs: string): Promise<TaskRow | null>;
  /** Newest Slack-ingress task of a thread assigned to a lead (ties: the later insert). */
  findLatestLeadSlackTaskInThread(channelId: string, threadTs: string): Promise<TaskRow | null>;
  /**
   * The agent of the newest task of a contextKey (ties: the later insert).
   * `source` narrows as the contextKey lookups do; with `endedSince`, only
   * tasks still open or finished at or after it count.
   */
  findLatestAgentIdOnContextKey(
    contextKey: string,
    source: string | null,
    endedSince: string | null,
    terminalStatuses: readonly string[],
  ): Promise<string | null>;
  /** Newest task with `lower <= contextKey < upper` (ties: the later insert). */
  findLatestTaskInContextKeyRange(
    lower: string,
    upper: string,
    opts: { source: string | null; activeOnly: boolean; requestedByUserId?: string },
  ): Promise<TaskRow | null>;
  /** Newest pending/in-progress task of a contextKey (ties: the later insert). */
  findLatestActiveTaskByContextKey(
    contextKey: string,
    source: string | null,
    requestedByUserId?: string,
  ): Promise<TaskRow | null>;
  /** Newest task of a contextKey assigned to a lead (ties: the later insert). */
  findLatestLeadTaskByContextKey(
    contextKey: string,
    source: string | null,
  ): Promise<TaskRow | null>;
  /** Oldest task of a Slack thread, any source. */
  findFirstTaskInThread(channelId: string, threadTs: string): Promise<TaskRow | null>;
  /** Newest task of a Slack thread, any source. */
  findMostRecentTaskInThread(channelId: string, threadTs: string): Promise<TaskRow | null>;
  /**
   * One page of completed non-`follow-up` tasks of a thread updated after
   * `since`, keyset-paged by `before`; last updated first, then id descending.
   */
  listCompletedTasksInThread(
    channelId: string,
    threadTs: string,
    since: string,
    limit: number,
    before?: { lastUpdatedAt: string; id: string },
  ): Promise<TaskRow[]>;
  /** Newest failed task of a thread updated after `since`. */
  findRecentFailedTaskInThread(
    channelId: string,
    threadTs: string,
    since: string,
  ): Promise<TaskRow | null>;
  /** Newest cancelled (or failed as cancelled / exit 130) task of a thread updated after `since`. */
  findRecentCancelledTaskInThread(
    channelId: string,
    threadTs: string,
    since: string,
  ): Promise<TaskRow | null>;
  /**
   * Dispatches one agent made into a thread since `since`: each `mcp` task
   * once, each script run (shared `script-run:<id>:` contextKey) once, dated by
   * its first step.
   */
  countAgentDispatchesInThread(
    channelId: string,
    threadTs: string,
    creatorAgentId: string,
    since: string,
  ): Promise<number>;

  // ---- agent_tasks: lists, counts, lineage ----
  /**
   * One page of tasks matching `filters`, with `totalCostUsd`. `fields` picks
   * the projection; slim and timeline cut `task` to a UTF-8 byte prefix (a
   * `Uint8Array`) of at least `TASK_PREVIEW_LENGTH + 1` chars past a leading
   * sibling block. Order: `lastUpdatedAt` desc, priority desc (or `createdAt`
   * desc), then insertion order desc.
   */
  listTasks<F extends TaskListFields>(
    filters: TaskListFilters,
    page: TaskListPage,
    fields: F,
  ): Promise<TaskListRow<F>[]>;
  /** Count of the tasks matching `filters`. */
  countTasks(filters: TaskListFilters): Promise<number>;
  /**
   * The ancestor path of a task, at most `maxAncestors` hops up, nearest
   * first. Empty for an unknown task.
   */
  listTaskAncestors(
    taskId: string,
    maxAncestors: number,
  ): Promise<{ id: string; parentTaskId: string | null; hops: number }[]>;
  /**
   * Breadth-first descendants of `startId` (the start included) at most
   * `maxDepth` levels down, at most `limit` rows; by depth, then createdAt,
   * then insertion order.
   */
  listTaskDescendants(startId: string, maxDepth: number, limit: number): Promise<TaskLineageRow[]>;
  /** Lineage rows of the given tasks, in no particular order. */
  listTaskLineageRows(ids: readonly string[]): Promise<TaskLineageRow[]>;
  /** True when a task outside `ids` has its parent in `ids`. */
  hasChildOutside(ids: readonly string[]): Promise<boolean>;

  // ---- agent_tasks_fts ----
  /** The backfill watermark, or null when the state row is missing. */
  getTaskFtsIndexedThrough(): Promise<number | null>;
  /**
   * Index the next `batchSize` rows past the watermark and advance it (to
   * `TASK_FTS_COMPLETE` with the last batch). Run inside a transaction.
   */
  indexTaskFtsBatch(batchSize: number): Promise<{ changes: number; done: boolean }>;
  /** Path of the main database file, or null (in-memory). */
  mainDatabaseFile(): Promise<string | null>;

  // ---- agent_tasks: lifecycle writes ----
  /** Inserts a plain task with `createdAt` = `lastUpdatedAt` = now. */
  insertSimpleTask(task: NewSimpleTask): Promise<TaskRow | null>;
  /** The agent's pending tasks, priority desc then createdAt asc (ties: engine order, as today). */
  listPendingTasksForAgent(agentId: string): Promise<TaskRow[]>;
  /** Moves an `unassigned` task to `pending` for `agentId`, when the guards still hold. */
  assignUnassignedTask(args: {
    taskId: string;
    agentId: string;
    now: string;
    poolWakeAt: string | null;
    guards: TaskAssignGuards;
  }): Promise<TaskRow | null>;
  /** Moves a non-terminal task to `in_progress`. */
  startTask(taskId: string): Promise<TaskRow | null>;
  /** Sets session columns (undefined keeps a column) and `lastUpdatedAt`. */
  setTaskSessionColumns(
    taskId: string,
    values: Partial<Record<TaskSessionColumn, string | null>>,
    now: string,
  ): Promise<TaskRow | null>;
  setTaskProviderIfUnset(taskId: string, provider: string): Promise<void>;
  /** Sets the title without touching `lastUpdatedAt`. */
  setTaskTitle(taskId: string, title: string | null): Promise<TaskRow | null>;
  /** Sets the title only while it is NULL. */
  setTaskTitleIfUnset(taskId: string, title: string): Promise<TaskRow | null>;
  /** The stored tags JSON; null for an unknown task. */
  findTaskTags(taskId: string): Promise<{ tags: string | null } | null>;
  /** Sets the tags JSON; `touch` also sets `lastUpdatedAt` to now. */
  setTaskTags(taskId: string, tagsJson: string, touch: boolean): Promise<TaskRow | null>;
  /** Moves a non-terminal task to a terminal status; `lastUpdatedAt` = now. */
  finishTask(id: string, finish: TaskFinish): Promise<TaskRow | null>;
  /** Sets `output` and `lastUpdatedAt` = now. */
  setTaskOutput(id: string, output: string): Promise<TaskRow | null>;
  setTaskDeferral(
    id: string,
    deferredAt: string,
    deferredUntil: string | null,
  ): Promise<TaskRow | null>;
  /** Rewrites output and failure reason of a terminal task; no timestamp moves. */
  overwriteTerminalResultText(
    id: string,
    output: string | null,
    failureReason: string | null,
  ): Promise<TaskRow | null>;
  /** `failed` with `reason` to `superseded` (`workflow_retry`); null when it was not that failure. */
  markWorkflowStepTaskSuperseded(id: string, reason: string): Promise<TaskRow | null>;
  /**
   * In every task in `statuses` whose `dependsOn` holds `supersededId`,
   * replaces it with `resumeTaskId` (deduplicated, first position kept).
   * Returns the changed tasks in no particular order.
   */
  repointDependents(
    supersededId: string,
    resumeTaskId: string,
    statuses: readonly string[],
  ): Promise<{ id: string; agentId: string | null }[]>;
  /** `in_progress` to `paused` (sets `was_paused`). */
  pauseTask(id: string): Promise<TaskRow | null>;
  /** `paused` to `in_progress`. */
  resumePausedTask(id: string): Promise<TaskRow | null>;
  /** The agent's paused tasks, oldest first (ties: insertion order). */
  listPausedTasksForAgent(
    agentId: string,
    readableBy?: { userId: string | null },
  ): Promise<TaskRow[]>;
  /**
   * The agent's in-progress tasks with no session id, no active session and
   * no finish, last updated before `cutoff`; oldest first (ties: insertion order).
   */
  listOrphanedInProgressTasks(agentId: string, cutoff: string): Promise<TaskRow[]>;
  /** Moves those orphans back to `pending`; returns them in no particular order. */
  resetOrphanedInProgressTasks(agentId: string, cutoff: string): Promise<TaskRow[]>;
  /** The agent's tasks cancelled after `since`, last finished first (ties: engine order). */
  listRecentlyCancelledTasks(
    agentId: string,
    since: string,
    readableBy?: { userId: string | null },
  ): Promise<TaskRow[]>;
  /** Ids of the direct children, in no particular order. */
  listChildTaskIds(parentId: string): Promise<string[]>;
  deleteTask(id: string): Promise<number>;
  /** Sets progress; a non-terminal task moves to `in_progress`. */
  updateTaskProgress(id: string, progress: string): Promise<TaskRow | null>;

  // ---- human-free classification (agent_tasks.isHumanFree, human_free_reclassify_queue) ----
  /** The stored-flag rule for a task about to be inserted (its parent must be stored). */
  classifyHumanFree(input: HumanFreeClassifyInput): Promise<boolean>;
  /**
   * Queue `taskIds` for reclassification. A repeat restarts its row
   * (`afterRowid` = 0) and keeps the larger `hops`.
   */
  enqueueHumanFreeWork(
    taskIds: readonly string[],
    scope: "self" | "children",
    hops: number,
  ): Promise<void>;
  /** `seedIds` and their descendants breadth first, at most `limit` ids, in walk order. */
  humanFreeAffected(seedIds: readonly string[], limit: number): Promise<string[]>;
  /** Recompute the stored flag of every task in `affected`. Returns the changed count. */
  applyHumanFreeBatch(affected: readonly string[]): Promise<number>;
  /** The tasks of `batch` with a child outside it, in batch order. */
  humanFreeUnfinished(batch: readonly string[]): Promise<string[]>;
  /** The oldest queue row. */
  humanFreeQueueHead(): Promise<HumanFreeQueueRow | null>;
  /** The oldest `self` queue rows, by `seq`, at most `limit`. */
  humanFreeQueueSelfRows(limit: number): Promise<HumanFreeQueueRow[]>;
  deleteHumanFreeQueueRows(seqs: readonly number[]): Promise<void>;
  setHumanFreeQueueCursor(seq: number, afterRowid: number): Promise<void>;
  countHumanFreeQueue(): Promise<number>;
  /**
   * One page of a parent's children past the insertion-order cursor `after`,
   * in insertion order; `position` is each child's cursor value.
   */
  listChildPage(
    parentId: string,
    after: number,
    limit: number,
  ): Promise<{ id: string; position: number }[]>;

  // ---- task_ui_specs / task_ui_action_runs ----
  findTaskUiSpec(taskId: string): Promise<TaskUiSpecRow | null>;
  /** Specs of the given tasks (at most a few hundred ids), in no particular order. */
  listTaskUiSpecs(taskIds: readonly string[]): Promise<TaskUiSpecRow[]>;
  /** Insert, or replace the spec of the task (`updated_at` = now). */
  upsertTaskUiSpec(row: TaskUiSpecRow & { userId: string | null }): Promise<void>;
  /** Inserts the run row unless it exists. Returns the inserted count (0 or 1). */
  reserveTaskUiActionRun(row: {
    taskId: string;
    actionId: string;
    surface: string;
    slackUserId: string | null;
    userId: string | null;
  }): Promise<number>;
  /** Deletes the run row while it has no result task. */
  releaseTaskUiActionRun(taskId: string, actionId: string): Promise<void>;
  setTaskUiActionResult(taskId: string, actionId: string, resultTaskId: string): Promise<void>;
  /**
   * Insert the run row, or take over its lease when it has no result task, no
   * lease past `now`, and no run at or after `cooldownCutoff`. Returns the
   * written count (0 or 1).
   */
  acquireTaskUiScriptActionRun(row: {
    taskId: string;
    actionId: string;
    surface: string;
    slackUserId: string | null;
    userId: string | null;
    lockedUntil: string;
    now: string;
    cooldownCutoff: string;
  }): Promise<number>;
  findTaskUiActionLease(taskId: string, actionId: string): Promise<TaskUiActionLeaseRow | null>;
  /** Frees the lease and records the run. */
  finishTaskUiScriptActionRun(
    taskId: string,
    actionId: string,
    error: string | null,
    now: string,
  ): Promise<void>;

  // ---- checklist_items ----
  /** Stores the default swarm rows, and the user's default row, unless they exist. */
  seedChecklistDefaults(userId: string | null): Promise<void>;
  /**
   * Swarm rows and the user's rows, with `statusChangedByName` (`Lead` for a
   * `lead:` changer, else the user's name). In no particular order.
   */
  listChecklistRows(userId: string | null): Promise<ChecklistItemRow[]>;
  findChecklistItem(id: string): Promise<ChecklistItemRow | null>;
  /** An open channel item of the scope and user whose meta names `adapter`. */
  findOpenChannelChecklistItem(
    scope: string,
    userId: string | null,
    adapter: string,
  ): Promise<{ id: string } | null>;
  /** One past the highest sortOrder of the scope and user (0 when empty). */
  nextChecklistSortOrder(scope: string, userId: string | null): Promise<number>;
  insertChecklistItem(item: NewChecklistItem): Promise<void>;
  setChecklistSortOrder(id: string, sortOrder: number, now: string, actor: string): Promise<void>;
  setChecklistStatus(
    id: string,
    status: string,
    reason: string | null,
    now: string,
    actor: string,
  ): Promise<void>;
  markChecklistNudged(id: string, taskId: string, now: string): Promise<void>;

  // ---- task_citations / task_attachments ----
  /** Insert, or replace the citation at `(taskId, index)` (`updated_at` = now). */
  upsertTaskCitation(
    taskId: string,
    citation: Omit<TaskCitationRow, "general"> & { general: boolean },
  ): Promise<void>;
  /** The task's citations by index. */
  listTaskCitations(taskId: string): Promise<TaskCitationRow[]>;
  /** Citations of the given tasks (a few hundred ids at most), by task id then index. */
  listTaskCitationsForTasks(
    taskIds: readonly string[],
  ): Promise<(TaskCitationRow & { taskId: string })[]>;
  /** The task's `output`; null for an unknown task. */
  findTaskOutput(taskId: string): Promise<{ output: string | null } | null>;
  /** Kind and url of the task's attachments, oldest first (ties: insertion order). */
  listTaskAttachmentUrls(taskId: string): Promise<{ kind: string; url: string | null }[]>;

  // ---- agent_tasks: runtime pool routing ----
  /**
   * Pending tasks waiting on a pool wake, or assigned to an agent of a pool
   * or with a pool runtime, except human-pinned ones. In no particular order.
   */
  listPoolPendingTasks(): Promise<TaskRow[]>;
  /** Back to `unassigned` while still pending for `agentId`, not waking, not human-pinned. */
  releasePendingPoolTask(taskId: string, agentId: string, now: string): Promise<number>;
  /** The agent's pending + in-progress task count, and the pending part. */
  countAgentOpenTasks(agentId: string): Promise<{ count: number; pending: number }>;
  countAgentPendingTasks(agentId: string): Promise<number>;

  // ---- deferred_task_waits / deferred_task_wait_members / deferred_event_waits ----
  /** Pending external event waits of the agent's enabled schedules. */
  countPendingEventWaitsForAgent(agentId: string): Promise<number>;
  /** One pending, enabled watcher of the agent that watches any of `taskIds`. */
  findPendingTaskWaitWatching(
    agentId: string,
    taskIds: readonly string[],
  ): Promise<{ scheduleId: string; parentTaskId: string } | null>;
  insertDeferredEventWait(row: {
    scheduleId: string;
    source: string;
    event: string;
    matchKey: string;
    matchJson: string;
    userId: string | null;
  }): Promise<void>;
  insertDeferredTaskWait(row: {
    scheduleId: string;
    eventName: string;
    mode: string;
    userId: string | null;
  }): Promise<void>;
  insertDeferredTaskWaitMember(
    scheduleId: string,
    taskId: string,
    userId: string | null,
  ): Promise<void>;

  // ---- deferred waits: wake resolution ----
  findDeferredTaskWait(scheduleId: string): Promise<DeferredTaskWaitRow | null>;
  findDeferredEventWait(scheduleId: string): Promise<DeferredEventWaitRow | null>;
  /** True when the schedule has a task or an event wait. */
  hasDeferredWait(scheduleId: string): Promise<boolean>;
  /**
   * The wait's members with the status waits see (a workflow step superseded
   * with `workflowReason` reads `failed`) and whether an enabled deferral of
   * the member is pending (0/1). In no particular order.
   */
  listDeferredWaitMembers(
    scheduleId: string,
    workflowReason: string,
  ): Promise<{ taskId: string; taskStatus: string | null; deferred: number }[]>;
  /** `pending` to `fired`. Returns the changed count. */
  claimDeferredWait(
    table: DeferredWaitTable,
    scheduleId: string,
    firedBy: string,
    now: string,
  ): Promise<number>;
  setDeferredWaitChild(
    table: DeferredWaitTable,
    scheduleId: string,
    childTaskId: string,
  ): Promise<void>;
  /** Members of pending waits whose task is superseded, with its first resume child. */
  listSupersededWaitMembers(): Promise<{ taskId: string; resumeTaskId: string }[]>;
  /**
   * Point members of pending waits from `taskId` to `resumeTaskId`; a member
   * that already watches the resume replaces the old one.
   */
  repointWaitMembers(taskId: string, resumeTaskId: string, now: string): Promise<void>;
  /** Point members of pending waits from `fromTaskId` to `toTaskId` (plain update). */
  transferWaitMembers(fromTaskId: string, toTaskId: string, now: string): Promise<void>;
  /**
   * Pending task waits of enabled schedules with a settled, not re-deferred
   * member that matches the wait's event, with that member's status
   * (optionally only for member `taskId`). Distinct rows, in no particular order.
   */
  listReadyDeferredTaskWaits(
    workflowReason: string,
    taskId?: string,
  ): Promise<(DeferredTaskWaitRow & { taskStatus: string })[]>;
  hasPendingEventWait(source: string, event: string): Promise<boolean>;
  /** Pending event waits of enabled schedules (optionally one target). In no particular order. */
  listPendingEventWaits(only?: {
    source: string;
    event: string;
    matchKey: string;
  }): Promise<Omit<DeferredEventWaitRow, "status">[]>;

  // ---- task_idempotency_keys ----
  findTaskIdempotencyKey(principal: string, keyHash: string): Promise<TaskIdempotencyKeyRow | null>;
  /** Plain insert: a duplicate `(principal, keyHash)` throws the engine's unique violation. */
  insertTaskIdempotencyKey(row: TaskIdempotencyKeyRow): Promise<void>;
  // ---- agent_tasks: Slack and VCS tracking ----
  /** Tasks of one Slack thread, by `createdAt` then insertion order. */
  listTasksInSlackThread(channelId: string, threadTs: string): Promise<TaskRow[]>;
  markTaskSlackReplySent(taskId: string): Promise<void>;
  /** Sets the Slack message columns present in `fields`; no-op when none is present. */
  setTaskSlackTracking(
    taskId: string,
    fields: { slackProgressMessageTs?: string | null; slackTreeRootMessageTs?: string | null },
  ): Promise<void>;
  setTaskVcs(
    taskId: string,
    vcs: { vcsProvider: string; vcsRepo: string; vcsNumber: number; vcsUrl: string },
    now: string,
  ): Promise<TaskRow | null>;

  // ---- task_attachments ----
  /** URLs of the task's `url` attachments, by `created_at` then id. */
  listUrlAttachmentUrls(taskId: string): Promise<string[]>;
  /**
   * The task's `url` attachments whose `capabilities` JSON has `capabilityKey`
   * equal to `source`, in insertion order.
   */
  listGeneratedUrlAttachments(
    taskId: string,
    capabilityKey: string,
    source: string,
  ): Promise<{ id: string; name: string; url: string }[]>;
  deleteTaskAttachment(id: string): Promise<number>;
  findTaskAttachmentBySha256(taskId: string, sha256: string): Promise<TaskAttachmentRow | null>;
  /** The oldest attachment with the same (kind, path, url, page_id, name); NULL compares as ''. */
  findTaskAttachmentByTuple(t: {
    taskId: string;
    kind: string;
    path: string;
    url: string;
    pageId: string;
    name: string;
  }): Promise<TaskAttachmentRow | null>;
  insertTaskAttachment(
    row: TaskAttachmentWrite & { id: string; task_id: string; created_by: string | null },
  ): Promise<TaskAttachmentRow | null>;
  replaceTaskAttachment(id: string, row: TaskAttachmentWrite): Promise<TaskAttachmentRow | null>;
  /** By `created_at` then insertion order. */
  listTaskAttachments(taskId: string): Promise<TaskAttachmentRow[]>;

  // ---- task_steering_messages ----
  insertSteeringMessage(row: NewSteeringMessage): Promise<TaskSteeringMessageRow | null>;
  /** One task's messages (optionally one status), by `created_at` then insertion order. */
  listSteeringMessages(taskId: string, status?: string): Promise<TaskSteeringMessageRow[]>;
  findSteeringMessage(id: string): Promise<TaskSteeringMessageRow | null>;
  /** Pending messages of the agent's tasks, by `created_at` then insertion order. */
  listPendingSteeringForAgent(
    agentId: string,
    readableBy?: { userId: string | null },
  ): Promise<TaskSteeringMessageRow[]>;
  /** pending -> delivered; `expectedTaskId` (when set) must match the row's task. */
  markSteeringDelivered(
    id: string,
    deliveredMode: string,
    expectedTaskId: string | null,
  ): Promise<TaskSteeringMessageRow | null>;
  /** delivered -> handled. */
  markSteeringHandled(id: string, note: string | null): Promise<TaskSteeringMessageRow | null>;
  /** pending -> promoted. */
  markSteeringPromoted(id: string, promotedTaskId: string): Promise<TaskSteeringMessageRow | null>;
  cancelPendingSteering(taskId: string): Promise<number>;
  hasPendingSteering(taskId: string): Promise<boolean>;
  // ---- agent_tasks: creation, routing snapshot, pool lifecycle ----
  /**
   * Recent non-terminal tasks created after `since`, optionally by creator or
   * target agent: newest `createdAt` first, then insertion order (newest first).
   */
  listRecentSimilarTasks(f: {
    since: string;
    creatorAgentId?: string;
    agentId?: string;
    limit: number;
  }): Promise<TaskRow[]>;
  /**
   * The newest task matching `match` whose holder (offeree while offered or
   * reviewing, else assignee) is a non-lead agent.
   */
  findLatestRoutingCandidate(
    match: RoutingCandidateMatch,
  ): Promise<{ taskId: string; agentId: string } | null>;
  /** Each non-lead agent with its open and active task counts, by agent id. */
  listRoutingWorkerStatuses(
    openStatuses: readonly string[],
  ): Promise<{ agentId: string; status: string; activeTaskCount: number; openTaskCount: number }[]>;
  findTaskKey(id: string): Promise<string | null>;
  insertTask(row: NewTaskRow): Promise<TaskRow | null>;
  insertRoutingDecision(row: RoutingDecisionRow): Promise<void>;
  /** unassigned -> in_progress for `agentId`. */
  /**
   * unassigned -> in_progress for `agentId`. The row is taken with
   * `FOR UPDATE SKIP LOCKED` (Postgres): a row another transaction holds is
   * skipped (null) instead of waited on, so the caller moves to its next candidate.
   */
  claimUnassignedTask(taskId: string, agentId: string, now: string): Promise<TaskRow | null>;
  /** Locks the task row for the rest of the transaction (Postgres `FOR UPDATE`) and returns it. */
  lockTask(taskId: string): Promise<TaskRow | null>;
  /**
   * pending/in_progress -> unassigned. With `wake`, only a pending, non-human-pinned
   * task still held by `wake.agentId` with the same `pool_wake_at`.
   */
  releaseTaskToPool(
    taskId: string,
    now: string,
    wake?: { agentId: string | null; poolWakeAt: string | null },
  ): Promise<TaskRow | null>;
  /** offered/reviewing -> pending for `agentId`. */
  acceptOfferedTask(taskId: string, agentId: string, now: string): Promise<TaskRow | null>;
  /** offered/reviewing -> unassigned, clearing the offer. */
  rejectOfferedTask(taskId: string, reason: string | null, now: string): Promise<TaskRow | null>;
  /** `from` -> `to` (plain status move, guarded on the current status). */
  moveTaskStatus(
    taskId: string,
    from: TaskStatus,
    to: TaskStatus,
    now: string,
  ): Promise<TaskRow | null>;
  /** draft -> offered / pending / unassigned (by offeree and assignee). */
  promoteDraftTask(taskId: string, now: string): Promise<TaskRow | null>;
  refreshDraftTaskLease(taskId: string, now: string): Promise<void>;
  promoteDraftsIdleSince(cutoff: string, now: string): Promise<number>;
  releaseReviewingIdleSince(cutoff: string, now: string): Promise<number>;
  /** Clears offers to deleted or offline agents, except agents in `reachable`. */
  releaseOffersOfOfflineAgents(now: string, reachable: readonly string[]): Promise<number>;
  /** By `createdAt` then insertion order. */
  listOfferedTasksForAgent(agentId: string): Promise<TaskRow[]>;
  countUnassignedTasks(): Promise<number>;
  /** The pool in claim order: priority (high first), `createdAt`, insertion order. */
  listUnassignedTaskIds(limit: number): Promise<string[]>;
  /** The pool in claim order: priority (high first), `createdAt`, insertion order. */
  listUnassignedTasks(limit: number, offset: number): Promise<TaskRow[]>;
  /** Tasks whose `dependsOn` JSON array holds `parentId`, in insertion order. */
  listDependentTasks(parentId: string): Promise<TaskRow[]>;
  // ---- agent_tasks: counts, heartbeat and triage reads ----
  /** Tasks with `status`, optionally of one assignee or offeree. */
  countTasksWithStatus(
    status: string,
    only?: { agentId?: string; offeredTo?: string },
  ): Promise<number>;
  /** Tasks created after `since` by lead agents, newest first (insertion order breaks ties). */
  listRecentLeadDelegations(
    since: string,
    readableBy?: { userId: string | null },
  ): Promise<ConcurrentTaskRow[]>;
  /** In-progress tasks across the swarm, newest first (insertion order breaks ties). */
  listActiveSwarmTasks(readableBy?: { userId: string | null }): Promise<ConcurrentTaskRow[]>;
  /** The newest task of an AgentMail thread (insertion order breaks ties). */
  findLatestTaskByAgentMailThread(threadId: string): Promise<TaskRow | null>;
  /** In-progress tasks idle since `cutoff`, oldest `lastUpdatedAt` first, then insertion order. */
  listStalledInProgressTasks(cutoff: string): Promise<TaskRow[]>;
  /** Pending protected pins created before `cutoff`, oldest first, then insertion order. */
  listStalePinnedResumes(cutoff: string): Promise<TaskRow[]>;
  /** pending -> `status` with its failure fields. */
  failPendingTask(
    taskId: string,
    f: { status: TaskStatus; statusKind: string; failureReason: string; now: string },
  ): Promise<TaskRow | null>;
  /** Unassigned tasks with routing affinity created before `cutoff`, oldest first, then insertion order. */
  listStaleUnassignedAffinityTasks(cutoff: string): Promise<TaskRow[]>;
  /** Failed tasks finished after `since`, newest `finishedAt` first, then insertion order (newest first). */
  listRecentFailedTasks(since: string, limit: number): Promise<TaskRow[]>;
  countTasksFinishedSince(status: string, since: string): Promise<number>;
  /** Tasks created in the last 24 hours (database clock). */
  countTasksCreatedLastDay(): Promise<number>;
  hasCompletedTask(): Promise<boolean>;
  /** Task counts per status, by status. */
  countTasksByStatus(): Promise<{ status: string; count: number }[]>;

  // ---- agent_tasks: workflow links ----
  /** Tasks linked to a run of the workflow, in insertion order. */
  listTaskIdsOfWorkflow(workflowId: string): Promise<string[]>;
  unlinkTasksFromWorkflow(workflowId: string): Promise<void>;
  findTaskByWorkflowRunStepId(stepId: string): Promise<TaskRow | null>;
  detachTaskFromWorkflowRunStep(taskId: string): Promise<void>;

  // ---- agent_tasks: credential keys ----
  /** In-progress tasks per key suffix of one key type, by suffix. */
  countInProgressByCredentialSuffix(
    keyType: string,
    suffixes: readonly string[],
  ): Promise<{ suffix: string; n: number }[]>;
  setTaskCredentialKey(taskId: string, keySuffix: string, keyType: string): Promise<void>;

  // ---- task_context_snapshots ----
  insertContextSnapshot(row: ContextSnapshotRow): Promise<void>;
  /** Folds one snapshot into the task's aggregate context columns. */
  applyContextSnapshotToTask(
    taskId: string,
    s: {
      contextPercent: number | null;
      contextUsedTokens: number | null;
      contextTotalTokens: number | null;
      compaction: boolean;
    },
  ): Promise<void>;
  /** One task's or one session's snapshots, by `createdAt` then insertion order. */
  listContextSnapshots(
    by: { taskId: string } | { sessionId: string },
    limit: number,
  ): Promise<ContextSnapshotRow[]>;
  countContextSnapshots(taskId: string): Promise<number>;

  // ---- task_templates ----
  /** By `createdAt` then insertion order. `query` matches title or description (lowercase LIKE). */
  listTaskTemplates(f: {
    category?: string;
    kind?: string;
    query?: string;
  }): Promise<TaskTemplateRow[]>;

  // ---- sessions: root chain ----
  /** The chain under `rootTaskId` with each task's `totalCostUsd`, by `createdAt` then insertion order. */
  listRootTaskChain(rootTaskId: string): Promise<TaskRow[]>;
  /** Tasks the user requested, or in a workflow run the user created; by id. */
  listTaskIdsRequestedByUser(userId: string): Promise<string[]>;

  // ---- agent_tasks: reads and writes of callers outside the tasks module ----
  /** One child of `parentTaskId` whose status is not in `terminalStatuses`. */
  findOpenChildTaskId(
    parentTaskId: string,
    terminalStatuses: readonly string[],
  ): Promise<string | null>;
  /**
   * Sets `dependsOn` of a dependent that still has `status` and still lists
   * `fromTaskId` (`lastUpdatedAt` = now). True when the row changed.
   */
  repointTaskDependency(
    taskId: string,
    status: string,
    fromTaskId: string,
    dependsOnJson: string,
  ): Promise<boolean>;
  /** The agent's `heartbeat-checklist` task with a status in `openStatuses`, if any. */
  findOpenHeartbeatChecklistTask(
    agentId: string,
    openStatuses: readonly string[],
  ): Promise<string | null>;
  /** The agent's `boot-triage` task with a status not in `terminalStatuses`, if any. */
  findOpenBootTriageTask(
    agentId: string,
    terminalStatuses: readonly string[],
  ): Promise<string | null>;
  /** Sets `runtime_instance_id` of the agent's task. */
  setTaskRuntimeInstance(taskId: string, agentId: string, runtimeInstanceId: string): Promise<void>;
  /**
   * Ids of `in_progress` tasks whose agent is not offline and updated at or
   * after `cutoff`. In no particular order (callers use the set).
   */
  listLiveInProgressTaskIds(cutoff: string): Promise<string[]>;
  /** How many of `taskIds` are `in_progress`. */
  countInProgressAmong(taskIds: readonly string[]): Promise<number>;
  /**
   * The claimable queue (pending/unassigned tasks whose dependencies all
   * completed): its size and its oldest task by the time it became claimable.
   */
  queueStallOldest(): Promise<{
    claimableCount: number;
    oldestTaskId: string | null;
    oldestClaimableAt: string | null;
  } | null>;
  /** True when a user exists or any task other than boot triage and the heartbeat checklist. */
  hasUserOrNonSystemTask(): Promise<boolean>;
  /**
   * The task tree under `rootId` (parentTaskId links, cycles end the walk):
   * how many tasks are not in `terminalStatuses`, whether an enabled
   * `deferred` schedule hangs off it (0/1), and its newest finish time.
   */
  taskTreeSettlement(
    rootId: string,
    terminalStatuses: readonly string[],
  ): Promise<{ open: number; deferred: number; lastFinishedAt: string | null } | null>;
  /**
   * Moves the pending and delivered steering messages of `fromTaskId` to
   * `toTaskId` as pending. Returns the moved ids, in no particular order.
   */
  carrySteeringMessages(fromTaskId: string, toTaskId: string): Promise<string[]>;
  /** Count of completed and failed tasks (NULL sums when there are none). */
  countFinishedTaskOutcomes(): Promise<{ completed: number | null; failed: number | null } | null>;
  /** Tasks created, completed and failed at or after `since` (NULL sums on an empty table). */
  countTaskActivitySince(since: string): Promise<{
    created: number | null;
    completed: number | null;
    failed: number | null;
  } | null>;
  /** Distinct requesting users of tasks created at or after `since`. */
  countDistinctRequestersSince(since: string): Promise<number>;
  /**
   * `source` of the topmost task reached from `taskId` through parent links,
   * at most `maxDepth` hops up; null when the task does not exist.
   */
  findRootTaskSource(taskId: string, maxDepth: number): Promise<{ source: string | null } | null>;
  findTaskStatus(taskId: string): Promise<string | null>;
  findTaskParentId(taskId: string): Promise<{ parentTaskId: string | null } | null>;
  /** Records the claim-time model resolution of a task. */
  setTaskModelResolution(
    taskId: string,
    r: {
      resolvedModel: string | null;
      modelSource: string | null;
      modelAlias: string | null;
      resolvedProfile: string | null;
    },
  ): Promise<void>;
  /** Clears the claim-time model resolution when any part is set. */
  clearTaskModelResolution(taskId: string): Promise<void>;
  /** True when the agent has a task that resolved to, or (unresolved) pinned, `modelId`. */
  agentRanModel(agentId: string, modelId: string): Promise<boolean>;
  /** Slack thread and type of the given tasks. In no particular order. */
  listTaskSlackThreads(taskIds: readonly string[]): Promise<
    {
      slackChannelId: string | null;
      slackThreadTs: string | null;
      taskType: string | null;
    }[]
  >;
  /** Ids of the tasks of the runs not in `terminalStatuses`. In no particular order. */
  listOpenTaskIdsOfRuns(
    runIds: readonly string[],
    terminalStatuses: readonly string[],
  ): Promise<string[]>;
  /** True when a task of the runs is not in `terminalStatuses`. */
  hasOpenTaskOfRuns(
    runIds: readonly string[],
    terminalStatuses: readonly string[],
  ): Promise<boolean>;
  /**
   * Distinct ids listed in `dependsOn` of the tasks not in `terminalStatuses`.
   * In no particular order (callers use the set).
   */
  listDependedOnTaskIds(terminalStatuses: readonly string[]): Promise<string[]>;
  /**
   * The row a citation of `kind` points at (`content` for a memory, `id`
   * otherwise); null when it does not exist.
   */
  findCitationTarget(
    kind: TaskCitationTargetKind,
    ref: string,
  ): Promise<{ id?: string; content?: string } | null>;
  /**
   * SQL expressions (0/1) for task-reporting queries over the task alias
   * `alias`: any attachment or PR in the output, and a PR attachment or PR in
   * the output. `host` is the GitHub host, lower case. Matches
   * `extractGitHubPullRequestUrls`.
   */
  shippingEvidenceSql(
    alias: string,
    host: string,
  ): { hasArtifact: SqlQuery; hasPullRequest: SqlQuery };
  /**
   * Per human requester: root tasks in the window and those that shipped (a
   * page or a PR/MR attachment, or a PR/MR URL in any task output of the root's
   * tree). Excludes human-free rows. Unordered: the caller indexes by user.
   */
  listAttributionRoots(
    window: AttributionWindow,
    githubHost: string,
  ): Promise<AttributionRootRow[]>;
  /** Per human requester: distinct agents, repos and sources of the window's tasks. Unordered. */
  listAttributionReach(window: AttributionWindow): Promise<AttributionReachRow[]>;
}

/** The task window of the attribution report: `createdAt` bounds, ISO text. */
export type AttributionWindow = {
  startDate?: string;
  /** Exclusive upper bound (a date-only end becomes the next day's midnight). */
  endBefore?: string;
  /** Inclusive upper bound (an exact instant). */
  endAtOrBefore?: string;
};

/** Root tasks per requester in the window, and how many shipped (PR, MR or page). */
export type AttributionRootRow = { userId: string; initiated: number; shipped: number };
/** Distinct agents, repos and sources per requester in the window. */
export type AttributionReachRow = {
  userId: string;
  agentsReached: number;
  reposReached: number;
  surfacesReached: number;
};

/** The citation kinds whose target row can be checked. */
export type TaskCitationTargetKind = "task" | "memory" | "page" | "script-run";

export abstract class BaseTasksRepository implements TasksRepository {
  constructor(protected readonly db: SqlExecutor) {}

  // ---- agent_tasks: drafts and Slack folds ----

  async appendDraftTaskText(taskId: string, suffix: string, now: string): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE agent_tasks SET task = task || ${suffix}, "lastUpdatedAt" = ${now}
      WHERE id = ${taskId} AND status = 'draft'`);
    return result.changes;
  }

  async foldPendingTaskText(args: {
    taskId: string;
    expectedTask: string;
    nextTask: string;
    toDraft: boolean;
    slackParticipants: string | null;
    now: string;
  }): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE agent_tasks
         SET task = ${args.nextTask},
             status = CASE WHEN ${args.toDraft} THEN 'draft' ELSE status END,
             "slackParticipants" = COALESCE(${jsonText(args.slackParticipants)}, "slackParticipants"),
             "lastUpdatedAt" = ${args.now}
         WHERE id = ${args.taskId} AND status = 'pending' AND task = ${args.expectedTask}`);
    return result.changes;
  }

  /** Reads a JSON field of `agent_log.metadata` (SQLite `json_extract`). */
  abstract listDeliveredSlackMessageTs(
    channelId: string,
    threadTs: string,
  ): Promise<(string | null)[]>;

  /**
   * The insertion-order column of `agent_tasks` (SQLite `rowid`), for ORDER BY
   * tiebreaks only. `alias` is a table alias chosen by code, or empty.
   */
  protected abstract insertionOrder(alias?: string): SqlQuery;

  /**
   * The contextKey `source` filter: none for a null `source`; `'chat'` also
   * matches a deferred wake-up of a chat task (`source = 'schedule'`,
   * `taskType = 'deferred'`). `alias` is a table alias prefix chosen by code.
   */
  protected contextKeySource(source: string | null, alias = ""): SqlQuery {
    if (source === null) return sql`1 = 1`;
    const col = (name: string) => new SqlQuery([`${alias}${name}`], []);
    if (source !== "chat") return sql`${col("source")} = ${source}`;
    return sql`(${col("source")} = ${source}
          OR (${col("source")} = 'schedule' AND ${col('"taskType"')} = 'deferred'))`;
  }

  // ---- agent_tasks: reads ----

  findTaskById(id: string): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`SELECT * FROM agent_tasks WHERE id = ${id}`);
  }

  listChildTasks(parentTaskId: string): Promise<TaskRow[]> {
    return this.db.query<TaskRow>(sql`
      SELECT * FROM agent_tasks WHERE "parentTaskId" = ${parentTaskId}
      ORDER BY "createdAt" ASC, ${this.insertionOrder()} ASC`);
  }

  async hasOpenChildOfType(parentId: string, taskType: string): Promise<boolean> {
    const row = await this.db.get(sql`
      SELECT 1 FROM agent_tasks
        WHERE "parentTaskId" = ${parentId}
          AND "taskType" = ${taskType}
          AND status NOT IN ${TERMINAL}
        LIMIT 1`);
    return row !== undefined && row !== null;
  }

  listSupersededWithoutResume(
    finishedBefore: string,
    finishedAfter: string,
    workflowReason: string,
  ): Promise<TaskRow[]> {
    return this.db.query<TaskRow>(sql`
      SELECT * FROM agent_tasks t
        WHERE t.status = 'superseded'
          AND t."workflowRunStepId" IS NULL
          AND t."failureReason" IS DISTINCT FROM ${workflowReason}
          AND t."finishedAt" < ${finishedBefore}
          AND t."finishedAt" > ${finishedAfter}
          AND NOT EXISTS (
            SELECT 1 FROM agent_tasks c WHERE c."parentTaskId" = t.id AND c."taskType" = 'resume'
          )
        ORDER BY t."finishedAt" ASC`);
  }

  /** Expands the `dependsOn` JSON array (SQLite `json_each`). */
  abstract listSupersededWithUnsettledDependents(
    finishedBefore: string,
    finishedAfter: string,
    neverStartedStatuses: readonly string[],
  ): Promise<{ taskId: string; resumeTaskId: string }[]>;

  listTasksByAgent(agentId: string, readableBy?: { userId: string | null }): Promise<TaskRow[]> {
    const readable = readableBy
      ? sql` AND ${readableSessionSql(readableBy.userId, sql`agent_tasks.id`)}`
      : EMPTY;
    return this.db.query<TaskRow>(sql`
      SELECT * FROM agent_tasks WHERE "agentId" = ${agentId}${readable} ORDER BY "createdAt" DESC`);
  }

  /** Reads the id list as a JSON array (SQLite `json_each`). */
  abstract listTasksDispatchedFrom(taskIds: readonly string[]): Promise<TaskRow[]>;

  findAgentCurrentTask(agentId: string): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      SELECT * FROM agent_tasks WHERE "agentId" = ${agentId} AND status = 'in_progress'
      ORDER BY "lastUpdatedAt" DESC LIMIT 1`);
  }

  listTasksByStatus(status: string): Promise<TaskRow[]> {
    return this.db.query<TaskRow>(
      sql`SELECT * FROM agent_tasks WHERE status = ${status} ORDER BY "createdAt" DESC`,
    );
  }

  protected vcsScope(v: TaskVcsScope): SqlQuery {
    const provider = v.includeNullProvider
      ? sql`("vcsProvider" = ${v.provider} OR "vcsProvider" IS NULL)`
      : sql`"vcsProvider" = ${v.provider}`;
    return sql`"vcsRepo" = ${v.repo} AND "vcsNumber" = ${v.number} AND ${provider}
       AND status NOT IN ${TERMINAL}`;
  }

  findActiveTaskByVcs(scope: TaskVcsScope): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      SELECT * FROM agent_tasks WHERE ${this.vcsScope(scope)}
      ORDER BY "createdAt" DESC LIMIT 1`);
  }

  listActiveTasksByVcs(scope: TaskVcsScope): Promise<TaskRow[]> {
    return this.db.query<TaskRow>(sql`
      SELECT * FROM agent_tasks WHERE ${this.vcsScope(scope)}
      ORDER BY "createdAt" DESC`);
  }

  async taskStats(): Promise<TaskStatsRow | null> {
    const row = await this.db.get<Record<keyof TaskStatsRow, number | string | null>>(sql`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'unassigned' THEN 1 ELSE 0 END) as unassigned,
        SUM(CASE WHEN status = 'offered' THEN 1 ELSE 0 END) as offered,
        SUM(CASE WHEN status = 'reviewing' THEN 1 ELSE 0 END) as reviewing,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) as paused,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM agent_tasks`);
    return row as TaskStatsRow | null;
  }

  listFinishedSlackTasks(): Promise<TaskRow[]> {
    return this.db.query<TaskRow>(sql`
      SELECT * FROM agent_tasks
        WHERE "slackChannelId" IS NOT NULL
        AND status IN ('completed', 'failed')
        ORDER BY "lastUpdatedAt" DESC
        LIMIT 200`);
  }

  listUnnotifiedFinishedWorkerTasks(): Promise<TaskRow[]> {
    return this.db.query<TaskRow>(sql`
      SELECT t.* FROM agent_tasks t
        LEFT JOIN agents a ON t."agentId" = a.id
        WHERE t.status IN ('completed', 'failed')
        AND t."finishedAt" IS NOT NULL
        AND t."notifiedAt" IS NULL
        AND (a."isLead" = ${false} OR a."isLead" IS NULL)
        ORDER BY t."finishedAt" DESC LIMIT 50`);
  }

  async markTasksNotified(taskIds: readonly string[], now: string): Promise<number> {
    if (taskIds.length === 0) return 0;
    const result = await this.db.run(sql`
      UPDATE agent_tasks SET "notifiedAt" = ${now}
      WHERE id IN (${sqlList(taskIds)}) AND "notifiedAt" IS NULL`);
    return result.changes;
  }

  async resetTasksNotified(taskIds: readonly string[]): Promise<number> {
    if (taskIds.length === 0) return 0;
    const result = await this.db.run(sql`
      UPDATE agent_tasks SET "notifiedAt" = NULL
      WHERE id IN (${sqlList(taskIds)}) AND "notifiedAt" IS NOT NULL`);
    return result.changes;
  }

  listInProgressSlackTasks(): Promise<TaskRow[]> {
    return this.db.query<TaskRow>(sql`
      SELECT * FROM agent_tasks
        WHERE "slackChannelId" IS NOT NULL
        AND status = 'in_progress'
        ORDER BY "lastUpdatedAt" DESC
        LIMIT 200`);
  }

  listTasksByContextKey(contextKey: string, statuses: readonly string[]): Promise<TaskRow[]> {
    if (statuses.length === 0) return Promise.resolve([]);
    return this.db.query<TaskRow>(sql`
      SELECT * FROM agent_tasks
        WHERE "contextKey" = ${contextKey}
        AND status IN (${sqlList(statuses)})
        ORDER BY "lastUpdatedAt" DESC
        LIMIT 200`);
  }

  findTrackerContextTask(
    contextKey: string,
    delegatingParentTaskId: string | null,
    kind: "active" | "linkedPr",
  ): Promise<TaskRow | null> {
    const filter =
      kind === "active"
        ? sql`status NOT IN ${TERMINAL}`
        : sql`status = 'completed'
          AND "vcsProvider" IS NOT NULL
          AND "vcsRepo" IS NOT NULL
          AND "vcsNumber" IS NOT NULL
          AND "vcsUrl" IS NOT NULL`;
    return this.db.get<TaskRow>(sql`
      WITH RECURSIVE
        ancestors(id, "parentTaskId") AS (
          SELECT id, "parentTaskId" FROM agent_tasks
            WHERE id = ${delegatingParentTaskId} AND "contextKey" = ${contextKey}
          UNION
          SELECT parent.id, parent."parentTaskId" FROM agent_tasks parent
          JOIN ancestors child ON parent.id = child."parentTaskId"
          WHERE parent."contextKey" = ${contextKey}
        ),
        lineage(id) AS (
          SELECT id FROM ancestors
          WHERE "parentTaskId" IS NULL OR "parentTaskId" NOT IN (SELECT id FROM ancestors)
          UNION
          SELECT child.id FROM agent_tasks child
          JOIN lineage parent ON child."parentTaskId" = parent.id
        )
      SELECT * FROM agent_tasks
        WHERE "contextKey" = ${contextKey}
        AND id NOT IN (SELECT id FROM lineage)
        AND ${filter}
        ORDER BY "lastUpdatedAt" DESC
        LIMIT 1`);
  }

  findLatestTaskByContextKey(
    contextKey: string,
    opts: { requestedByUserId?: string; notRequestedByUserId?: string },
  ): Promise<TaskRow | null> {
    const mine =
      opts.requestedByUserId !== undefined
        ? sql` AND "requestedByUserId" = ${opts.requestedByUserId}`
        : EMPTY;
    const others =
      opts.notRequestedByUserId !== undefined
        ? sql` AND "requestedByUserId" IS DISTINCT FROM ${opts.notRequestedByUserId}`
        : EMPTY;
    return this.db.get<TaskRow>(sql`
      SELECT * FROM agent_tasks
        WHERE "contextKey" = ${contextKey}${mine}${others}
        ORDER BY "createdAt" DESC
        LIMIT 1`);
  }

  findLatestScriptRunStepTask(contextKey: string): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      SELECT * FROM agent_tasks
        WHERE "contextKey" = ${contextKey}
        AND "taskType" = 'script-run-step'
        ORDER BY "createdAt" DESC, ${this.insertionOrder()} DESC
        LIMIT 1`);
  }

  findLatestSlackIngressTaskInThread(channelId: string, threadTs: string): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      SELECT * FROM agent_tasks
        WHERE source = 'slack'
        AND "slackChannelId" = ${channelId}
        AND "slackThreadTs" = ${threadTs}
        ORDER BY "createdAt" DESC
        LIMIT 1`);
  }

  findLatestActiveSlackTaskInThread(channelId: string, threadTs: string): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      SELECT * FROM agent_tasks
        WHERE source = 'slack'
        AND "slackChannelId" = ${channelId}
        AND "slackThreadTs" = ${threadTs}
        AND status IN ('in_progress', 'pending')
        ORDER BY "createdAt" DESC, ${this.insertionOrder()} DESC
        LIMIT 1`);
  }

  findLatestLeadSlackTaskInThread(channelId: string, threadTs: string): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      SELECT t.*
        FROM agent_tasks t
        JOIN agents a ON a.id = t."agentId"
        WHERE t.source = 'slack'
          AND t."slackChannelId" = ${channelId}
          AND t."slackThreadTs" = ${threadTs}
          AND a."isLead" = ${true}
        ORDER BY t."createdAt" DESC, ${this.insertionOrder("t")} DESC
        LIMIT 1`);
  }

  async findLatestAgentIdOnContextKey(
    contextKey: string,
    source: string | null,
    endedSince: string | null,
    terminalStatuses: readonly string[],
  ): Promise<string | null> {
    const row = await this.db.get<{ agentId: string | null }>(sql`
      SELECT "agentId" FROM agent_tasks
        WHERE "contextKey" = ${contextKey}
        AND ${this.contextKeySource(source)}
        AND ${
          endedSince === null
            ? sql`1 = 1`
            : sql`(status NOT IN (${sqlList(terminalStatuses)}) OR "finishedAt" >= ${endedSince})`
        }
        ORDER BY "createdAt" DESC, ${this.insertionOrder()} DESC
        LIMIT 1`);
    return row?.agentId ?? null;
  }

  findLatestTaskInContextKeyRange(
    lower: string,
    upper: string,
    opts: { source: string | null; activeOnly: boolean; requestedByUserId?: string },
  ): Promise<TaskRow | null> {
    const active = opts.activeOnly ? sql` AND status IN ('in_progress', 'pending')` : EMPTY;
    const mine =
      opts.requestedByUserId !== undefined
        ? sql` AND "requestedByUserId" = ${opts.requestedByUserId}`
        : EMPTY;
    return this.db.get<TaskRow>(sql`
      SELECT * FROM agent_tasks
        WHERE "contextKey" >= ${lower} AND "contextKey" < ${upper}
        AND ${this.contextKeySource(opts.source)}${active}${mine}
        ORDER BY "createdAt" DESC, ${this.insertionOrder()} DESC
        LIMIT 1`);
  }

  findLatestActiveTaskByContextKey(
    contextKey: string,
    source: string | null,
    requestedByUserId?: string,
  ): Promise<TaskRow | null> {
    const mine =
      requestedByUserId !== undefined
        ? sql` AND "requestedByUserId" = ${requestedByUserId}`
        : EMPTY;
    return this.db.get<TaskRow>(sql`
      SELECT * FROM agent_tasks
        WHERE "contextKey" = ${contextKey}
        AND ${this.contextKeySource(source)}
        AND status IN ('in_progress', 'pending')${mine}
        ORDER BY "createdAt" DESC, ${this.insertionOrder()} DESC
        LIMIT 1`);
  }

  findLatestLeadTaskByContextKey(
    contextKey: string,
    source: string | null,
  ): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      SELECT t.*
        FROM agent_tasks t
        JOIN agents a ON a.id = t."agentId"
        WHERE t."contextKey" = ${contextKey}
          AND ${this.contextKeySource(source, "t.")}
          AND a."isLead" = ${true}
        ORDER BY t."createdAt" DESC, ${this.insertionOrder("t")} DESC
        LIMIT 1`);
  }

  findFirstTaskInThread(channelId: string, threadTs: string): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      SELECT * FROM agent_tasks
        WHERE "slackChannelId" = ${channelId}
        AND "slackThreadTs" = ${threadTs}
        ORDER BY "createdAt" ASC
        LIMIT 1`);
  }

  findMostRecentTaskInThread(channelId: string, threadTs: string): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      SELECT * FROM agent_tasks
        WHERE "slackChannelId" = ${channelId}
        AND "slackThreadTs" = ${threadTs}
        ORDER BY "createdAt" DESC
        LIMIT 1`);
  }

  listCompletedTasksInThread(
    channelId: string,
    threadTs: string,
    since: string,
    limit: number,
    before?: { lastUpdatedAt: string; id: string },
  ): Promise<TaskRow[]> {
    const cursor = before
      ? sql` AND ("lastUpdatedAt" < ${before.lastUpdatedAt} OR ("lastUpdatedAt" = ${before.lastUpdatedAt} AND id < ${before.id}))`
      : EMPTY;
    return this.db.query<TaskRow>(sql`
      SELECT * FROM agent_tasks
        WHERE "slackChannelId" = ${channelId}
        AND "slackThreadTs" = ${threadTs}
        AND status = 'completed'
        AND COALESCE("taskType", '') != 'follow-up'
        AND "lastUpdatedAt" > ${since}${cursor}
        ORDER BY "lastUpdatedAt" DESC, id DESC
        LIMIT ${limit}`);
  }

  findRecentFailedTaskInThread(
    channelId: string,
    threadTs: string,
    since: string,
  ): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      SELECT * FROM agent_tasks
        WHERE "slackChannelId" = ${channelId}
        AND "slackThreadTs" = ${threadTs}
        AND status = 'failed'
        AND "lastUpdatedAt" > ${since}
        ORDER BY "lastUpdatedAt" DESC
        LIMIT 1`);
  }

  findRecentCancelledTaskInThread(
    channelId: string,
    threadTs: string,
    since: string,
  ): Promise<TaskRow | null> {
    const reason = sql`"failureReason"`;
    return this.db.get<TaskRow>(sql`
      SELECT * FROM agent_tasks
        WHERE "slackChannelId" = ${channelId}
        AND "slackThreadTs" = ${threadTs}
        AND "lastUpdatedAt" > ${since}
        AND (
          status = 'cancelled'
          OR (
            status = 'failed'
            AND "failureReason" IS NOT NULL
            AND (
              ${likeAsciiCi(reason, sql`'cancelled%'`)}
              OR ${likeAsciiCi(reason, sql`'exit 130%'`)}
              OR ${likeAsciiCi(reason, sql`'%cancelled%'`)}
            )
          )
        )
        ORDER BY "lastUpdatedAt" DESC
        LIMIT 1`);
  }

  /** Cuts the run prefix out of a contextKey (SQLite `instr`). */
  abstract countAgentDispatchesInThread(
    channelId: string,
    threadTs: string,
    creatorAgentId: string,
    since: string,
  ): Promise<number>;

  // ---- agent_tasks: lists, counts, lineage ----

  /** Pages through the insertion-order column and builds list projections (SQLite `rowid`, BLOB cuts). */
  abstract listTasks<F extends TaskListFields>(
    filters: TaskListFilters,
    page: TaskListPage,
    fields: F,
  ): Promise<TaskListRow<F>[]>;

  /**
   * The WHERE term of a free-text task search (SQLite FTS5 MATCH). `purpose`
   * picks the plan: a page stops at its LIMIT, a count reads every row.
   */
  protected abstract taskSearchCondition(
    search: string,
    purpose: "page" | "count",
  ): Promise<SqlQuery>;

  /**
   * The selective filter terms, in today's order. The heartbeat and
   * readability terms are separate: a page plans differently without
   * selective terms.
   */
  protected async taskFilterConditions(
    f: TaskListFilters,
    purpose: "page" | "count",
  ): Promise<SqlQuery[]> {
    const c: SqlQuery[] = [];
    if (f.statuses && f.statuses.length === 1) c.push(sql`status = ${f.statuses[0] as string}`);
    else if (f.statuses && f.statuses.length > 1) c.push(sql`status IN (${sqlList(f.statuses)})`);
    if (f.statusKind) c.push(sql`"statusKind" = ${f.statusKind}`);
    if (f.agentId) c.push(sql`"agentId" = ${f.agentId}`);
    if (f.search) c.push(await this.taskSearchCondition(f.search, purpose));
    if (f.unassigned) c.push(sql`("agentId" IS NULL OR status = 'unassigned')`);
    if (f.offeredTo) c.push(sql`"offeredTo" = ${f.offeredTo}`);
    if (f.taskType) c.push(sql`"taskType" = ${f.taskType}`);
    if (f.tags && f.tags.length > 0) {
      const tags = f.tags.map(
        (tag) => sql`${likeAsciiCi(sql`CAST(tags AS text)`, sql`${`%"${tag}"%`}`)}`,
      );
      c.push(sql`(${sqlJoin(tags, sql` OR `)})`);
    }
    if (f.scheduleId) c.push(sql`"scheduleId" = ${f.scheduleId}`);
    if (f.workflowRunId) c.push(sql`"workflowRunId" = ${f.workflowRunId}`);
    if (f.key) c.push(sql`"key" = ${f.key}`);
    else if (f.keyPrefixPattern) {
      c.push(sql`${likeAsciiCi(sql`"key"`, sql`${f.keyPrefixPattern}`, "\\")}`);
    }
    if (f.sources && f.sources.length > 0) c.push(sql`source IN (${sqlList(f.sources)})`);
    if (f.createdAfter) c.push(sql`"createdAt" >= ${f.createdAfter}`);
    if (f.createdBefore) c.push(sql`"createdAt" < ${f.createdBefore}`);
    if (f.requestedByUserIdIsNull) c.push(sql`"requestedByUserId" IS NULL`);
    else if (f.requestedByUserId) c.push(sql`"requestedByUserId" = ${f.requestedByUserId}`);
    return c;
  }

  /** Leaves out heartbeat, heartbeat-checklist and boot-triage tasks. */
  protected notHeartbeat(): SqlQuery {
    return sql`(COALESCE("taskType", '') NOT IN ('heartbeat', 'heartbeat-checklist', 'boot-triage') AND NOT ${likeAsciiCi(sql`CAST(tags AS text)`, sql`'%"heartbeat"%'`)})`;
  }

  async countTasks(filters: TaskListFilters): Promise<number> {
    const conditions = await this.taskFilterConditions(filters, "count");
    if (!filters.includeHeartbeat) conditions.push(this.notHeartbeat());
    if (filters.readableBy) {
      conditions.push(readableSessionSql(filters.readableBy.userId, sql`agent_tasks.id`));
    }
    const row = await this.db.get<{ count: number | string }>(
      sql`SELECT COUNT(*) as count FROM agent_tasks${sqlWhere(conditions)}`,
    );
    return Number(row?.count ?? 0);
  }

  listTaskAncestors(
    taskId: string,
    maxAncestors: number,
  ): Promise<{ id: string; parentTaskId: string | null; hops: number }[]> {
    return this.db.query(sql`
      WITH RECURSIVE up(id, "parentTaskId", hops) AS (
          SELECT id, "parentTaskId", 0 FROM agent_tasks WHERE id = ${taskId}
          UNION ALL
          SELECT t.id, t."parentTaskId", up.hops + 1 FROM agent_tasks t
          JOIN up ON t.id = up."parentTaskId"
          WHERE up.hops < ${maxAncestors}
        )
        SELECT id, "parentTaskId", hops FROM up ORDER BY hops`);
  }

  /** LIMIT inside the recursive term and the slim projection are SQLite-specific. */
  abstract listTaskDescendants(
    startId: string,
    maxDepth: number,
    limit: number,
  ): Promise<TaskLineageRow[]>;
  /** The slim projection is SQLite-specific (BLOB prefix). */
  abstract listTaskLineageRows(ids: readonly string[]): Promise<TaskLineageRow[]>;

  async hasChildOutside(ids: readonly string[]): Promise<boolean> {
    const row = await this.db.get(sql`
      SELECT 1 FROM agent_tasks
      WHERE "parentTaskId" IN (${sqlList(ids)}) AND id NOT IN (${sqlList(ids)}) LIMIT 1`);
    return row !== undefined && row !== null;
  }

  // ---- agent_tasks_fts ----

  /** The FTS state table is SQLite-specific (FTS5 backfill). */
  abstract getTaskFtsIndexedThrough(): Promise<number | null>;
  /** Writes FTS5 rows keyed by `rowid`. */
  abstract indexTaskFtsBatch(batchSize: number): Promise<{ changes: number; done: boolean }>;
  /** Reads `pragma_database_list`. */
  abstract mainDatabaseFile(): Promise<string | null>;

  // ---- agent_tasks: lifecycle writes ----

  insertSimpleTask(t: NewSimpleTask): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      INSERT INTO agent_tasks (id, "key", "agentId", task, status, source, "slackChannelId", "slackThreadTs",
        "slackUserId", "swarmVersion", "isHumanFree", "createdAt", "lastUpdatedAt")
      VALUES (${t.id}, ${t.key}, ${t.agentId}, ${t.task}, ${t.status}, ${t.source}, ${t.slackChannelId},
        ${t.slackThreadTs}, ${t.slackUserId}, ${t.swarmVersion}, ${t.isHumanFree}, ${nowIso}, ${nowIso})
      RETURNING *`);
  }

  listPendingTasksForAgent(agentId: string): Promise<TaskRow[]> {
    return this.db.query<TaskRow>(sql`
      SELECT * FROM agent_tasks WHERE "agentId" = ${agentId} AND status = 'pending'
      ORDER BY priority DESC, "createdAt" ASC`);
  }

  assignUnassignedTask(args: {
    taskId: string;
    agentId: string;
    now: string;
    poolWakeAt: string | null;
    guards: TaskAssignGuards;
  }): Promise<TaskRow | null> {
    const { snapshot, pool } = args.guards;
    const snapshotGuard = snapshot
      ? sql` AND "lastUpdatedAt" = ${snapshot.taskLastUpdatedAt}
        AND EXISTS (SELECT 1 FROM agents WHERE id = ${args.agentId} AND "lastUpdatedAt" = ${snapshot.agentLastUpdatedAt}
          AND (SELECT COUNT(*) FROM agent_tasks WHERE "agentId" = agents.id
            AND status IN ('pending', 'in_progress')) < COALESCE("maxTasks", 1))`
      : EMPTY;
    const poolGuard = pool
      ? sql` AND EXISTS (SELECT 1 FROM runtime_pools WHERE id = ${pool.id} AND updated_at = ${pool.updatedAt}
        AND enabled = ${true} AND (circuit_open_until IS NULL OR circuit_open_until <= ${pool.at}))`
      : EMPTY;
    return this.db.get<TaskRow>(sql`
      UPDATE agent_tasks SET "agentId" = ${args.agentId}, status = 'pending', "lastUpdatedAt" = ${args.now},
        pool_wake_at = ${args.poolWakeAt}
      WHERE id = ${args.taskId} AND status = 'unassigned'${snapshotGuard}${poolGuard} RETURNING *`);
  }

  startTask(taskId: string): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      UPDATE agent_tasks SET status = 'in_progress', "lastUpdatedAt" = ${nowIso}
      WHERE id = ${taskId} AND status NOT IN ${TERMINAL} RETURNING *`);
  }

  setTaskSessionColumns(
    taskId: string,
    values: Partial<Record<TaskSessionColumn, string | null>>,
    now: string,
  ): Promise<TaskRow | null> {
    const sets: SqlQuery[] = [sql`"lastUpdatedAt" = ${now}`];
    for (const [column, value] of Object.entries(values)) {
      if (value === undefined) continue;
      const bound = TASK_JSON_SESSION_COLUMNS.has(column) ? sql`${jsonText(value)}` : sql`${value}`;
      sets.push(sql`${sqlIdent(column)} = ${bound}`);
    }
    return this.db.get<TaskRow>(
      sql`UPDATE agent_tasks SET ${sqlJoin(sets, sql`, `)} WHERE id = ${taskId} RETURNING *`,
    );
  }

  async setTaskProviderIfUnset(taskId: string, provider: string): Promise<void> {
    await this.db.run(
      sql`UPDATE agent_tasks SET provider = ${provider} WHERE id = ${taskId} AND provider IS NULL`,
    );
  }

  setTaskTitle(taskId: string, title: string | null): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(
      sql`UPDATE agent_tasks SET title = ${title} WHERE id = ${taskId} RETURNING *`,
    );
  }

  setTaskTitleIfUnset(taskId: string, title: string): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(
      sql`UPDATE agent_tasks SET title = ${title} WHERE id = ${taskId} AND title IS NULL RETURNING *`,
    );
  }

  findTaskTags(taskId: string): Promise<{ tags: string | null } | null> {
    return this.db.get<{ tags: string | null }>(
      sql`SELECT tags FROM agent_tasks WHERE id = ${taskId}`,
    );
  }

  setTaskTags(taskId: string, tagsJson: string, touch: boolean): Promise<TaskRow | null> {
    const touched = touch ? sql`, "lastUpdatedAt" = ${nowIso}` : EMPTY;
    return this.db.get<TaskRow>(
      sql`UPDATE agent_tasks SET tags = ${jsonText(tagsJson)}${touched} WHERE id = ${taskId} RETURNING *`,
    );
  }

  finishTask(id: string, f: TaskFinish): Promise<TaskRow | null> {
    const reason =
      f.failureReason === undefined ? EMPTY : sql`, "failureReason" = ${f.failureReason}`;
    const cas =
      f.expectedLastUpdatedAt === undefined
        ? EMPTY
        : sql` AND "lastUpdatedAt" = ${f.expectedLastUpdatedAt}`;
    return this.db.get<TaskRow>(sql`
      UPDATE agent_tasks SET status = ${f.status}, "statusKind" = ${f.statusKind}${reason},
        "finishedAt" = ${f.finishedAt}, "lastUpdatedAt" = ${nowIso}
      WHERE id = ${id} AND status NOT IN ${TERMINAL}${cas} RETURNING *`);
  }

  setTaskOutput(id: string, output: string): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      UPDATE agent_tasks SET output = ${output}, "lastUpdatedAt" = ${nowIso} WHERE id = ${id} RETURNING *`);
  }

  setTaskDeferral(
    id: string,
    deferredAt: string,
    deferredUntil: string | null,
  ): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      UPDATE agent_tasks SET "deferredAt" = ${deferredAt}, "deferredUntil" = ${deferredUntil},
        "lastUpdatedAt" = ${nowIso}
      WHERE id = ${id} RETURNING *`);
  }

  overwriteTerminalResultText(
    id: string,
    output: string | null,
    failureReason: string | null,
  ): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      UPDATE agent_tasks SET output = ${output}, "failureReason" = ${failureReason}
      WHERE id = ${id} AND status IN ${TERMINAL}
      RETURNING *`);
  }

  markWorkflowStepTaskSuperseded(id: string, reason: string): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      UPDATE agent_tasks
        SET status = 'superseded',
            "statusKind" = 'workflow_retry',
            "lastUpdatedAt" = ${nowIso}
        WHERE id = ${id} AND status = 'failed' AND "failureReason" = ${reason}
        RETURNING *`);
  }

  /** Rewrites the `dependsOn` JSON array (SQLite `json_each`, `json_group_array`). */
  abstract repointDependents(
    supersededId: string,
    resumeTaskId: string,
    statuses: readonly string[],
  ): Promise<{ id: string; agentId: string | null }[]>;

  pauseTask(id: string): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      UPDATE agent_tasks
        SET status = 'paused',
            was_paused = ${true},
            "lastUpdatedAt" = ${nowIso}
        WHERE id = ${id} AND status = 'in_progress'
        RETURNING *`);
  }

  resumePausedTask(id: string): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      UPDATE agent_tasks
        SET status = 'in_progress',
            was_paused = ${true},
            "lastUpdatedAt" = ${nowIso}
        WHERE id = ${id} AND status = 'paused'
        RETURNING *`);
  }

  listPausedTasksForAgent(
    agentId: string,
    readableBy?: { userId: string | null },
  ): Promise<TaskRow[]> {
    const readable = readableBy
      ? sql` AND ${readableSessionSql(readableBy.userId, sql`agent_tasks.id`)}`
      : EMPTY;
    return this.db.query<TaskRow>(sql`
      SELECT * FROM agent_tasks
        WHERE "agentId" = ${agentId} AND status = 'paused'${readable}
        ORDER BY "createdAt" ASC, ${this.insertionOrder()} ASC`);
  }

  protected orphanedInProgress(agentId: string, cutoff: string): SqlQuery {
    return sql`t."agentId" = ${agentId}
          AND t.status = 'in_progress'
          AND t."claudeSessionId" IS NULL
          AND t."lastUpdatedAt" < ${cutoff}
          AND s.id IS NULL
          AND t."finishedAt" IS NULL`;
  }

  listOrphanedInProgressTasks(agentId: string, cutoff: string): Promise<TaskRow[]> {
    return this.db.query<TaskRow>(sql`
      SELECT t.* FROM agent_tasks t
        LEFT JOIN active_sessions s ON s."taskId" = t.id
        WHERE ${this.orphanedInProgress(agentId, cutoff)}
        ORDER BY t."createdAt" ASC, ${this.insertionOrder("t")} ASC`);
  }

  resetOrphanedInProgressTasks(agentId: string, cutoff: string): Promise<TaskRow[]> {
    return this.db.query<TaskRow>(sql`
      UPDATE agent_tasks
        SET status = 'pending',
            "lastUpdatedAt" = ${nowIso}
        WHERE id IN (
          SELECT t.id FROM agent_tasks t
          LEFT JOIN active_sessions s ON s."taskId" = t.id
          WHERE ${this.orphanedInProgress(agentId, cutoff)}
        )
        RETURNING *`);
  }

  listRecentlyCancelledTasks(
    agentId: string,
    since: string,
    readableBy?: { userId: string | null },
  ): Promise<TaskRow[]> {
    const readable = readableBy
      ? sql` AND ${readableSessionSql(readableBy.userId, sql`agent_tasks.id`)}`
      : EMPTY;
    return this.db.query<TaskRow>(sql`
      SELECT * FROM agent_tasks
        WHERE "agentId" = ${agentId}
        AND status = 'cancelled'
        AND "finishedAt" > ${since}${readable}
        ORDER BY "finishedAt" DESC`);
  }

  async listChildTaskIds(parentId: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(
      sql`SELECT id FROM agent_tasks WHERE "parentTaskId" = ${parentId}`,
    );
    return rows.map((row) => row.id);
  }

  async deleteTask(id: string): Promise<number> {
    return (await this.db.run(sql`DELETE FROM agent_tasks WHERE id = ${id}`)).changes;
  }

  updateTaskProgress(id: string, progress: string): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      UPDATE agent_tasks SET progress = ${progress},
        status = CASE WHEN status IN ${TERMINAL} THEN status ELSE 'in_progress' END,
        "lastUpdatedAt" = ${nowIso}
        WHERE id = ${id} RETURNING *`);
  }

  // ---- human-free classification ----

  /** A VALUES row source and the recursive walk with LIMIT are SQLite-specific. */
  abstract classifyHumanFree(input: HumanFreeClassifyInput): Promise<boolean>;
  /** Expands the id list with `json_each` and keeps `MAX(hops, excluded.hops)`. */
  abstract enqueueHumanFreeWork(
    taskIds: readonly string[],
    scope: "self" | "children",
    hops: number,
  ): Promise<void>;
  /** LIMIT inside the recursive term stops the walk (SQLite). */
  abstract humanFreeAffected(seedIds: readonly string[], limit: number): Promise<string[]>;
  /** Planner hints (`+task.id`) and `json_each` are SQLite-specific. */
  abstract applyHumanFreeBatch(affected: readonly string[]): Promise<number>;
  /** Reads the batch as a JSON array (SQLite `json_each`). */
  abstract humanFreeUnfinished(batch: readonly string[]): Promise<string[]>;
  /** Pages by the insertion-order column (SQLite `rowid`). */
  abstract listChildPage(
    parentId: string,
    after: number,
    limit: number,
  ): Promise<{ id: string; position: number }[]>;

  humanFreeQueueHead(): Promise<HumanFreeQueueRow | null> {
    return this.db.get<HumanFreeQueueRow>(
      sql`SELECT * FROM human_free_reclassify_queue ORDER BY seq LIMIT 1`,
    );
  }

  humanFreeQueueSelfRows(limit: number): Promise<HumanFreeQueueRow[]> {
    return this.db.query<HumanFreeQueueRow>(sql`
      SELECT * FROM human_free_reclassify_queue WHERE scope = 'self' ORDER BY seq LIMIT ${limit}`);
  }

  async deleteHumanFreeQueueRows(seqs: readonly number[]): Promise<void> {
    if (seqs.length === 0) return;
    await this.db.run(sql`DELETE FROM human_free_reclassify_queue WHERE seq IN (${sqlList(seqs)})`);
  }

  async setHumanFreeQueueCursor(seq: number, afterRowid: number): Promise<void> {
    await this.db.run(
      sql`UPDATE human_free_reclassify_queue SET "afterRowid" = ${afterRowid} WHERE seq = ${seq}`,
    );
  }

  async countHumanFreeQueue(): Promise<number> {
    const row = await this.db.get<{ count: number | string }>(
      sql`SELECT COUNT(*) AS count FROM human_free_reclassify_queue`,
    );
    return Number(row?.count ?? 0);
  }

  // ---- task_ui_specs / task_ui_action_runs ----

  findTaskUiSpec(taskId: string): Promise<TaskUiSpecRow | null> {
    return this.db.get<TaskUiSpecRow>(sql`
      SELECT task_id AS "taskId", spec, actions, fallback_text AS "fallbackText"
      FROM task_ui_specs WHERE task_id = ${taskId}`);
  }

  listTaskUiSpecs(taskIds: readonly string[]): Promise<TaskUiSpecRow[]> {
    if (taskIds.length === 0) return Promise.resolve([]);
    return this.db.query<TaskUiSpecRow>(sql`
      SELECT task_id AS "taskId", spec, actions, fallback_text AS "fallbackText"
      FROM task_ui_specs WHERE task_id IN (${sqlList(taskIds)})`);
  }

  async upsertTaskUiSpec(r: TaskUiSpecRow & { userId: string | null }): Promise<void> {
    await this.db.run(sql`
      INSERT INTO task_ui_specs (task_id, spec, actions, fallback_text, created_by, updated_by)
      VALUES (${r.taskId}, ${jsonText(r.spec)}, ${r.actions}, ${r.fallbackText}, ${r.userId}, ${r.userId})
      ON CONFLICT(task_id) DO UPDATE SET
        spec=excluded.spec, actions=excluded.actions, fallback_text=excluded.fallback_text,
        updated_by=excluded.updated_by, updated_at=${nowIso}`);
  }

  async reserveTaskUiActionRun(r: {
    taskId: string;
    actionId: string;
    surface: string;
    slackUserId: string | null;
    userId: string | null;
  }): Promise<number> {
    const result = await this.db.run(sql`
      INSERT INTO task_ui_action_runs
      (task_id, action_id, surface, slack_user_id, created_by, updated_by)
      VALUES (${r.taskId}, ${r.actionId}, ${r.surface}, ${r.slackUserId}, ${r.userId}, ${r.userId})
      ON CONFLICT(task_id, action_id) DO NOTHING`);
    return result.changes;
  }

  async releaseTaskUiActionRun(taskId: string, actionId: string): Promise<void> {
    await this.db.run(sql`
      DELETE FROM task_ui_action_runs
      WHERE task_id = ${taskId} AND action_id = ${actionId} AND result_task_id IS NULL`);
  }

  async setTaskUiActionResult(
    taskId: string,
    actionId: string,
    resultTaskId: string,
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE task_ui_action_runs SET result_task_id = ${resultTaskId},
        updated_at = ${nowIso}
      WHERE task_id = ${taskId} AND action_id = ${actionId}`);
  }

  async acquireTaskUiScriptActionRun(r: {
    taskId: string;
    actionId: string;
    surface: string;
    slackUserId: string | null;
    userId: string | null;
    lockedUntil: string;
    now: string;
    cooldownCutoff: string;
  }): Promise<number> {
    const result = await this.db.run(sql`
      INSERT INTO task_ui_action_runs
      (task_id, action_id, surface, slack_user_id, created_by, updated_by, locked_until)
      VALUES (${r.taskId}, ${r.actionId}, ${r.surface}, ${r.slackUserId}, ${r.userId}, ${r.userId}, ${r.lockedUntil})
      ON CONFLICT(task_id, action_id) DO UPDATE SET
        locked_until = excluded.locked_until, surface = excluded.surface,
        slack_user_id = excluded.slack_user_id, updated_by = excluded.updated_by, updated_at = ${r.now}
      WHERE task_ui_action_runs.result_task_id IS NULL
        AND (task_ui_action_runs.locked_until IS NULL OR task_ui_action_runs.locked_until < ${r.now})
        AND (task_ui_action_runs.last_run_at IS NULL OR task_ui_action_runs.last_run_at < ${r.cooldownCutoff})`);
    return result.changes;
  }

  findTaskUiActionLease(taskId: string, actionId: string): Promise<TaskUiActionLeaseRow | null> {
    return this.db.get<TaskUiActionLeaseRow>(sql`
      SELECT locked_until AS "lockedUntil", last_run_at AS "lastRunAt"
      FROM task_ui_action_runs WHERE task_id = ${taskId} AND action_id = ${actionId}`);
  }

  async finishTaskUiScriptActionRun(
    taskId: string,
    actionId: string,
    error: string | null,
    now: string,
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE task_ui_action_runs SET locked_until = NULL, last_run_at = ${now},
        run_count = run_count + 1, last_error = ${error}, updated_at = ${now}
      WHERE task_id = ${taskId} AND action_id = ${actionId}`);
  }

  // ---- checklist_items ----

  async seedChecklistDefaults(userId: string | null): Promise<void> {
    await this.db.run(sql`
      INSERT INTO checklist_items (id, scope, kind, label, href, "sortOrder")
      VALUES ('swarm:channel', 'swarm', 'channel', 'Connect a chat channel', '/integrations/channels', 0),
             ('swarm:tool', 'swarm', 'tool', 'Connect work tools', '/integrations/tools', 1)
      ON CONFLICT DO NOTHING`);
    if (userId) {
      await this.db.run(sql`
        INSERT INTO checklist_items
        (id, scope, "userId", kind, label, href, "sortOrder", created_by, updated_by)
        VALUES (${`user:${userId}:use_case`}, 'user', ${userId}, 'use_case', 'Plan your first use case',
          '/sessions', 2, ${userId}, ${userId})
        ON CONFLICT DO NOTHING`);
    }
  }

  listChecklistRows(userId: string | null): Promise<ChecklistItemRow[]> {
    return this.db.query<ChecklistItemRow>(sql`
      SELECT c.*, CASE WHEN ${likeAsciiCi(sql`c."statusChangedBy"`, sql`'lead:%'`)} THEN 'Lead' ELSE u.name END
        AS "statusChangedByName"
      FROM checklist_items c LEFT JOIN users u ON u.id = c."statusChangedBy"
      WHERE c.scope = 'swarm' OR (c.scope = 'user' AND c."userId" = ${userId})`);
  }

  findChecklistItem(id: string): Promise<ChecklistItemRow | null> {
    return this.db.get<ChecklistItemRow>(sql`SELECT * FROM checklist_items WHERE id = ${id}`);
  }

  /** Reads a JSON field of `meta` (SQLite `json_extract`). */
  abstract findOpenChannelChecklistItem(
    scope: string,
    userId: string | null,
    adapter: string,
  ): Promise<{ id: string } | null>;

  async nextChecklistSortOrder(scope: string, userId: string | null): Promise<number> {
    const row = await this.db.get<{ sortOrder: number | string }>(sql`
      SELECT COALESCE(MAX("sortOrder"), -1) + 1 AS "sortOrder" FROM checklist_items
      WHERE scope = ${scope} AND "userId" IS NOT DISTINCT FROM ${userId}`);
    return Number(row?.sortOrder ?? 0);
  }

  async insertChecklistItem(i: NewChecklistItem): Promise<void> {
    await this.db.run(sql`
      INSERT INTO checklist_items
      (id, scope, "userId", kind, label, href, meta, "sortOrder", "createdAt", "lastUpdatedAt", created_by, updated_by)
      VALUES (${i.id}, ${i.scope}, ${i.userId}, ${i.kind}, ${i.label}, ${i.href}, ${i.meta}, ${i.sortOrder},
        ${i.now}, ${i.now}, ${i.actor}, ${i.actor})`);
  }

  async setChecklistSortOrder(
    id: string,
    sortOrder: number,
    now: string,
    actor: string,
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE checklist_items SET "sortOrder" = ${sortOrder}, "lastUpdatedAt" = ${now}, updated_by = ${actor}
      WHERE id = ${id}`);
  }

  async setChecklistStatus(
    id: string,
    status: string,
    reason: string | null,
    now: string,
    actor: string,
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE checklist_items SET status = ${status}, "statusChangedAt" = ${now}, "statusChangedBy" = ${actor},
        "statusReason" = ${reason}, "lastUpdatedAt" = ${now}, updated_by = ${actor} WHERE id = ${id}`);
  }

  async markChecklistNudged(id: string, taskId: string, now: string): Promise<void> {
    await this.db.run(sql`
      UPDATE checklist_items SET "nudgedAt" = ${now}, "nudgedTaskId" = ${taskId}, "lastUpdatedAt" = ${now}
      WHERE id = ${id}`);
  }

  // ---- task_citations / task_attachments ----

  async upsertTaskCitation(
    taskId: string,
    c: Omit<TaskCitationRow, "general"> & { general: boolean },
  ): Promise<void> {
    await this.db.run(sql`
      INSERT INTO task_citations
      (task_id, citation_index, kind, ref, label, quote, resolved_url, verified, general)
      VALUES (${taskId}, ${c.index}, ${c.kind}, ${c.ref}, ${c.label}, ${c.quote}, ${c.resolvedUrl},
        ${c.verified}, ${c.general})
      ON CONFLICT(task_id, citation_index) DO UPDATE SET
        kind=excluded.kind, ref=excluded.ref, label=excluded.label, quote=excluded.quote,
        resolved_url=excluded.resolved_url, verified=excluded.verified, general=excluded.general,
        updated_at=${nowIso}`);
  }

  listTaskCitations(taskId: string): Promise<TaskCitationRow[]> {
    return this.db.query<TaskCitationRow>(sql`
      SELECT citation_index AS "index", kind, ref, label, quote,
      resolved_url AS "resolvedUrl", verified, general FROM task_citations
      WHERE task_id = ${taskId} ORDER BY citation_index`);
  }

  listTaskCitationsForTasks(
    taskIds: readonly string[],
  ): Promise<(TaskCitationRow & { taskId: string })[]> {
    if (taskIds.length === 0) return Promise.resolve([]);
    return this.db.query<TaskCitationRow & { taskId: string }>(sql`
      SELECT task_id AS "taskId", citation_index AS "index", kind, ref, label, quote,
      resolved_url AS "resolvedUrl", verified, general FROM task_citations
      WHERE task_id IN (${sqlList(taskIds)}) ORDER BY task_id, citation_index`);
  }

  findTaskOutput(taskId: string): Promise<{ output: string | null } | null> {
    return this.db.get<{ output: string | null }>(
      sql`SELECT output FROM agent_tasks WHERE id = ${taskId}`,
    );
  }

  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract listTaskAttachmentUrls(taskId: string): Promise<{ kind: string; url: string | null }[]>;

  // ---- agent_tasks: runtime pool routing ----

  listPoolPendingTasks(): Promise<TaskRow[]> {
    return this.db.query<TaskRow>(sql`
      SELECT * FROM agent_tasks WHERE status = 'pending'
        AND (pool_wake_at IS NOT NULL OR "agentId" IN (
          SELECT id FROM agents WHERE runtime_pool_id IS NOT NULL
          UNION SELECT agent_id FROM runtime_instances WHERE pool_id IS NOT NULL
        )) AND COALESCE(routing_reason, '') != 'human_pinned'`);
  }

  /** SQLite text pinned by an existing test (see the SQLite engine). */
  abstract releasePendingPoolTask(taskId: string, agentId: string, now: string): Promise<number>;

  async countAgentOpenTasks(agentId: string): Promise<{ count: number; pending: number }> {
    const row = await this.db.get<{ count: number | string; pending: number | string }>(sql`
      SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending
      FROM agent_tasks WHERE "agentId" = ${agentId} AND status IN ('pending', 'in_progress')`);
    return { count: Number(row?.count ?? 0), pending: Number(row?.pending ?? 0) };
  }

  async countAgentPendingTasks(agentId: string): Promise<number> {
    const row = await this.db.get<{ count: number | string }>(sql`
      SELECT COUNT(*) AS count FROM agent_tasks WHERE "agentId" = ${agentId} AND status = 'pending'`);
    return Number(row?.count ?? 0);
  }

  // ---- deferred_task_waits / deferred_task_wait_members / deferred_event_waits ----

  async countPendingEventWaitsForAgent(agentId: string): Promise<number> {
    const row = await this.db.get<{ n: number | string }>(sql`
      SELECT COUNT(*) AS n FROM deferred_event_waits w
      JOIN scheduled_tasks s ON s.id = w."scheduleId"
      WHERE w.status = 'pending' AND s.enabled = ${true} AND s."targetAgentId" = ${agentId}`);
    return Number(row?.n ?? 0);
  }

  findPendingTaskWaitWatching(
    agentId: string,
    taskIds: readonly string[],
  ): Promise<{ scheduleId: string; parentTaskId: string } | null> {
    if (taskIds.length === 0) return Promise.resolve(null);
    return this.db.get<{ scheduleId: string; parentTaskId: string }>(sql`
      SELECT w."scheduleId", s."parentTaskId" FROM deferred_task_waits w
      JOIN scheduled_tasks s ON s.id = w."scheduleId"
      JOIN deferred_task_wait_members m ON m."scheduleId" = w."scheduleId"
      WHERE w.status = 'pending' AND s.enabled = ${true} AND s."targetAgentId" = ${agentId}
        AND m."taskId" IN (${sqlList(taskIds)})
      LIMIT 1`);
  }

  async insertDeferredEventWait(r: {
    scheduleId: string;
    source: string;
    event: string;
    matchKey: string;
    matchJson: string;
    userId: string | null;
  }): Promise<void> {
    await this.db.run(sql`
      INSERT INTO deferred_event_waits ("scheduleId", source, event, "matchKey", "matchJson", created_by, updated_by)
      VALUES (${r.scheduleId}, ${r.source}, ${r.event}, ${r.matchKey}, ${jsonText(r.matchJson)}, ${r.userId}, ${r.userId})`);
  }

  async insertDeferredTaskWait(r: {
    scheduleId: string;
    eventName: string;
    mode: string;
    userId: string | null;
  }): Promise<void> {
    await this.db.run(sql`
      INSERT INTO deferred_task_waits ("scheduleId", "eventName", mode, created_by, updated_by)
      VALUES (${r.scheduleId}, ${r.eventName}, ${r.mode}, ${r.userId}, ${r.userId})`);
  }

  async insertDeferredTaskWaitMember(
    scheduleId: string,
    taskId: string,
    userId: string | null,
  ): Promise<void> {
    await this.db.run(sql`
      INSERT INTO deferred_task_wait_members ("scheduleId", "taskId", created_by, updated_by)
      VALUES (${scheduleId}, ${taskId}, ${userId}, ${userId})`);
  }

  // ---- deferred waits: wake resolution ----

  /** A member's status as waits see it: a superseded workflow step reads as `failed`. */
  protected waitMemberStatus(workflowReason: string): SqlQuery {
    return sql`CASE
      WHEN t.status = 'superseded' AND t."failureReason" = ${workflowReason} THEN 'failed'
      ELSE t.status END`;
  }

  findDeferredTaskWait(scheduleId: string): Promise<DeferredTaskWaitRow | null> {
    return this.db.get<DeferredTaskWaitRow>(
      sql`SELECT * FROM deferred_task_waits WHERE "scheduleId" = ${scheduleId}`,
    );
  }

  findDeferredEventWait(scheduleId: string): Promise<DeferredEventWaitRow | null> {
    return this.db.get<DeferredEventWaitRow>(
      sql`SELECT * FROM deferred_event_waits WHERE "scheduleId" = ${scheduleId}`,
    );
  }

  async hasDeferredWait(scheduleId: string): Promise<boolean> {
    const row = await this.db.get(sql`
      SELECT 1 AS found FROM deferred_task_waits WHERE "scheduleId" = ${scheduleId}
      UNION ALL SELECT 1 FROM deferred_event_waits WHERE "scheduleId" = ${scheduleId}`);
    return !!row;
  }

  listDeferredWaitMembers(
    scheduleId: string,
    workflowReason: string,
  ): Promise<{ taskId: string; taskStatus: string | null; deferred: number }[]> {
    return this.db.query(sql`
      SELECT m."taskId", ${this.waitMemberStatus(workflowReason)} AS "taskStatus", EXISTS (
          SELECT 1 FROM scheduled_tasks d
          WHERE d."parentTaskId" = t.id AND d."taskType" = 'deferred' AND d.enabled = ${true}
        ) AS deferred
      FROM deferred_task_wait_members m LEFT JOIN agent_tasks t ON t.id = m."taskId"
      WHERE m."scheduleId" = ${scheduleId}`);
  }

  async claimDeferredWait(
    table: DeferredWaitTable,
    scheduleId: string,
    firedBy: string,
    now: string,
  ): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE ${sqlIdent(table)} SET status = 'fired', "firedBy" = ${firedBy}, "resolvedAt" = ${now},
        updated_at = ${now}
      WHERE "scheduleId" = ${scheduleId} AND status = 'pending'`);
    return result.changes;
  }

  async setDeferredWaitChild(
    table: DeferredWaitTable,
    scheduleId: string,
    childTaskId: string,
  ): Promise<void> {
    await this.db.run(
      sql`UPDATE ${sqlIdent(table)} SET "childTaskId" = ${childTaskId} WHERE "scheduleId" = ${scheduleId}`,
    );
  }

  /** Filters on an output alias in WHERE (SQLite). */
  abstract listSupersededWaitMembers(): Promise<{ taskId: string; resumeTaskId: string }[]>;
  async transferWaitMembers(fromTaskId: string, toTaskId: string, now: string): Promise<void> {
    await this.db.run(sql`
      UPDATE deferred_task_wait_members SET "taskId" = ${toTaskId}, updated_at = ${now}
      WHERE "taskId" = ${fromTaskId} AND "scheduleId" IN (
        SELECT "scheduleId" FROM deferred_task_waits WHERE status = 'pending'
      )`);
  }

  /** `UPDATE OR REPLACE` (SQLite). */
  abstract repointWaitMembers(taskId: string, resumeTaskId: string, now: string): Promise<void>;

  listReadyDeferredTaskWaits(
    workflowReason: string,
    taskId?: string,
  ): Promise<(DeferredTaskWaitRow & { taskStatus: string })[]> {
    const status = this.waitMemberStatus(workflowReason);
    const member = taskId === undefined ? EMPTY : sql` AND m."taskId" = ${taskId}`;
    return this.db.query(sql`
      SELECT DISTINCT w.*, ${status} AS "taskStatus" FROM deferred_task_waits w
      JOIN deferred_task_wait_members m ON m."scheduleId" = w."scheduleId"
      JOIN agent_tasks t ON t.id = m."taskId"
      JOIN scheduled_tasks s ON s.id = w."scheduleId"
      WHERE w.status = 'pending' AND s.enabled = ${true}
        AND ${status} IN ('completed', 'failed', 'cancelled', 'skipped')
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_tasks d
          WHERE d."parentTaskId" = t.id AND d."taskType" = 'deferred' AND d.enabled = ${true}
        )
        AND (w."eventName" = 'settled' OR w."eventName" = 'task.' || ${status})${member}`);
  }

  async hasPendingEventWait(source: string, event: string): Promise<boolean> {
    return !!(await this.db.get(sql`
      SELECT 1 AS found FROM deferred_event_waits
      WHERE status = 'pending' AND source = ${source} AND event = ${event} LIMIT 1`));
  }

  listPendingEventWaits(only?: {
    source: string;
    event: string;
    matchKey: string;
  }): Promise<Omit<DeferredEventWaitRow, "status">[]> {
    const target = only
      ? sql` AND w.source = ${only.source} AND w.event = ${only.event} AND w."matchKey" = ${only.matchKey}`
      : EMPTY;
    return this.db.query(sql`
      SELECT w."scheduleId", w.source, w.event, w."matchKey", w."matchJson" FROM deferred_event_waits w
      JOIN scheduled_tasks s ON s.id = w."scheduleId"
      WHERE w.status = 'pending' AND s.enabled = ${true}${target}`);
  }

  // ---- task_idempotency_keys ----

  findTaskIdempotencyKey(
    principal: string,
    keyHash: string,
  ): Promise<TaskIdempotencyKeyRow | null> {
    return this.db.get<TaskIdempotencyKeyRow>(sql`
      SELECT * FROM task_idempotency_keys WHERE principal = ${principal} AND "keyHash" = ${keyHash}`);
  }

  async insertTaskIdempotencyKey(r: TaskIdempotencyKeyRow): Promise<void> {
    await this.db.run(sql`
      INSERT INTO task_idempotency_keys
        (id, principal, "keyHash", "requestFingerprint", "taskId", "createdAt", created_by, updated_by)
      VALUES (${r.id}, ${r.principal}, ${r.keyHash}, ${r.requestFingerprint}, ${r.taskId}, ${r.createdAt},
        ${r.created_by}, ${r.updated_by})`);
  }

  // ---- agent_tasks: Slack and VCS tracking ----

  listTasksInSlackThread(channelId: string, threadTs: string): Promise<TaskRow[]> {
    return this.db.query<TaskRow>(sql`
      SELECT * FROM agent_tasks
      WHERE "slackChannelId" = ${channelId} AND "slackThreadTs" = ${threadTs}
      ORDER BY "createdAt" ASC, ${this.insertionOrder()} ASC`);
  }

  async markTaskSlackReplySent(taskId: string): Promise<void> {
    await this.db.run(sql`UPDATE agent_tasks SET "slackReplySent" = ${true} WHERE id = ${taskId}`);
  }

  async setTaskSlackTracking(
    taskId: string,
    fields: { slackProgressMessageTs?: string | null; slackTreeRootMessageTs?: string | null },
  ): Promise<void> {
    const sets: SqlQuery[] = [];
    if (Object.hasOwn(fields, "slackProgressMessageTs")) {
      sets.push(sql`"slackProgressMessageTs" = ${fields.slackProgressMessageTs ?? null}`);
    }
    if (Object.hasOwn(fields, "slackTreeRootMessageTs")) {
      sets.push(sql`"slackTreeRootMessageTs" = ${fields.slackTreeRootMessageTs ?? null}`);
    }
    if (sets.length === 0) return;
    await this.db.run(sql`UPDATE agent_tasks SET ${sqlJoin(sets, sql`, `)} WHERE id = ${taskId}`);
  }

  setTaskVcs(
    taskId: string,
    vcs: { vcsProvider: string; vcsRepo: string; vcsNumber: number; vcsUrl: string },
    now: string,
  ): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      UPDATE agent_tasks
      SET "vcsProvider" = ${vcs.vcsProvider}, "vcsRepo" = ${vcs.vcsRepo}, "vcsNumber" = ${vcs.vcsNumber},
        "vcsUrl" = ${vcs.vcsUrl}, "lastUpdatedAt" = ${now}
      WHERE id = ${taskId} RETURNING *`);
  }

  // ---- task_attachments ----

  async listUrlAttachmentUrls(taskId: string): Promise<string[]> {
    const rows = await this.db.query<{ url: string }>(sql`
      SELECT url FROM task_attachments WHERE task_id = ${taskId} AND kind = 'url' AND url IS NOT NULL
      ORDER BY created_at, id`);
    return rows.map((row) => row.url);
  }

  abstract listGeneratedUrlAttachments(
    taskId: string,
    capabilityKey: string,
    source: string,
  ): Promise<{ id: string; name: string; url: string }[]>;

  async deleteTaskAttachment(id: string): Promise<number> {
    return (await this.db.run(sql`DELETE FROM task_attachments WHERE id = ${id}`)).changes;
  }

  findTaskAttachmentBySha256(taskId: string, sha256: string): Promise<TaskAttachmentRow | null> {
    return this.db.get<TaskAttachmentRow>(sql`
      SELECT * FROM task_attachments WHERE task_id = ${taskId} AND sha256 = ${sha256} LIMIT 1`);
  }

  findTaskAttachmentByTuple(t: {
    taskId: string;
    kind: string;
    path: string;
    url: string;
    pageId: string;
    name: string;
  }): Promise<TaskAttachmentRow | null> {
    return this.db.get<TaskAttachmentRow>(sql`
      SELECT * FROM task_attachments
      WHERE task_id = ${t.taskId}
        AND kind = ${t.kind}
        AND COALESCE(path, '') = ${t.path}
        AND COALESCE(url, '') = ${t.url}
        AND COALESCE(page_id, '') = ${t.pageId}
        AND name = ${t.name}
      ORDER BY created_at ASC, ${this.insertionOrder()} ASC
      LIMIT 1`);
  }

  insertTaskAttachment(
    r: TaskAttachmentWrite & { id: string; task_id: string; created_by: string | null },
  ): Promise<TaskAttachmentRow | null> {
    return this.db.get<TaskAttachmentRow>(sql`
      INSERT INTO task_attachments
        (id, task_id, agent_id, name, kind, url, path, page_id,
         provider_id, provider_key, capabilities,
         agent_fs_org_id, agent_fs_drive_id,
         mime_type, size_bytes, sha256, intent, description, is_primary,
         created_by, updated_by)
      VALUES (${r.id}, ${r.task_id}, ${r.agent_id}, ${r.name}, ${r.kind}, ${r.url}, ${r.path},
        ${r.page_id}, ${r.provider_id}, ${r.provider_key}, ${jsonText(r.capabilities)}, ${r.agent_fs_org_id},
        ${r.agent_fs_drive_id}, ${r.mime_type}, ${r.size_bytes}, ${r.sha256}, ${r.intent},
        ${r.description}, ${r.is_primary}, ${r.created_by}, ${r.updated_by})
      RETURNING *`);
  }

  replaceTaskAttachment(id: string, r: TaskAttachmentWrite): Promise<TaskAttachmentRow | null> {
    return this.db.get<TaskAttachmentRow>(sql`
      UPDATE task_attachments
      SET agent_id = ${r.agent_id}, name = ${r.name}, kind = ${r.kind}, url = ${r.url},
        path = ${r.path}, page_id = ${r.page_id}, provider_id = ${r.provider_id},
        provider_key = ${r.provider_key}, capabilities = ${jsonText(r.capabilities)},
        agent_fs_org_id = ${r.agent_fs_org_id}, agent_fs_drive_id = ${r.agent_fs_drive_id},
        mime_type = ${r.mime_type}, size_bytes = ${r.size_bytes}, sha256 = ${r.sha256},
        intent = ${r.intent}, description = ${r.description}, is_primary = ${r.is_primary},
        updated_by = ${r.updated_by}
      WHERE id = ${id}
      RETURNING *`);
  }

  listTaskAttachments(taskId: string): Promise<TaskAttachmentRow[]> {
    return this.db.query<TaskAttachmentRow>(sql`
      SELECT * FROM task_attachments WHERE task_id = ${taskId}
      ORDER BY created_at ASC, ${this.insertionOrder()} ASC`);
  }

  // ---- task_steering_messages ----

  /** Resolves sender names in the API, so workers need no database access. */
  private readonly steeringSelect = sql`SELECT m.*,
    CASE m.created_by_kind WHEN 'user' THEN u.name WHEN 'agent' THEN a.name END AS sender_name
    FROM task_steering_messages m
    LEFT JOIN users u ON m.created_by_kind = 'user' AND u.id = m.created_by_user_id
    LEFT JOIN agents a ON m.created_by_kind = 'agent' AND a.id = m.created_by_agent_id`;

  insertSteeringMessage(r: NewSteeringMessage): Promise<TaskSteeringMessageRow | null> {
    return this.db.get<TaskSteeringMessageRow>(sql`
      INSERT INTO task_steering_messages
        (id, task_id, body, mode, source, created_by_kind, created_by_user_id, created_by_agent_id)
      VALUES (${r.id}, ${r.task_id}, ${r.body}, ${r.mode}, ${r.source}, ${r.created_by_kind},
        ${r.created_by_user_id}, ${r.created_by_agent_id})
      RETURNING *`);
  }

  listSteeringMessages(taskId: string, status?: string): Promise<TaskSteeringMessageRow[]> {
    const byStatus = status ? sql` AND m.status = ${status}` : EMPTY;
    return this.db.query<TaskSteeringMessageRow>(sql`
      ${this.steeringSelect}
      WHERE m.task_id = ${taskId}${byStatus}
      ORDER BY m.created_at ASC, ${this.insertionOrder("m")} ASC`);
  }

  findSteeringMessage(id: string): Promise<TaskSteeringMessageRow | null> {
    return this.db.get<TaskSteeringMessageRow>(sql`${this.steeringSelect} WHERE m.id = ${id}`);
  }

  listPendingSteeringForAgent(
    agentId: string,
    readableBy?: { userId: string | null },
  ): Promise<TaskSteeringMessageRow[]> {
    const readable = readableBy
      ? sql` AND ${readableSessionSql(readableBy.userId, sql`t.id`)}`
      : EMPTY;
    return this.db.query<TaskSteeringMessageRow>(sql`
      ${this.steeringSelect}
      JOIN agent_tasks t ON t.id = m.task_id
      WHERE t."agentId" = ${agentId} AND m.status = 'pending'${readable}
      ORDER BY m.created_at ASC, ${this.insertionOrder("m")} ASC`);
  }

  markSteeringDelivered(
    id: string,
    deliveredMode: string,
    expectedTaskId: string | null,
  ): Promise<TaskSteeringMessageRow | null> {
    return this.db.get<TaskSteeringMessageRow>(sql`
      UPDATE task_steering_messages
      SET status = 'delivered', delivered_mode = ${deliveredMode}, delivered_at = ${nowIso}
      WHERE id = ${id} AND status = 'pending' AND task_id = COALESCE(${expectedTaskId}, task_id)
      RETURNING *`);
  }

  markSteeringHandled(id: string, note: string | null): Promise<TaskSteeringMessageRow | null> {
    return this.db.get<TaskSteeringMessageRow>(sql`
      UPDATE task_steering_messages
      SET status = 'handled', handled_at = ${nowIso}, handled_note = ${note}
      WHERE id = ${id} AND status = 'delivered'
      RETURNING *`);
  }

  markSteeringPromoted(id: string, promotedTaskId: string): Promise<TaskSteeringMessageRow | null> {
    return this.db.get<TaskSteeringMessageRow>(sql`
      UPDATE task_steering_messages
      SET status = 'promoted', promoted_task_id = ${promotedTaskId}
      WHERE id = ${id} AND status = 'pending'
      RETURNING *`);
  }

  async cancelPendingSteering(taskId: string): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE task_steering_messages SET status = 'cancelled'
      WHERE task_id = ${taskId} AND status = 'pending'`);
    return result.changes;
  }

  async hasPendingSteering(taskId: string): Promise<boolean> {
    const row = await this.db.get<{ present: number }>(sql`
      SELECT 1 AS present FROM task_steering_messages
      WHERE task_id = ${taskId} AND status = 'pending' LIMIT 1`);
    return row !== null;
  }

  // ---- agent_tasks: creation, routing snapshot, pool lifecycle ----

  listRecentSimilarTasks(f: {
    since: string;
    creatorAgentId?: string;
    agentId?: string;
    limit: number;
  }): Promise<TaskRow[]> {
    const conditions = [sql`"createdAt" > ${f.since}`, sql`status NOT IN ${TERMINAL}`];
    if (f.creatorAgentId) conditions.push(sql`"creatorAgentId" = ${f.creatorAgentId}`);
    if (f.agentId) conditions.push(sql`"agentId" = ${f.agentId}`);
    return this.db.query<TaskRow>(sql`
      SELECT * FROM agent_tasks${sqlWhere(conditions)}
      ORDER BY "createdAt" DESC, ${this.insertionOrder()} DESC LIMIT ${f.limit}`);
  }

  private readonly routingHolder = sql`CASE
    WHEN status IN ('draft', 'offered', 'reviewing') AND "offeredTo" IS NOT NULL THEN "offeredTo"
    ELSE COALESCE("agentId", "offeredTo")
  END`;

  findLatestRoutingCandidate(
    match: RoutingCandidateMatch,
  ): Promise<{ taskId: string; agentId: string } | null> {
    const conditions = Object.entries(match).map(
      ([column, value]) => sql`${sqlIdent(column)} = ${value}`,
    );
    return this.db.get<{ taskId: string; agentId: string }>(sql`
      SELECT id AS "taskId", ${this.routingHolder} AS "agentId"
      FROM agent_tasks
      WHERE ${sqlJoin(conditions, sql` AND `)}
        AND ${this.routingHolder} IN (SELECT id FROM agents WHERE "isLead" = ${false})
      ORDER BY "createdAt" DESC, ${this.insertionOrder()} DESC
      LIMIT 1`);
  }

  abstract listRoutingWorkerStatuses(
    openStatuses: readonly string[],
  ): Promise<{ agentId: string; status: string; activeTaskCount: number; openTaskCount: number }[]>;

  async findTaskKey(id: string): Promise<string | null> {
    const row = await this.db.get<{ key: string }>(
      sql`SELECT "key" FROM agent_tasks WHERE id = ${id}`,
    );
    return row?.key ?? null;
  }

  insertTask(r: NewTaskRow): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      INSERT INTO agent_tasks (
        id, "key", "agentId", "creatorAgentId", task, status, source, routing_reason, routing_source,
        routing_note, "taskType", tags, priority, "dependsOn", "offeredTo", "offeredAt",
        "slackChannelId", "slackThreadTs", "slackTriggerMessageTs", "slackUserId", "slackParticipants",
        "vcsProvider", "vcsRepo", "vcsEventType", "vcsNumber", "vcsCommentId", "vcsAuthor", "vcsUrl",
        "vcsInstallationId", "vcsNodeId",
        "agentmailInboxId", "agentmailMessageId", "agentmailThreadId",
        "mentionMessageId", "mentionChannelId", dir, "parentTaskId", "dispatchedByTaskId", model,
        "modelTier", effort, profile, "modelGroup", "fallbackHops", "scheduleId",
        "workflowRunId", "workflowRunStepId", "outputSchema", "followUpConfig", "requestedByUserId",
        "requestedByUserIdInherited", "contextKey", "routingAffinity", "swarmVersion", "createdAt",
        "lastUpdatedAt", created_by, updated_by, "isHumanFree", "sourceStepId", "sourceScriptRunId"
      ) VALUES (
        ${r.id}, ${r.key}, ${r.agentId}, ${r.creatorAgentId}, ${r.task}, ${r.status}, ${r.source},
        ${r.routing_reason}, ${r.routing_source}, ${r.routing_note}, ${r.taskType}, ${jsonText(r.tags)},
        ${r.priority}, ${jsonText(r.dependsOn)}, ${r.offeredTo}, ${r.offeredAt},
        ${r.slackChannelId}, ${r.slackThreadTs}, ${r.slackTriggerMessageTs}, ${r.slackUserId},
        ${jsonText(r.slackParticipants)},
        ${r.vcsProvider}, ${r.vcsRepo}, ${r.vcsEventType}, ${r.vcsNumber}, ${r.vcsCommentId},
        ${r.vcsAuthor}, ${r.vcsUrl}, ${r.vcsInstallationId}, ${r.vcsNodeId},
        ${r.agentmailInboxId}, ${r.agentmailMessageId}, ${r.agentmailThreadId},
        ${r.mentionMessageId}, ${r.mentionChannelId}, ${r.dir}, ${r.parentTaskId},
        ${r.dispatchedByTaskId}, ${r.model}, ${r.modelTier}, ${r.effort}, ${r.profile},
        ${r.modelGroup}, ${jsonText(r.fallbackHops)}, ${r.scheduleId},
        ${r.workflowRunId}, ${r.workflowRunStepId}, ${jsonText(r.outputSchema)}, ${jsonText(r.followUpConfig)},
        ${r.requestedByUserId}, ${r.requestedByUserIdInherited}, ${r.contextKey},
        ${r.routingAffinity}, ${r.swarmVersion}, ${r.createdAt}, ${r.lastUpdatedAt},
        ${r.created_by}, ${r.updated_by}, ${r.isHumanFree}, ${r.sourceStepId}, ${r.sourceScriptRunId}
      ) RETURNING *`);
  }

  async insertRoutingDecision(r: RoutingDecisionRow): Promise<void> {
    await this.db.run(sql`
      INSERT INTO routing_decisions (
        task_id, selected_agent_id, captured_at, worker_statuses,
        continuity_candidates, created_by, updated_by
      ) VALUES (${r.task_id}, ${r.selected_agent_id}, ${r.captured_at}, ${jsonText(r.worker_statuses)},
        ${jsonText(r.continuity_candidates)}, ${r.created_by}, ${r.updated_by})`);
  }

  claimUnassignedTask(taskId: string, agentId: string, now: string): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      UPDATE agent_tasks SET "agentId" = ${agentId}, status = 'in_progress', "lastUpdatedAt" = ${now}
      WHERE id = (
        SELECT id FROM agent_tasks WHERE id = ${taskId} AND status = 'unassigned'${forUpdateSkipLocked}
      ) AND status = 'unassigned' RETURNING *`);
  }

  lockTask(taskId: string): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`SELECT * FROM agent_tasks WHERE id = ${taskId}${forUpdate}`);
  }

  releaseTaskToPool(
    taskId: string,
    now: string,
    wake?: { agentId: string | null; poolWakeAt: string | null },
  ): Promise<TaskRow | null> {
    const wakeGuard = wake
      ? sql` AND status = 'pending' AND "agentId" = ${wake.agentId} AND pool_wake_at = ${wake.poolWakeAt}
          AND COALESCE(routing_reason, '') != 'human_pinned'`
      : EMPTY;
    return this.db.get<TaskRow>(sql`
      UPDATE agent_tasks
      SET "agentId" = NULL, status = 'unassigned', "lastUpdatedAt" = ${now}, pool_wake_at = NULL
      WHERE id = ${taskId} AND status IN ('pending', 'in_progress')${wakeGuard}
      RETURNING *`);
  }

  acceptOfferedTask(taskId: string, agentId: string, now: string): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      UPDATE agent_tasks
      SET "agentId" = ${agentId}, status = 'pending', "acceptedAt" = ${now}, "lastUpdatedAt" = ${now}
      WHERE id = ${taskId} AND status IN ('offered', 'reviewing') RETURNING *`);
  }

  rejectOfferedTask(taskId: string, reason: string | null, now: string): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      UPDATE agent_tasks
      SET status = 'unassigned', "offeredTo" = NULL, "offeredAt" = NULL,
        "rejectionReason" = ${reason}, "lastUpdatedAt" = ${now}, pool_wake_at = NULL
      WHERE id = ${taskId} AND status IN ('offered', 'reviewing') RETURNING *`);
  }

  moveTaskStatus(
    taskId: string,
    from: TaskStatus,
    to: TaskStatus,
    now: string,
  ): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      UPDATE agent_tasks SET status = ${to}, "lastUpdatedAt" = ${now}
      WHERE id = ${taskId} AND status = ${from} RETURNING *`);
  }

  private readonly draftTarget = sql`CASE
      WHEN "offeredTo" IS NOT NULL THEN 'offered'
      WHEN "agentId" IS NOT NULL THEN 'pending'
      ELSE 'unassigned'
    END`;

  promoteDraftTask(taskId: string, now: string): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      UPDATE agent_tasks SET status = ${this.draftTarget}, "lastUpdatedAt" = ${now}
      WHERE id = ${taskId} AND status = 'draft'
      RETURNING *`);
  }

  async refreshDraftTaskLease(taskId: string, now: string): Promise<void> {
    await this.db.run(sql`
      UPDATE agent_tasks SET "lastUpdatedAt" = ${now} WHERE id = ${taskId} AND status = 'draft'`);
  }

  async promoteDraftsIdleSince(cutoff: string, now: string): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE agent_tasks SET status = ${this.draftTarget}, "lastUpdatedAt" = ${now}
      WHERE status = 'draft' AND "lastUpdatedAt" < ${cutoff}`);
    return result.changes;
  }

  async releaseReviewingIdleSince(cutoff: string, now: string): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE agent_tasks SET status = 'offered', "lastUpdatedAt" = ${now}
      WHERE status = 'reviewing' AND "lastUpdatedAt" < ${cutoff}`);
    return result.changes;
  }

  async releaseOffersOfOfflineAgents(now: string, reachable: readonly string[]): Promise<number> {
    const keep = reachable.length ? sql` AND "offeredTo" NOT IN (${sqlList(reachable)})` : EMPTY;
    const result = await this.db.run(sql`
      UPDATE agent_tasks
      SET status = 'unassigned', "offeredTo" = NULL, "offeredAt" = NULL, "lastUpdatedAt" = ${now}
      WHERE status = 'offered'
        AND "offeredTo" IS NOT NULL${keep}
        AND NOT EXISTS (
          SELECT 1 FROM agents WHERE agents.id = agent_tasks."offeredTo" AND agents.status != 'offline'
        )`);
    return result.changes;
  }

  listOfferedTasksForAgent(agentId: string): Promise<TaskRow[]> {
    return this.db.query<TaskRow>(sql`
      SELECT * FROM agent_tasks WHERE "offeredTo" = ${agentId} AND status = 'offered'
      ORDER BY "createdAt" ASC, ${this.insertionOrder()} ASC`);
  }

  async countUnassignedTasks(): Promise<number> {
    const row = await this.db.get<{ count: number }>(
      sql`SELECT COUNT(*) as count FROM agent_tasks WHERE status = 'unassigned'`,
    );
    return row?.count ?? 0;
  }

  async listUnassignedTaskIds(limit: number): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(sql`
      SELECT id FROM agent_tasks WHERE status = 'unassigned'
      ORDER BY priority DESC, "createdAt" ASC, ${this.insertionOrder()} ASC LIMIT ${limit}`);
    return rows.map((r) => r.id);
  }

  listUnassignedTasks(limit: number, offset: number): Promise<TaskRow[]> {
    return this.db.query<TaskRow>(sql`
      SELECT * FROM agent_tasks WHERE status = 'unassigned'
      ORDER BY priority DESC, "createdAt" ASC, ${this.insertionOrder()} ASC
      LIMIT ${limit} OFFSET ${offset}`);
  }

  abstract listDependentTasks(parentId: string): Promise<TaskRow[]>;

  // ---- agent_tasks: counts, heartbeat and triage reads ----

  async countTasksWithStatus(
    status: string,
    only?: { agentId?: string; offeredTo?: string },
  ): Promise<number> {
    const conditions = [sql`status = ${status}`];
    if (only?.agentId) conditions.unshift(sql`"agentId" = ${only.agentId}`);
    if (only?.offeredTo) conditions.unshift(sql`"offeredTo" = ${only.offeredTo}`);
    const row = await this.db.get<{ count: number }>(
      sql`SELECT COUNT(*) as count FROM agent_tasks${sqlWhere(conditions)}`,
    );
    return row?.count ?? 0;
  }

  listRecentLeadDelegations(
    since: string,
    readableBy?: { userId: string | null },
  ): Promise<ConcurrentTaskRow[]> {
    const readable = readableBy
      ? sql` AND ${readableSessionSql(readableBy.userId, sql`t.id`)}`
      : EMPTY;
    return this.db.query<ConcurrentTaskRow>(sql`
      SELECT t.id, t.task, t."agentId", a.name as "agentName", t."creatorAgentId", t.status, t."createdAt"
      FROM agent_tasks t
      LEFT JOIN agents a ON t."agentId" = a.id
      WHERE t."createdAt" > ${since}
        AND t."creatorAgentId" IN (SELECT id FROM agents WHERE "isLead" = ${true})${readable}
      ORDER BY t."createdAt" DESC, ${this.insertionOrder("t")} DESC`);
  }

  listActiveSwarmTasks(readableBy?: { userId: string | null }): Promise<ConcurrentTaskRow[]> {
    const readable = readableBy
      ? sql` AND ${readableSessionSql(readableBy.userId, sql`t.id`)}`
      : EMPTY;
    return this.db.query<ConcurrentTaskRow>(sql`
      SELECT t.id, t.task, t."agentId", a.name as "agentName", t.status, t."createdAt", t.progress
      FROM agent_tasks t
      LEFT JOIN agents a ON t."agentId" = a.id
      WHERE t.status = 'in_progress'${readable}
      ORDER BY t."createdAt" DESC, ${this.insertionOrder("t")} DESC`);
  }

  findLatestTaskByAgentMailThread(threadId: string): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      SELECT * FROM agent_tasks WHERE "agentmailThreadId" = ${threadId}
      ORDER BY "createdAt" DESC, ${this.insertionOrder()} DESC LIMIT 1`);
  }

  abstract listStalledInProgressTasks(cutoff: string): Promise<TaskRow[]>;

  listStalePinnedResumes(cutoff: string): Promise<TaskRow[]> {
    // CAST: `tags` is jsonb on Postgres; on SQLite it is TEXT, so the cast changes nothing.
    const tagged = (tag: string) => likeAsciiCi(sql`CAST(tags AS text)`, sql`${`%"${tag}"%`}`);
    return this.db.query<TaskRow>(sql`
      SELECT * FROM agent_tasks
      WHERE status = 'pending'
        AND (
          ("taskType" = 'resume' AND (${tagged("crash-recovery-pin")} OR ${tagged("graceful-shutdown-pin")}))
          OR ${tagged("reboot-retry-pin")}
        )
        AND "createdAt" < ${cutoff}
      ORDER BY "createdAt" ASC, ${this.insertionOrder()} ASC`);
  }

  failPendingTask(
    taskId: string,
    f: { status: TaskStatus; statusKind: string; failureReason: string; now: string },
  ): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(sql`
      UPDATE agent_tasks
      SET status = ${f.status}, "statusKind" = ${f.statusKind}, "failureReason" = ${f.failureReason},
        "finishedAt" = ${f.now}, "lastUpdatedAt" = ${f.now}
      WHERE id = ${taskId} AND status = 'pending' RETURNING *`);
  }

  listStaleUnassignedAffinityTasks(cutoff: string): Promise<TaskRow[]> {
    return this.db.query<TaskRow>(sql`
      SELECT * FROM agent_tasks
      WHERE status = 'unassigned' AND "routingAffinity" IS NOT NULL AND "createdAt" < ${cutoff}
      ORDER BY "createdAt" ASC, ${this.insertionOrder()} ASC`);
  }

  listRecentFailedTasks(since: string, limit: number): Promise<TaskRow[]> {
    return this.db.query<TaskRow>(sql`
      SELECT * FROM agent_tasks WHERE status = 'failed' AND "finishedAt" > ${since}
      ORDER BY "finishedAt" DESC, ${this.insertionOrder()} DESC LIMIT ${limit}`);
  }

  async countTasksFinishedSince(status: string, since: string): Promise<number> {
    const row = await this.db.get<{ count: number }>(sql`
      SELECT COUNT(*) as count FROM agent_tasks WHERE status = ${status} AND "finishedAt" > ${since}`);
    return row?.count ?? 0;
  }

  abstract countTasksCreatedLastDay(): Promise<number>;

  async hasCompletedTask(): Promise<boolean> {
    const row = await this.db.get<{ one: number }>(
      sql`SELECT 1 AS one FROM agent_tasks WHERE status = 'completed' LIMIT 1`,
    );
    return row !== null;
  }

  countTasksByStatus(): Promise<{ status: string; count: number }[]> {
    return this.db.query<{ status: string; count: number }>(sql`
      SELECT status, COUNT(*) AS count FROM agent_tasks GROUP BY status ORDER BY status`);
  }

  // ---- agent_tasks: workflow links ----

  async listTaskIdsOfWorkflow(workflowId: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(sql`
      SELECT id FROM agent_tasks
      WHERE "workflowRunId" IN (SELECT id FROM workflow_runs WHERE "workflowId" = ${workflowId})
      ORDER BY ${this.insertionOrder()}`);
    return rows.map((row) => row.id);
  }

  async unlinkTasksFromWorkflow(workflowId: string): Promise<void> {
    await this.db.run(sql`
      UPDATE agent_tasks SET "workflowRunId" = NULL, "workflowRunStepId" = NULL
      WHERE "workflowRunId" IN (SELECT id FROM workflow_runs WHERE "workflowId" = ${workflowId})`);
  }

  findTaskByWorkflowRunStepId(stepId: string): Promise<TaskRow | null> {
    return this.db.get<TaskRow>(
      sql`SELECT * FROM agent_tasks WHERE "workflowRunStepId" = ${stepId} LIMIT 1`,
    );
  }

  async detachTaskFromWorkflowRunStep(taskId: string): Promise<void> {
    await this.db.run(sql`UPDATE agent_tasks SET "workflowRunStepId" = NULL WHERE id = ${taskId}`);
  }

  // ---- agent_tasks: credential keys ----

  countInProgressByCredentialSuffix(
    keyType: string,
    suffixes: readonly string[],
  ): Promise<{ suffix: string; n: number }[]> {
    return this.db.query<{ suffix: string; n: number }>(sql`
      SELECT "credentialKeySuffix" AS suffix, COUNT(*) AS n FROM agent_tasks
      WHERE status = 'in_progress' AND "credentialKeyType" = ${keyType}
        AND "credentialKeySuffix" IN (${sqlList(suffixes)})
      GROUP BY "credentialKeySuffix"
      ORDER BY "credentialKeySuffix"`);
  }

  async setTaskCredentialKey(taskId: string, keySuffix: string, keyType: string): Promise<void> {
    await this.db.run(sql`
      UPDATE agent_tasks SET "credentialKeySuffix" = ${keySuffix}, "credentialKeyType" = ${keyType}
      WHERE id = ${taskId}`);
  }

  // ---- task_context_snapshots ----

  async insertContextSnapshot(r: ContextSnapshotRow): Promise<void> {
    await this.db.run(sql`
      INSERT INTO task_context_snapshots (id, "taskId", "agentId", "sessionId", "contextUsedTokens",
        "contextTotalTokens", "contextPercent", "eventType", "compactTrigger", "preCompactTokens",
        "cumulativeInputTokens", "cumulativeOutputTokens", "contextFormula", "createdAt")
      VALUES (${r.id}, ${r.taskId}, ${r.agentId}, ${r.sessionId}, ${r.contextUsedTokens},
        ${r.contextTotalTokens}, ${r.contextPercent}, ${r.eventType}, ${r.compactTrigger},
        ${r.preCompactTokens}, ${r.cumulativeInputTokens}, ${r.cumulativeOutputTokens},
        ${r.contextFormula}, ${r.createdAt})`);
  }

  async applyContextSnapshotToTask(
    taskId: string,
    s: {
      contextPercent: number | null;
      contextUsedTokens: number | null;
      contextTotalTokens: number | null;
      compaction: boolean;
    },
  ): Promise<void> {
    if (s.contextPercent != null) {
      await this.db.run(sql`
        UPDATE agent_tasks
        SET "peakContextPercent" = ${greatestStrict(sql`COALESCE("peakContextPercent", 0)`, sql`${s.contextPercent}`)}
        WHERE id = ${taskId}`);
    }
    // peakContextTokens is monotonic-max across snapshots, not a rolling latest.
    if (s.contextUsedTokens != null) {
      await this.db.run(sql`
        UPDATE agent_tasks
        SET "peakContextTokens" = ${greatestStrict(sql`COALESCE("peakContextTokens", 0)`, sql`${s.contextUsedTokens}`)}
        WHERE id = ${taskId}`);
    }
    if (s.compaction) {
      await this.db.run(sql`
        UPDATE agent_tasks SET "compactionCount" = COALESCE("compactionCount", 0) + 1
        WHERE id = ${taskId}`);
    }
    // The first snapshot that carries a window size sets it; the window does not change mid-session.
    if (s.contextTotalTokens != null) {
      await this.db.run(sql`
        UPDATE agent_tasks SET "contextWindowSize" = ${s.contextTotalTokens}
        WHERE id = ${taskId} AND "contextWindowSize" IS NULL`);
    }
  }

  listContextSnapshots(
    by: { taskId: string } | { sessionId: string },
    limit: number,
  ): Promise<ContextSnapshotRow[]> {
    const where =
      "taskId" in by ? sql`"taskId" = ${by.taskId}` : sql`"sessionId" = ${by.sessionId}`;
    return this.db.query<ContextSnapshotRow>(sql`
      SELECT * FROM task_context_snapshots WHERE ${where}
      ORDER BY "createdAt" ASC, ${this.insertionOrder()} ASC LIMIT ${limit}`);
  }

  async countContextSnapshots(taskId: string): Promise<number> {
    const row = await this.db.get<{ cnt: number }>(
      sql`SELECT COUNT(*) as cnt FROM task_context_snapshots WHERE "taskId" = ${taskId}`,
    );
    return row?.cnt ?? 0;
  }

  // ---- task_templates ----

  listTaskTemplates(f: {
    category?: string;
    kind?: string;
    query?: string;
  }): Promise<TaskTemplateRow[]> {
    const conditions: SqlQuery[] = [];
    if (f.category) conditions.push(sql`category = ${f.category}`);
    if (f.kind) conditions.push(sql`kind = ${f.kind}`);
    if (f.query && f.query.trim().length > 0) {
      const needle = `%${f.query.toLowerCase()}%`;
      conditions.push(sql`(${likeAsciiCi(sql`LOWER(title)`, sql`${needle}`)}
        OR ${likeAsciiCi(sql`LOWER(description)`, sql`${needle}`)})`);
    }
    return this.db.query<TaskTemplateRow>(sql`
      SELECT * FROM task_templates${sqlWhere(conditions)}
      ORDER BY "createdAt", ${this.insertionOrder()}`);
  }

  // ---- sessions: root chain ----

  abstract listRootTaskChain(rootTaskId: string): Promise<TaskRow[]>;

  async listTaskIdsRequestedByUser(userId: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(sql`
      SELECT id FROM agent_tasks WHERE "requestedByUserId" = ${userId}
      UNION
      SELECT id FROM agent_tasks
      WHERE "workflowRunId" IN (SELECT id FROM workflow_runs WHERE created_by = ${userId})
      ORDER BY id`);
    return rows.map((row) => row.id);
  }
  // ---- agent_tasks: reads and writes of callers outside the tasks module ----

  async findOpenChildTaskId(
    parentTaskId: string,
    terminalStatuses: readonly string[],
  ): Promise<string | null> {
    const row = await this.db.get<{ id: string }>(sql`
      SELECT id FROM agent_tasks
      WHERE "parentTaskId" = ${parentTaskId} AND status NOT IN (${sqlList(terminalStatuses)})
      LIMIT 1`);
    return row?.id ?? null;
  }

  /** Membership test on the `dependsOn` JSON array (SQLite `json_each`). */
  abstract repointTaskDependency(
    taskId: string,
    status: string,
    fromTaskId: string,
    dependsOnJson: string,
  ): Promise<boolean>;

  /** Keeps the SQLite index hints (unary `+`) that the query plan depends on. */
  abstract findOpenHeartbeatChecklistTask(
    agentId: string,
    openStatuses: readonly string[],
  ): Promise<string | null>;

  async findOpenBootTriageTask(
    agentId: string,
    terminalStatuses: readonly string[],
  ): Promise<string | null> {
    const row = await this.db.get<{ id: string }>(sql`
      SELECT id FROM agent_tasks
      WHERE "agentId" = ${agentId} AND "taskType" = 'boot-triage'
        AND status NOT IN (${sqlList(terminalStatuses)})
      LIMIT 1`);
    return row?.id ?? null;
  }

  async setTaskRuntimeInstance(
    taskId: string,
    agentId: string,
    runtimeInstanceId: string,
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE agent_tasks SET runtime_instance_id = ${runtimeInstanceId}
      WHERE id = ${taskId} AND "agentId" = ${agentId}`);
  }

  async listLiveInProgressTaskIds(cutoff: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(sql`
      SELECT t.id AS id
      FROM agent_tasks t
      JOIN agents a ON a.id = t."agentId"
      WHERE t.status = 'in_progress' AND a.status != 'offline' AND a."lastUpdatedAt" >= ${cutoff}`);
    return rows.map((row) => row.id);
  }

  /** Reads the ids as one JSON array (SQLite `json_each`), so no parameter limit applies. */
  abstract countInProgressAmong(taskIds: readonly string[]): Promise<number>;

  /** `json_each` over `dependsOn` and a scalar `max` (SQLite). */
  abstract queueStallOldest(): Promise<{
    claimableCount: number;
    oldestTaskId: string | null;
    oldestClaimableAt: string | null;
  } | null>;

  async hasUserOrNonSystemTask(): Promise<boolean> {
    const row = await this.db.get<{ existing: number }>(sql`
      SELECT CASE WHEN
        EXISTS (SELECT 1 FROM users LIMIT 1)
        OR EXISTS (
          SELECT 1 FROM agent_tasks
          WHERE "taskType" IS NULL OR "taskType" NOT IN ('boot-triage', 'heartbeat-checklist')
          LIMIT 1
        )
      THEN 1 ELSE 0 END AS existing`);
    return Number(row?.existing) === 1;
  }

  taskTreeSettlement(
    rootId: string,
    terminalStatuses: readonly string[],
  ): Promise<{ open: number; deferred: number; lastFinishedAt: string | null } | null> {
    // UNION (not UNION ALL) drops repeated ids, so a parentTaskId cycle ends the walk.
    return this.db.get(sql`
      WITH RECURSIVE tree(id) AS (
        SELECT CAST(${rootId} AS TEXT)
        UNION
        SELECT t.id FROM agent_tasks t JOIN tree ON t."parentTaskId" = tree.id
      )
      SELECT
        COALESCE(SUM(CASE WHEN t.status NOT IN (${sqlList(terminalStatuses)}) THEN 1 ELSE 0 END), 0) AS open,
        CASE WHEN EXISTS (
          SELECT 1 FROM scheduled_tasks s
          WHERE s."parentTaskId" IN (SELECT id FROM tree)
            AND s."taskType" = 'deferred' AND s.enabled = ${true}
        ) THEN 1 ELSE 0 END AS deferred,
        MAX(COALESCE(t."finishedAt", t."lastUpdatedAt")) AS "lastFinishedAt"
      FROM tree JOIN agent_tasks t ON t.id = tree.id`);
  }

  async carrySteeringMessages(fromTaskId: string, toTaskId: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(sql`
      UPDATE task_steering_messages
        SET task_id = ${toTaskId}, status = 'pending', delivered_mode = NULL, delivered_at = NULL
        WHERE task_id = ${fromTaskId} AND status IN ('pending', 'delivered')
        RETURNING id`);
    return rows.map((row) => row.id);
  }

  countFinishedTaskOutcomes(): Promise<{ completed: number | null; failed: number | null } | null> {
    return this.db.get(sql`
      SELECT SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
        FROM agent_tasks WHERE status IN ('completed', 'failed')`);
  }

  countTaskActivitySince(since: string): Promise<{
    created: number | null;
    completed: number | null;
    failed: number | null;
  } | null> {
    return this.db.get(sql`
      SELECT SUM(CASE WHEN "createdAt" >= ${since} THEN 1 ELSE 0 END) AS created,
             SUM(CASE WHEN status = 'completed' AND "finishedAt" >= ${since} THEN 1 ELSE 0 END) AS completed,
             SUM(CASE WHEN status = 'failed' AND "finishedAt" >= ${since} THEN 1 ELSE 0 END) AS failed
        FROM agent_tasks`);
  }

  async countDistinctRequestersSince(since: string): Promise<number> {
    const row = await this.db.get<{ n: number }>(sql`
      SELECT COUNT(DISTINCT "requestedByUserId") AS n
        FROM agent_tasks
       WHERE "requestedByUserId" IS NOT NULL AND "createdAt" >= ${since}`);
    return Number(row?.n ?? 0);
  }

  findRootTaskSource(taskId: string, maxDepth: number): Promise<{ source: string | null } | null> {
    return this.db.get(sql`
      WITH RECURSIVE chain(id, "parentTaskId", source, depth) AS (
        SELECT id, "parentTaskId", source, 0 FROM agent_tasks WHERE id = ${taskId}
        UNION ALL
        SELECT t.id, t."parentTaskId", t.source, c.depth + 1
          FROM agent_tasks t JOIN chain c ON t.id = c."parentTaskId"
         WHERE c.depth < ${maxDepth}
      )
      SELECT source FROM chain ORDER BY depth DESC LIMIT 1`);
  }

  async findTaskStatus(taskId: string): Promise<string | null> {
    const row = await this.db.get<{ status: string }>(
      sql`SELECT status FROM agent_tasks WHERE id = ${taskId}`,
    );
    return row?.status ?? null;
  }

  findTaskParentId(taskId: string): Promise<{ parentTaskId: string | null } | null> {
    return this.db.get(sql`SELECT "parentTaskId" FROM agent_tasks WHERE id = ${taskId}`);
  }

  async setTaskModelResolution(
    taskId: string,
    r: {
      resolvedModel: string | null;
      modelSource: string | null;
      modelAlias: string | null;
      resolvedProfile: string | null;
    },
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE agent_tasks SET "resolvedModel" = ${r.resolvedModel}, "modelSource" = ${r.modelSource},
        "modelAlias" = ${r.modelAlias}, "resolvedProfile" = ${r.resolvedProfile}
      WHERE id = ${taskId}`);
  }

  async clearTaskModelResolution(taskId: string): Promise<void> {
    await this.db.run(sql`
      UPDATE agent_tasks SET "resolvedModel" = NULL, "modelSource" = NULL, "modelAlias" = NULL,
        "resolvedProfile" = NULL
      WHERE id = ${taskId} AND ("resolvedModel" IS NOT NULL OR "modelSource" IS NOT NULL
        OR "modelAlias" IS NOT NULL OR "resolvedProfile" IS NOT NULL)`);
  }

  async agentRanModel(agentId: string, modelId: string): Promise<boolean> {
    const row = await this.db.get<{ id: string }>(sql`
      SELECT id FROM agent_tasks
      WHERE "agentId" = ${agentId}
        AND ("resolvedModel" = ${modelId} OR ("resolvedModel" IS NULL AND model = ${modelId}))
      LIMIT 1`);
    return row != null;
  }

  listTaskSlackThreads(taskIds: readonly string[]): Promise<
    {
      slackChannelId: string | null;
      slackThreadTs: string | null;
      taskType: string | null;
    }[]
  > {
    if (taskIds.length === 0) return Promise.resolve([]);
    return this.db.query(sql`
      SELECT "slackChannelId", "slackThreadTs", "taskType" FROM agent_tasks
      WHERE id IN (${sqlList(taskIds)})`);
  }

  async listOpenTaskIdsOfRuns(
    runIds: readonly string[],
    terminalStatuses: readonly string[],
  ): Promise<string[]> {
    if (runIds.length === 0) return [];
    const rows = await this.db.query<{ id: string }>(sql`
      SELECT id FROM agent_tasks
      WHERE "workflowRunId" IN (${sqlList(runIds)}) AND status NOT IN (${sqlList(terminalStatuses)})`);
    return rows.map((row) => row.id);
  }

  async hasOpenTaskOfRuns(
    runIds: readonly string[],
    terminalStatuses: readonly string[],
  ): Promise<boolean> {
    if (runIds.length === 0) return false;
    const row = await this.db.get(sql`
      SELECT 1 AS found FROM agent_tasks
      WHERE "workflowRunId" IN (${sqlList(runIds)}) AND status NOT IN (${sqlList(terminalStatuses)})
      LIMIT 1`);
    return row != null;
  }

  /** Expands the `dependsOn` JSON arrays (SQLite `json_each`). */
  abstract listDependedOnTaskIds(terminalStatuses: readonly string[]): Promise<string[]>;

  findCitationTarget(
    kind: TaskCitationTargetKind,
    ref: string,
  ): Promise<{ id?: string; content?: string } | null> {
    const table = {
      task: "agent_tasks",
      memory: "agent_memory",
      page: "pages",
      "script-run": "script_runs",
    }[kind];
    const column = kind === "memory" ? sql`content` : sql`id`;
    return this.db.get(sql`SELECT ${column} FROM ${sqlIdent(table)} WHERE id = ${ref}`);
  }

  /** GLOB, `instr` and `char` text scanning (SQLite). */
  abstract shippingEvidenceSql(
    alias: string,
    host: string,
  ): { hasArtifact: SqlQuery; hasPullRequest: SqlQuery };
  abstract listAttributionRoots(
    window: AttributionWindow,
    githubHost: string,
  ): Promise<AttributionRootRow[]>;
  abstract listAttributionReach(window: AttributionWindow): Promise<AttributionReachRow[]>;
}
