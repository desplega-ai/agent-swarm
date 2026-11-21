import type { SqlExecutor } from "../executor";
import { sql } from "../sql";

/**
 * Domain: tasks (`agent_tasks`, `agent_tasks_fts*`, `task_attachments`,
 * `task_citations`, `task_context_snapshots`, `task_idempotency_keys`,
 * `task_steering_messages`, `task_templates`, `task_ui_action_runs`,
 * `task_ui_specs`, `deferred_task_waits`, `deferred_task_wait_members`,
 * `deferred_event_waits`, `routing_decisions`, `human_free_reclassify_queue`,
 * `checklist_items`). Rows come back in the SQLite value shape on every engine
 * (flags 0/1, JSON as text, timestamps as the text the column stores).
 */

/** One `agent_tasks` row. Enum-like columns are plain text here; `src/` narrows them. */
export type TaskRow = {
  id: string;
  key: string;
  agentId: string | null;
  creatorAgentId: string | null;
  task: string;
  title: string | null;
  status: string;
  source: string;
  routing_reason: string | null;
  routing_source: string | null;
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

  // ---- task_idempotency_keys ----
  findTaskIdempotencyKey(principal: string, keyHash: string): Promise<TaskIdempotencyKeyRow | null>;
  /** Plain insert: a duplicate `(principal, keyHash)` throws the engine's unique violation. */
  insertTaskIdempotencyKey(row: TaskIdempotencyKeyRow): Promise<void>;
}

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
             "slackParticipants" = COALESCE(${args.slackParticipants}, "slackParticipants"),
             "lastUpdatedAt" = ${args.now}
         WHERE id = ${args.taskId} AND status = 'pending' AND task = ${args.expectedTask}`);
    return result.changes;
  }

  /** Reads a JSON field of `agent_log.metadata` (SQLite `json_extract`). */
  abstract listDeliveredSlackMessageTs(
    channelId: string,
    threadTs: string,
  ): Promise<(string | null)[]>;

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
}
