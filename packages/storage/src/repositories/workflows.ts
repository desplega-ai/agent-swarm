import type { SqlExecutor } from "../executor";
import { sql, sqlList } from "../sql";

/**
 * Domain: workflows (`workflows`, `workflow_versions`, `workflow_runs`,
 * `workflow_run_steps`, `workflow_run_definitions`,
 * `workflow_idempotency_keys`, `wait_states`, `approval_requests`). Rows come
 * back in the SQLite value shape on every engine (flags 0/1, JSON as text,
 * timestamps as the text the column stores).
 *
 * Methods that take a list of ids bind each id: the caller keeps each list
 * under the engine's bound-parameter limit.
 */

export type WorkflowRow = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  enabled: number;
  definition: string;
  triggers: string;
  cooldown: string | null;
  input: string | null;
  triggerSchema: string | null;
  params: string;
  requiredParams: string;
  requires: string;
  dir: string | null;
  vcs_repo: string | null;
  createdByAgentId: string | null;
  updatedByAgentId: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  created_by: string | null;
  updated_by: string | null;
};

export type WorkflowRunRow = {
  id: string;
  workflowId: string;
  status: string;
  triggerType: string;
  triggerData: string | null;
  /** Absent from summary rows. */
  context?: string | null;
  /** Sealed exact `context` (migration 201). Absent from summary rows. */
  context_replay?: string | null;
  error: string | null;
  created_by: string | null;
  startedAt: string;
  lastUpdatedAt: string;
  finishedAt: string | null;
  /** The `sub-workflow` step that started this run (migration 203). */
  parentStepId?: string | null;
  /** That step's attempt (`retryCount`) when it started this run (migration 240). */
  parentStepAttempt?: number | null;
};

export type WorkflowRunStepRow = {
  id: string;
  runId: string;
  nodeId: string;
  nodeType: string;
  status: string;
  /** Absent from slim rows. */
  input?: string | null;
  output: string | null;
  /** Sealed exact `output` (migration 201). Absent from slim rows. */
  output_replay?: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  retryCount: number;
  maxRetries: number;
  nextRetryAt: string | null;
  idempotencyKey: string | null;
  diagnostics: string | null;
  nextPort: string | null;
};

/** A `pending` step row the foreach driver queues. */
export type NewPendingWorkflowStep = {
  id: string;
  runId: string;
  nodeId: string;
  nodeType: string;
  startedAt: string;
  /** Scrubbed JSON text. */
  input: string;
  idempotencyKey: string;
};

/** One `Idempotency-Key` scope, with the key already hashed. */
export type WorkflowIdempotencyScopeKey = {
  principal: string;
  operation: string;
  targetId: string;
  keyHash: string;
};

export type WorkflowIdempotencyRecordRow = {
  requestFingerprint: string;
  responseStatus: number;
  responseBody: string | null;
  resourceDeletedAt: string | null;
};

export type NewWorkflowIdempotencyRecord = WorkflowIdempotencyScopeKey & {
  id: string;
  requestFingerprint: string;
  workflowId: string;
  runId: string | null;
  responseStatus: number;
  /** Sealed JSON text. */
  responseBody: string;
  createdAt: string;
  actor: string | null;
};

/** A run with its own status and parent link, `depth` steps up from the start run. */
export type WorkflowRunLineageRow = {
  id: string;
  status: string;
  parentStepId: string | null;
  depth: number;
};

export type WorkflowStepExecutionRow = {
  stepStatus: string;
  runId: string;
  runStatus: string;
};

export type WorkflowRunParentRow = {
  runId: string;
  workflowId: string;
  stepId: string;
  nodeId: string;
};

export type WorkflowFanoutCandidateRow = {
  runId: string;
  workflowId: string;
  stepId: string;
  nodeId: string;
  status: string;
};

/** Every `workflow_runs` column but `context` and `context_replay`. */
const RUN_SUMMARY_COLUMNS = sql`id, "workflowId", status, "triggerType", "triggerData", error, created_by, "startedAt", "lastUpdatedAt", "finishedAt", "parentStepId", "parentStepAttempt"`;

/** Every `workflow_run_steps` column but `input` and `output_replay`. */
export const WORKFLOW_RUN_STEP_SLIM_COLUMNS = sql`id, "runId", "nodeId", "nodeType", status, output, error, "startedAt", "finishedAt", "retryCount", "maxRetries", "nextRetryAt", "idempotencyKey", diagnostics, "nextPort"`;

export interface WorkflowsRepository {
  // --- workflows ---------------------------------------------------------

  /**
   * Enabled workflows with an `event` trigger on `eventName`, each once.
   * Ordered by `lastUpdatedAt` descending, ties in insertion order (SQLite).
   */
  listEnabledByEventName(eventName: string): Promise<WorkflowRow[]>;

  // --- runs --------------------------------------------------------------

  getRunPrincipal(
    runId: string,
  ): Promise<{ principal: string | null; triggeredByAgentId: string | null } | null>;
  /** The run without `context`. */
  getRunSummary(id: string): Promise<WorkflowRunRow | null>;
  /** Summary rows of the given runs, ordered by id. */
  listRunSummariesByIds(ids: readonly string[]): Promise<WorkflowRunRow[]>;
  getRunStatus(runId: string): Promise<string | null>;
  /**
   * The run and its ancestors through stored parent links, at most `maxDepth`
   * levels up. Ordered by depth (one row per depth, repeated runs on a cycle).
   */
  listRunLineage(runId: string, maxDepth: number): Promise<WorkflowRunLineageRow[]>;
  /** `workflowId` of the run and its ancestors, nearest first (ordered by depth). */
  listRunLineageWorkflowIds(runId: string, maxDepth: number): Promise<string[]>;
  /**
   * Ids of the runs a step of the given runs started. Ordered by the parent
   * run id, then the parent step's status and insertion order, then the attempt.
   */
  listChildRunIds(parentRunIds: readonly string[]): Promise<string[]>;
  /** True when any of the runs is `running` or `waiting`. */
  hasLiveRun(runIds: readonly string[]): Promise<boolean>;
  /** True when any of the runs has a pending, running or waiting step, or a queued retry. */
  hasOpenStep(runIds: readonly string[]): Promise<boolean>;
  /** True when any of the runs has a pending approval request. */
  hasPendingApproval(runIds: readonly string[]): Promise<boolean>;
  /** Cancels the pending, running and waiting steps of the runs. */
  cancelOpenStepsOfRuns(
    runIds: readonly string[],
    error: string,
    finishedAt: string,
  ): Promise<void>;
  /** Drops the queued retries of the failed steps of the runs. */
  disarmRetriesOfRuns(runIds: readonly string[], finishedAt: string): Promise<void>;
  /**
   * Cancels the runs that are still running or waiting and returns them, in
   * the order the engine updated them (id order on SQLite).
   */
  cancelLiveRuns(
    runIds: readonly string[],
    error: string,
    finishedAt: string,
  ): Promise<{ id: string; workflowId: string }[]>;
  getChildRunId(parentStepId: string, attempt: number): Promise<string | null>;
  /**
   * The run id when `stepId` is `running` on `attempt` in a running or waiting
   * run, else null.
   */
  getLiveStepAttemptRunId(stepId: string, attempt: number): Promise<string | null>;
  getStepExecutionState(stepId: string): Promise<WorkflowStepExecutionRow | null>;
  /**
   * `running` `sub-workflow` steps of live runs that are their node's latest
   * row. Ordered by step insertion order.
   */
  listRunningSubWorkflowSteps(): Promise<{ stepId: string; runId: string; nodeId: string }[]>;
  /** The step and its run, for the parent of a child run. */
  getRunParent(parentStepId: string): Promise<WorkflowRunParentRow | null>;
  /**
   * Waiting `sub-workflow` steps whose current attempt's child run is terminal
   * or missing. Ordered by step insertion order.
   */
  listSettledChildRunParentStepIds(): Promise<string[]>;
  /** Runs of the workflow that a step started, in insertion order. */
  listChildRunsOfWorkflow(workflowId: string): Promise<{ id: string; parentStepId: string }[]>;
  /** Run ids with the status, in insertion order. */
  listRunIdsByStatus(status: string): Promise<string[]>;

  // --- steps -------------------------------------------------------------

  /** Slim step rows of the run, ordered by `startedAt`, then insertion order. */
  listStepsSlim(runId: string): Promise<WorkflowRunStepRow[]>;
  /** Distinct node ids of the run's steps that start with `prefix`, ordered by node id. */
  listStepNodeIdsWithPrefix(runId: string, prefix: string): Promise<string[]>;
  countStepsForNode(runId: string, nodeId: string): Promise<number>;
  insertPendingStep(step: NewPendingWorkflowStep): Promise<void>;
  /** Inserts the step unless its idempotency key exists. True when inserted. */
  insertPendingStepIfNewKey(step: NewPendingWorkflowStep): Promise<boolean>;
  /**
   * True when the step is `running` on `retryCount` in the run, and the run is
   * running or waiting.
   */
  holdsStepFence(runId: string, stepId: string, retryCount: number): Promise<boolean>;
  /** `running` to `waiting`, only while the run is running or waiting. True when moved. */
  parkRunningStep(runId: string, stepId: string): Promise<boolean>;
  /** Moves the step from `from` to `to`. True when it moved. */
  transitionStepStatus(stepId: string, from: string, to: string): Promise<boolean>;
  /** Cancels a pending step or a failed step with a queued retry. True when cancelled. */
  cancelQueuedStep(stepId: string, error: string, finishedAt: string): Promise<boolean>;
  /** Drops the queued retry of a failed step without reviving it. */
  dropStepRetry(runId: string, stepId: string, finishedAt: string): Promise<void>;
  /**
   * Claims the queued retry of a failed step: back to `running`, or to
   * `pending` with the error cleared when `requeue`. True when claimed.
   */
  claimStepRetry(runId: string, stepId: string, requeue: boolean): Promise<boolean>;
  /**
   * Pending and running foreach child rows (`#` in the node id after its first
   * character) of live runs. Ordered by step status, then insertion order.
   */
  listForeachFanoutCandidates(): Promise<WorkflowFanoutCandidateRow[]>;

  // --- run definitions ---------------------------------------------------

  /** Stores the snapshot once per hash; an existing hash is kept. */
  insertRunDefinition(hash: string, snapshot: string, createdAt: string): Promise<void>;
  getRunDefinitionSnapshot(runId: string): Promise<string | null>;
  /** Deletes the given snapshots that no run references. */
  deleteUnreferencedRunDefinitions(hashes: readonly string[]): Promise<void>;

  // --- idempotency keys --------------------------------------------------

  findIdempotencyRecord(
    scope: WorkflowIdempotencyScopeKey,
  ): Promise<WorkflowIdempotencyRecordRow | null>;
  idempotencyRecordExists(scope: WorkflowIdempotencyScopeKey): Promise<boolean>;
  /** Throws the engine's unique-constraint error when the scope is taken. */
  insertIdempotencyRecord(record: NewWorkflowIdempotencyRecord): Promise<void>;
  /** Clears the stored response of each live record naming the workflow. */
  tombstoneIdempotencyRecords(workflowId: string, now: string, actor: string | null): Promise<void>;
}

export abstract class BaseWorkflowsRepository implements WorkflowsRepository {
  constructor(protected readonly db: SqlExecutor) {}

  abstract listEnabledByEventName(eventName: string): Promise<WorkflowRow[]>;

  getRunPrincipal(
    runId: string,
  ): Promise<{ principal: string | null; triggeredByAgentId: string | null } | null> {
    return this.db.get<{ principal: string | null; triggeredByAgentId: string | null }>(
      sql`SELECT principal, "triggeredByAgentId" FROM workflow_runs WHERE id = ${runId}`,
    );
  }

  getRunSummary(id: string): Promise<WorkflowRunRow | null> {
    return this.db.get<WorkflowRunRow>(
      sql`SELECT ${RUN_SUMMARY_COLUMNS} FROM workflow_runs WHERE id = ${id}`,
    );
  }

  listRunSummariesByIds(ids: readonly string[]): Promise<WorkflowRunRow[]> {
    return this.db.query<WorkflowRunRow>(
      sql`SELECT ${RUN_SUMMARY_COLUMNS} FROM workflow_runs WHERE id IN (${sqlList(ids)}) ORDER BY id`,
    );
  }

  async getRunStatus(runId: string): Promise<string | null> {
    const row = await this.db.get<{ status: string }>(
      sql`SELECT status FROM workflow_runs WHERE id = ${runId}`,
    );
    return row?.status ?? null;
  }

  async listRunLineage(runId: string, maxDepth: number): Promise<WorkflowRunLineageRow[]> {
    const rows = await this.db.query<WorkflowRunLineageRow>(sql`
      WITH RECURSIVE lineage(id, status, "parentStepId", depth) AS (
        SELECT id, status, "parentStepId", 0 FROM workflow_runs WHERE id = ${runId}
        UNION ALL
        SELECT r.id, r.status, r."parentStepId", l.depth + 1
          FROM lineage l
          JOIN workflow_run_steps s ON s.id = l."parentStepId"
          JOIN workflow_runs r ON r.id = s."runId"
         WHERE l.depth < ${maxDepth}
      )
      SELECT id, status, "parentStepId", depth FROM lineage ORDER BY depth`);
    return rows.map((row) => ({ ...row, depth: Number(row.depth) }));
  }

  async listRunLineageWorkflowIds(runId: string, maxDepth: number): Promise<string[]> {
    const rows = await this.db.query<{ workflowId: string }>(sql`
      WITH RECURSIVE lineage(id, "workflowId", "parentStepId", depth) AS (
        SELECT id, "workflowId", "parentStepId", 0 FROM workflow_runs WHERE id = ${runId}
        UNION ALL
        SELECT r.id, r."workflowId", r."parentStepId", l.depth + 1
          FROM lineage l
          JOIN workflow_run_steps s ON s.id = l."parentStepId"
          JOIN workflow_runs r ON r.id = s."runId"
         WHERE l.depth < ${maxDepth}
      )
      SELECT "workflowId" FROM lineage ORDER BY depth`);
    return rows.map((row) => row.workflowId);
  }

  abstract listChildRunIds(parentRunIds: readonly string[]): Promise<string[]>;

  async hasLiveRun(runIds: readonly string[]): Promise<boolean> {
    const row = await this.db.get(sql`
      SELECT 1 FROM workflow_runs
       WHERE id IN (${sqlList(runIds)}) AND status IN ('running', 'waiting') LIMIT 1`);
    return row != null;
  }

  async hasOpenStep(runIds: readonly string[]): Promise<boolean> {
    const row = await this.db.get(sql`
      SELECT 1 FROM workflow_run_steps
       WHERE "runId" IN (${sqlList(runIds)})
         AND (status IN ('pending', 'running', 'waiting')
              OR (status = 'failed' AND "nextRetryAt" IS NOT NULL))
       LIMIT 1`);
    return row != null;
  }

  async hasPendingApproval(runIds: readonly string[]): Promise<boolean> {
    const row = await this.db.get(sql`
      SELECT 1 FROM approval_requests
       WHERE "workflowRunId" IN (${sqlList(runIds)}) AND status = 'pending' LIMIT 1`);
    return row != null;
  }

  async cancelOpenStepsOfRuns(
    runIds: readonly string[],
    error: string,
    finishedAt: string,
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE workflow_run_steps
         SET status = 'cancelled', error = ${error}, "finishedAt" = ${finishedAt}
       WHERE "runId" IN (${sqlList(runIds)}) AND status IN ('pending', 'running', 'waiting')`);
  }

  async disarmRetriesOfRuns(runIds: readonly string[], finishedAt: string): Promise<void> {
    await this.db.run(sql`
      UPDATE workflow_run_steps
         SET "nextRetryAt" = NULL, "finishedAt" = COALESCE("finishedAt", ${finishedAt})
       WHERE "runId" IN (${sqlList(runIds)}) AND status = 'failed' AND "nextRetryAt" IS NOT NULL`);
  }

  cancelLiveRuns(
    runIds: readonly string[],
    error: string,
    finishedAt: string,
  ): Promise<{ id: string; workflowId: string }[]> {
    return this.db.query<{ id: string; workflowId: string }>(sql`
      UPDATE workflow_runs
         SET status = 'cancelled', error = ${error}, "finishedAt" = ${finishedAt}, "lastUpdatedAt" = ${finishedAt}
       WHERE id IN (${sqlList(runIds)}) AND status IN ('running', 'waiting')
       RETURNING id, "workflowId"`);
  }

  async getChildRunId(parentStepId: string, attempt: number): Promise<string | null> {
    const row = await this.db.get<{ id: string }>(sql`
      SELECT id FROM workflow_runs
       WHERE "parentStepId" = ${parentStepId} AND "parentStepAttempt" = ${attempt}`);
    return row?.id ?? null;
  }

  async getLiveStepAttemptRunId(stepId: string, attempt: number): Promise<string | null> {
    const row = await this.db.get<{ runId: string }>(sql`
      SELECT r.id AS "runId"
        FROM workflow_run_steps s
        JOIN workflow_runs r ON r.id = s."runId"
       WHERE s.id = ${stepId} AND s.status = 'running' AND s."retryCount" = ${attempt}
         AND r.status IN ('running', 'waiting')`);
    return row?.runId ?? null;
  }

  getStepExecutionState(stepId: string): Promise<WorkflowStepExecutionRow | null> {
    return this.db.get<WorkflowStepExecutionRow>(sql`
      SELECT s.status AS "stepStatus", r.id AS "runId", r.status AS "runStatus"
        FROM workflow_run_steps s
        JOIN workflow_runs r ON r.id = s."runId"
       WHERE s.id = ${stepId}`);
  }

  abstract listRunningSubWorkflowSteps(): Promise<
    { stepId: string; runId: string; nodeId: string }[]
  >;

  getRunParent(parentStepId: string): Promise<WorkflowRunParentRow | null> {
    return this.db.get<WorkflowRunParentRow>(sql`
      SELECT s."runId" AS "runId", r."workflowId" AS "workflowId", s.id AS "stepId", s."nodeId" AS "nodeId"
        FROM workflow_run_steps s
        JOIN workflow_runs r ON r.id = s."runId"
       WHERE s.id = ${parentStepId}`);
  }

  abstract listSettledChildRunParentStepIds(): Promise<string[]>;

  abstract listChildRunsOfWorkflow(
    workflowId: string,
  ): Promise<{ id: string; parentStepId: string }[]>;

  abstract listRunIdsByStatus(status: string): Promise<string[]>;

  abstract listStepsSlim(runId: string): Promise<WorkflowRunStepRow[]>;

  async listStepNodeIdsWithPrefix(runId: string, prefix: string): Promise<string[]> {
    const rows = await this.db.query<{ nodeId: string }>(sql`
      SELECT DISTINCT "nodeId" FROM workflow_run_steps
       WHERE "runId" = ${runId} AND substr("nodeId", 1, ${prefix.length}) = ${prefix}
       ORDER BY "nodeId"`);
    return rows.map((row) => row.nodeId);
  }

  async countStepsForNode(runId: string, nodeId: string): Promise<number> {
    const row = await this.db.get<{ n: number | string }>(sql`
      SELECT COUNT(*) AS n FROM workflow_run_steps WHERE "runId" = ${runId} AND "nodeId" = ${nodeId}`);
    return Number(row?.n ?? 0);
  }

  async insertPendingStep(s: NewPendingWorkflowStep): Promise<void> {
    await this.db.run(sql`
      INSERT INTO workflow_run_steps (id, "runId", "nodeId", "nodeType", status, "startedAt", input, "idempotencyKey")
      VALUES (${s.id}, ${s.runId}, ${s.nodeId}, ${s.nodeType}, 'pending', ${s.startedAt}, ${s.input}, ${s.idempotencyKey})`);
  }

  async insertPendingStepIfNewKey(s: NewPendingWorkflowStep): Promise<boolean> {
    const row = await this.db.get<{ id: string }>(sql`
      INSERT INTO workflow_run_steps (id, "runId", "nodeId", "nodeType", status, "startedAt", input, "idempotencyKey")
      VALUES (${s.id}, ${s.runId}, ${s.nodeId}, ${s.nodeType}, 'pending', ${s.startedAt}, ${s.input}, ${s.idempotencyKey})
      ON CONFLICT ("idempotencyKey") DO NOTHING
      RETURNING id`);
    return row != null;
  }

  async holdsStepFence(runId: string, stepId: string, retryCount: number): Promise<boolean> {
    const row = await this.db.get(sql`
      SELECT 1 AS found
        FROM workflow_run_steps s
        JOIN workflow_runs r ON r.id = s."runId"
       WHERE s.id = ${stepId} AND s."runId" = ${runId} AND s.status = 'running'
         AND s."retryCount" = ${retryCount}
         AND r.status IN ('running', 'waiting')`);
    return row != null;
  }

  async parkRunningStep(runId: string, stepId: string): Promise<boolean> {
    const row = await this.db.get<{ id: string }>(sql`
      UPDATE workflow_run_steps
         SET status = 'waiting'
       WHERE id = ${stepId} AND "runId" = ${runId} AND status = 'running'
         AND EXISTS (
           SELECT 1 FROM workflow_runs
           WHERE id = ${runId} AND status IN ('running', 'waiting')
         )
       RETURNING id`);
    return row != null;
  }

  async transitionStepStatus(stepId: string, from: string, to: string): Promise<boolean> {
    const row = await this.db.get<{ id: string }>(sql`
      UPDATE workflow_run_steps SET status = ${to}
       WHERE id = ${stepId} AND status = ${from}
       RETURNING id`);
    return row != null;
  }

  async cancelQueuedStep(stepId: string, error: string, finishedAt: string): Promise<boolean> {
    const row = await this.db.get<{ id: string }>(sql`
      UPDATE workflow_run_steps
         SET status = 'cancelled', error = ${error}, "finishedAt" = ${finishedAt}, "nextRetryAt" = NULL
       WHERE id = ${stepId} AND (status = 'pending' OR (status = 'failed' AND "nextRetryAt" IS NOT NULL))
       RETURNING id`);
    return row != null;
  }

  async dropStepRetry(runId: string, stepId: string, finishedAt: string): Promise<void> {
    await this.db.run(sql`
      UPDATE workflow_run_steps SET "nextRetryAt" = NULL, "finishedAt" = ${finishedAt}
       WHERE id = ${stepId} AND "runId" = ${runId} AND status = 'failed' AND "nextRetryAt" IS NOT NULL`);
  }

  async claimStepRetry(runId: string, stepId: string, requeue: boolean): Promise<boolean> {
    const set = requeue
      ? sql`status = 'pending', "nextRetryAt" = NULL, error = NULL`
      : sql`status = 'running', "nextRetryAt" = NULL`;
    const row = await this.db.get<{ id: string }>(sql`
      UPDATE workflow_run_steps
         SET ${set}
       WHERE id = ${stepId} AND "runId" = ${runId} AND status = 'failed' AND "nextRetryAt" IS NOT NULL
       RETURNING id`);
    return row != null;
  }

  abstract listForeachFanoutCandidates(): Promise<WorkflowFanoutCandidateRow[]>;

  async insertRunDefinition(hash: string, snapshot: string, createdAt: string): Promise<void> {
    await this.db.run(sql`
      INSERT INTO workflow_run_definitions (hash, snapshot, "createdAt")
      VALUES (${hash}, ${snapshot}, ${createdAt})
      ON CONFLICT (hash) DO NOTHING`);
  }

  async getRunDefinitionSnapshot(runId: string): Promise<string | null> {
    const row = await this.db.get<{ snapshot: string }>(sql`
      SELECT d.snapshot FROM workflow_runs r
        JOIN workflow_run_definitions d ON d.hash = r."definitionHash"
       WHERE r.id = ${runId}`);
    return row?.snapshot ?? null;
  }

  async deleteUnreferencedRunDefinitions(hashes: readonly string[]): Promise<void> {
    if (hashes.length === 0) return;
    await this.db.run(sql`
      DELETE FROM workflow_run_definitions
       WHERE hash IN (${sqlList(hashes)})
         AND NOT EXISTS (
           SELECT 1 FROM workflow_runs r WHERE r."definitionHash" = workflow_run_definitions.hash
         )`);
  }

  findIdempotencyRecord(
    scope: WorkflowIdempotencyScopeKey,
  ): Promise<WorkflowIdempotencyRecordRow | null> {
    return this.db.get<WorkflowIdempotencyRecordRow>(sql`
      SELECT "requestFingerprint", "responseStatus", "responseBody", "resourceDeletedAt"
        FROM workflow_idempotency_keys
       WHERE principal = ${scope.principal} AND operation = ${scope.operation}
         AND "targetId" = ${scope.targetId} AND "keyHash" = ${scope.keyHash}`);
  }

  async idempotencyRecordExists(scope: WorkflowIdempotencyScopeKey): Promise<boolean> {
    const row = await this.db.get(sql`
      SELECT 1 FROM workflow_idempotency_keys
       WHERE principal = ${scope.principal} AND operation = ${scope.operation}
         AND "targetId" = ${scope.targetId} AND "keyHash" = ${scope.keyHash}`);
    return row != null;
  }

  async insertIdempotencyRecord(r: NewWorkflowIdempotencyRecord): Promise<void> {
    await this.db.run(sql`
      INSERT INTO workflow_idempotency_keys
        (id, principal, operation, "targetId", "keyHash", "requestFingerprint", "workflowId", "runId",
         "responseStatus", "responseBody", "createdAt", created_by, updated_by)
      VALUES (${r.id}, ${r.principal}, ${r.operation}, ${r.targetId}, ${r.keyHash}, ${r.requestFingerprint},
        ${r.workflowId}, ${r.runId}, ${r.responseStatus}, ${r.responseBody}, ${r.createdAt},
        ${r.actor}, ${r.actor})`);
  }

  async tombstoneIdempotencyRecords(
    workflowId: string,
    now: string,
    actor: string | null,
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE workflow_idempotency_keys
         SET "responseBody" = NULL, "resourceDeletedAt" = ${now}, updated_by = ${actor}
       WHERE "workflowId" = ${workflowId} AND "resourceDeletedAt" IS NULL`);
  }
}
