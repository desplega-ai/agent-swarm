import { jsonText, likeAsciiCi, nowIso } from "../dialect";
import type { SqlExecutor } from "../executor";
import { EMPTY, type SqlQuery, sql, sqlJoin, sqlList, sqlWhere } from "../sql";
import type { AutomationPreflightRowText } from "./schedules";

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

export type WorkflowVersionRow = {
  id: string;
  workflowId: string;
  version: number;
  snapshot: string;
  changedByAgentId: string | null;
  createdAt: string;
  created_by?: string | null;
  updated_by?: string | null;
};

/** A new `workflows` row; JSON columns are already serialized. */
export type NewWorkflow = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  definition: string;
  triggers: string;
  cooldown: string | null;
  input: string | null;
  triggerSchema: string | null;
  params: string;
  requiredParams: string;
  requires: string;
  dir: string | null;
  vcsRepo: string | null;
  createdByAgentId: string | null;
  createdBy: string | null;
  enabled: boolean;
};

/** Columns a workflow update may set. `undefined` leaves a column unchanged. */
export type WorkflowColumnUpdate = {
  key?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  definition?: string;
  triggers?: string;
  cooldown?: string | null;
  input?: string | null;
  triggerSchema?: string | null;
  params?: string;
  requiredParams?: string;
  requires?: string;
  dir?: string | null;
  vcsRepo?: string | null;
  updatedBy?: string | null;
  updatedByAgentId?: string | null;
};

/** `listWorkflows` filters, values already normalized by the caller. */
export type WorkflowListFilter = {
  enabled?: boolean;
  key?: string;
  /** A LIKE pattern with `\` escapes. */
  keyPattern?: string;
  lastRunStatus?: string;
  consecutiveErrorsMin?: number;
  /** A LIKE pattern with `\` escapes, matched against name, description and key. */
  textPattern?: string;
  limit?: number;
};

export type NewWorkflowRun = {
  id: string;
  workflowId: string;
  triggerType: string;
  startedAt: string;
  triggerData: string | null;
  createdBy: string | null;
  parentStepId: string | null;
  parentStepAttempt: number;
  triggeredByAgentId: string | null;
  definitionHash: string | null;
  sourceStepId: string | null;
  principal: string | null;
};

/** Columns a run update may set. `undefined` leaves a column unchanged. */
export type WorkflowRunColumnUpdate = {
  status?: string;
  context?: string;
  context_replay?: string;
  error?: string | null;
  finishedAt?: string;
};

export type NewRunningWorkflowStep = {
  id: string;
  runId: string;
  nodeId: string;
  nodeType: string;
  startedAt: string;
  input: string | null;
  idempotencyKey: string | null;
};

/** Columns a step update may set. `undefined` leaves a column unchanged. */
export type WorkflowRunStepColumnUpdate = {
  status?: string;
  output?: string;
  output_replay?: string;
  error?: string | null;
  finishedAt?: string;
  retryCount?: number;
  maxRetries?: number;
  nextRetryAt?: string | null;
  idempotencyKey?: string;
  diagnostics?: string;
  nextPort?: string;
};

export type StuckWorkflowRunRow = {
  runId: string;
  stepId: string;
  nodeId: string;
  taskId: string;
  taskStatus: string;
  taskOutput: string | null;
  workflowId: string;
};

export type ApprovalRequestRow = {
  id: string;
  title: string;
  questions: string;
  workflowRunId: string | null;
  workflowRunStepId: string | null;
  sourceTaskId: string | null;
  approvers: string;
  status: string;
  responses: string | null;
  approvals: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
  cancellationNotificationClaims: string | null;
  timeoutSeconds: number | null;
  expiresAt: string | null;
  notificationChannels: string | null;
  created_by: string | null;
  updated_by?: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Slim approval list row: `questionCount` replaces the JSON columns. */
export type ApprovalRequestSummaryRow = {
  id: string;
  title: string;
  workflowRunId: string | null;
  workflowRunStepId: string | null;
  sourceTaskId: string | null;
  status: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  timeoutSeconds: number | null;
  expiresAt: string | null;
  created_by: string | null;
  createdAt: string;
  updatedAt: string;
  questionCount: number | null;
};

export type NewApprovalRequest = {
  id: string;
  title: string;
  questions: string;
  workflowRunId: string | null;
  workflowRunStepId: string | null;
  sourceTaskId: string | null;
  approvers: string;
  status: string;
  resolutionReason: string | null;
  resolvedAt: string | null;
  timeoutSeconds: number | null;
  expiresAt: string | null;
  notificationChannels: string | null;
  createdBy: string | null;
  now: string;
};

export type ApprovalResolution = {
  status: string;
  /** Sealed JSON text. */
  responses: string | null;
  /** Scrubbed votes JSON; null keeps the stored votes. */
  approvals: string | null;
  resolvedBy: string | null;
  resolutionReason: string | null;
  now: string;
};

/** `listApprovals` filters. Newest first. */
export type ApprovalListFilter = { status?: string; workflowRunId?: string; limit: number };

export type StuckApprovalRunRow = {
  runId: string;
  stepId: string;
  nodeId: string;
  workflowId: string;
  approvalId: string;
  approvalStatus: string;
  approvalResponses: string | null;
  expiresAt: string | null;
};

export type WaitStateRow = {
  id: string;
  workflowRunId: string;
  workflowRunStepId: string;
  mode: string;
  wakeUpAt: string | null;
  eventName: string | null;
  eventFilter: string | null;
  expiresAt: string | null;
  status: string;
  firedPayload: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  eventScope: string;
};

export type NewWaitState = {
  id: string;
  workflowRunId: string;
  workflowRunStepId: string;
  mode: string;
  wakeUpAt: string | null;
  eventName: string | null;
  eventFilter: string | null;
  expiresAt: string | null;
  eventScope: string;
  now: string;
};

export type StuckWaitRunRow = {
  runId: string;
  stepId: string;
  nodeId: string;
  workflowId: string;
  waitId: string;
  waitMode: string;
  waitStatus: string;
  wakeUpAt: string | null;
  expiresAt: string | null;
  firedPayload: string | null;
};

/**
 * Every `workflow_runs` column but `context` and `context_replay`. `triggerData`
 * stays: it is small, and stored scripts read it off list rows (dedupe by
 * trigger, failure reports). The parent link and attempt stay so a list row
 * identifies a child's invocation.
 */
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
  // --- workflow rows -----------------------------------------------------

  insertWorkflow(workflow: NewWorkflow): Promise<WorkflowRow | null>;
  findWorkflowById(id: string): Promise<WorkflowRow | null>;
  /** Ordered by `lastUpdatedAt` descending, ties in insertion order. */
  listWorkflows(filter: WorkflowListFilter): Promise<WorkflowRow[]>;
  /** Sets the given columns plus `lastUpdatedAt`. Needs at least one column. */
  updateWorkflowColumns(
    id: string,
    update: WorkflowColumnUpdate,
    now: string,
  ): Promise<WorkflowRow | null>;
  /**
   * Enabled workflows with a `schedule` trigger on `scheduleId`, once per
   * matching trigger. Ordered by insertion order, then trigger position.
   */
  listEnabledByScheduleId(scheduleId: string): Promise<WorkflowRow[]>;
  /** Distinct definition hashes of the workflow's runs, ordered by hash. */
  listRunDefinitionHashesOfWorkflow(workflowId: string): Promise<string[]>;
  /** Deletes the steps of every run of the workflow. */
  deleteStepsOfWorkflow(workflowId: string): Promise<void>;
  deleteRunsOfWorkflow(workflowId: string): Promise<void>;
  /** Number of rows deleted. */
  deleteWorkflow(id: string): Promise<number>;

  // --- run rows ----------------------------------------------------------

  insertRun(run: NewWorkflowRun): Promise<WorkflowRunRow | null>;
  findRunById(id: string): Promise<WorkflowRunRow | null>;
  /** Sets the given columns plus `lastUpdatedAt`. Needs at least one column. */
  updateRunColumns(
    id: string,
    update: WorkflowRunColumnUpdate,
    now: string,
  ): Promise<WorkflowRunRow | null>;
  /**
   * Runs of the workflow, newest `startedAt` first, then id descending.
   * `includeContext` false returns summary rows.
   */
  listRuns(
    workflowId: string,
    opts: { status?: string; limit?: number; offset?: number; includeContext: boolean },
  ): Promise<WorkflowRunRow[]>;
  countRuns(workflowId: string, status?: string): Promise<number>;
  /** Latest completed run by `finishedAt`. */
  lastSuccessfulRun(workflowId: string): Promise<WorkflowRunRow | null>;
  /** Latest run that was not skipped, by `startedAt`. */
  lastRunStart(workflowId: string): Promise<WorkflowRunRow | null>;
  /**
   * Waiting steps of waiting runs whose task ended. Ordered by the task's
   * `createdAt`, then the task's insertion order.
   */
  listStuckRuns(): Promise<StuckWorkflowRunRow[]>;

  // --- step rows ---------------------------------------------------------

  insertRunningStep(step: NewRunningWorkflowStep): Promise<WorkflowRunStepRow | null>;
  findStepById(id: string): Promise<WorkflowRunStepRow | null>;
  findStepByIdempotencyKey(key: string): Promise<WorkflowRunStepRow | null>;
  /** Sets the given columns. Needs at least one column. */
  updateStepColumns(
    id: string,
    update: WorkflowRunStepColumnUpdate,
  ): Promise<WorkflowRunStepRow | null>;
  /** Full step rows of the run, ordered by `startedAt`, then insertion order. */
  listSteps(runId: string): Promise<WorkflowRunStepRow[]>;
  /**
   * Failed steps with a retry due at `now` in running, waiting or failed runs.
   * Ordered by `nextRetryAt`, then insertion order.
   */
  listDueRetrySteps(now: string): Promise<WorkflowRunStepRow[]>;
  /** Node ids of the run's completed steps, in insertion order. */
  listCompletedStepNodeIds(runId: string): Promise<string[]>;
  /** The node's latest step by `startedAt`, then insertion order. */
  latestStepForNode(runId: string, nodeId: string): Promise<WorkflowRunStepRow | null>;
  /** The node's most recently inserted step. */
  lastInsertedStepForNode(runId: string, nodeId: string): Promise<WorkflowRunStepRow | null>;
  /** True when one of `nodeIds` has a completed step inserted after step `afterStepId`. */
  hasCompletedStepInsertedAfter(
    runId: string,
    nodeIds: readonly string[],
    afterStepId: string,
  ): Promise<boolean>;

  // --- versions ----------------------------------------------------------

  insertVersion(version: {
    id: string;
    workflowId: string;
    version: number;
    snapshot: string;
    changedByAgentId: string | null;
  }): Promise<WorkflowVersionRow | null>;
  /** Newest version first. */
  listVersions(workflowId: string): Promise<WorkflowVersionRow[]>;
  getVersion(workflowId: string, version: number): Promise<WorkflowVersionRow | null>;
  // --- approval requests -------------------------------------------------

  insertApproval(approval: NewApprovalRequest): Promise<ApprovalRequestRow | null>;
  findApprovalById(id: string): Promise<ApprovalRequestRow | null>;
  /** The step's first request by insertion order. */
  findApprovalByStepId(stepId: string): Promise<ApprovalRequestRow | null>;
  /**
   * Settles a pending request. `requireActionableWorkflow` also requires a
   * linked run to be running or waiting with the step still waiting.
   */
  resolveApproval(
    id: string,
    resolution: ApprovalResolution,
    requireActionableWorkflow: boolean,
  ): Promise<ApprovalRequestRow | null>;
  /** Cancels one pending request. */
  cancelApproval(
    id: string,
    reason: string,
    resolvedBy: string | null,
    now: string,
  ): Promise<ApprovalRequestRow | null>;
  /** Cancels the run's pending requests, returned in the engine's update order. */
  cancelPendingApprovalsOfRun(
    runId: string,
    reason: string,
    now: string,
  ): Promise<ApprovalRequestRow[]>;
  /** Cancelled requests of the run, in insertion order. */
  listCancelledApprovalsOfRun(runId: string): Promise<ApprovalRequestRow[]>;
  /** Cancelled requests of the step, in insertion order. */
  listCancelledApprovalsOfStep(stepId: string): Promise<ApprovalRequestRow[]>;
  /** The request when it is settled: cancelled, or any terminal status with `anyTerminal`. */
  findSettledApproval(id: string, anyTerminal: boolean): Promise<ApprovalRequestRow | null>;
  /** Writes the notification claims while the request is settled (as in `findSettledApproval`). */
  setApprovalNotificationClaims(
    id: string,
    claims: string,
    now: string,
    anyTerminal: boolean,
  ): Promise<void>;
  /** The stored notification claims, or null when the request is missing. */
  getApprovalNotificationClaims(id: string): Promise<{ claims: string | null } | null>;
  setApprovalNotificationChannels(id: string, channels: string, now: string): Promise<void>;
  /** Newest `createdAt` first, ties in insertion order. */
  listApprovals(filter: ApprovalListFilter): Promise<ApprovalRequestRow[]>;
  /** `listApprovals` projected to summary rows, same order. */
  listApprovalSummaries(filter: ApprovalListFilter): Promise<ApprovalRequestSummaryRow[]>;
  /**
   * Waiting steps of waiting runs whose request is answered, timed out, or
   * past its deadline. Ordered by step insertion order, then request insertion order.
   */
  listStuckApprovalRuns(): Promise<StuckApprovalRunRow[]>;
  /**
   * Pending requests: how many, the oldest `createdAt` (null when none), and how
   * many are past `expiresAt` at `now` (the timeout sweep should keep that at 0).
   */
  pendingApprovalStats(
    now: string,
  ): Promise<{ pending: number; oldestCreatedAt: string | null; overdue: number }>;
  /** Pending requests past `expiresAt`, earliest deadline first, ties in insertion order. */
  listExpiredPendingApprovals(now: string): Promise<ApprovalRequestRow[]>;
  /** Pending requests without a deadline created before `cutoff`, oldest first, ties in insertion order. */
  listStalePendingApprovals(cutoff: string): Promise<ApprovalRequestRow[]>;
  /** Approvers and votes of the given pending requests, ordered by id. */
  listPendingApprovalVotes(
    ids: readonly string[],
  ): Promise<{ id: string; approvers: string; approvals: string | null }[]>;
  /** Stores the votes of a pending request. True when it was pending. */
  recordApprovalVotes(id: string, approvals: string, now: string): Promise<boolean>;
  /** Pending requests of the given source tasks, ordered by `createdAt`, then id. */
  listPendingApprovalsForTasks(
    taskIds: readonly string[],
  ): Promise<{ id: string; status: "pending"; sourceTaskId: string; title: string }[]>;
  /** Cancelled requests of the runs that have notification channels, in insertion order. */
  listCancelledNotifiedApprovals(
    runIds: readonly string[],
  ): Promise<{ id: string; notificationChannels: string; claims: string | null }[]>;

  // --- wait states -------------------------------------------------------

  insertWaitState(wait: NewWaitState): Promise<WaitStateRow | null>;
  findWaitStateById(id: string): Promise<WaitStateRow | null>;
  /** The step's first wait by insertion order. */
  findWaitStateByStepId(stepId: string): Promise<WaitStateRow | null>;
  /**
   * Pending time waits past `wakeUpAt` and event waits past `expiresAt`.
   * Ordered by `expiresAt` (NULL first on SQLite), then insertion order.
   */
  listDueWaitStates(): Promise<WaitStateRow[]>;
  /** Distinct event names of pending waits, ordered by name. */
  listPendingEventWaitNames(): Promise<string[]>;
  /** Pending event waits on `eventName` (of `runId` when given), in insertion order. */
  listPendingWaitsByEvent(eventName: string, runId?: string): Promise<WaitStateRow[]>;
  /** pending → `status`. Null when the wait was not pending. */
  resolveWaitState(
    id: string,
    status: string,
    firedPayload: string | null,
    now: string,
  ): Promise<WaitStateRow | null>;
  /**
   * Waiting `wait` steps of waiting runs whose wait fired, timed out or is
   * overdue. Ordered by step insertion order, then wait insertion order.
   */
  listStuckWaitRuns(): Promise<StuckWaitRunRow[]>;
  /** Id of the workflow named `name` (unique), or null. */
  findWorkflowIdByName(name: string): Promise<string | null>;
  /** Setup metadata of the enabled workflows (see `AutomationPreflightRowText`). Insertion order. */
  listEnabledPreflightRows(): Promise<AutomationPreflightRowText[]>;
  /**
   * True when a failed run of the workflow other than `runId` with a
   * `needs_setup:` error started in `[start, end)`.
   */
  hasOtherSetupFailureRun(
    workflowId: string,
    runId: string,
    start: string,
    end: string,
  ): Promise<boolean>;
  /** The earliest top-level failed `needs_setup:` run started in `[start, end)`, or null. */
  findFirstTopLevelSetupFailureRunId(
    workflowId: string,
    start: string,
    end: string,
  ): Promise<string | null>;
  /** Inserts a top-level run that is already `failed` and finished at `now`. */
  insertFailedRun(run: {
    id: string;
    workflowId: string;
    triggerType: string;
    triggerData: string | null;
    error: string;
    createdBy: string | null;
    now: string;
  }): Promise<void>;
  /** Completed runs across every workflow. */
  countCompletedRunsAll(): Promise<number>;

  // ---- approval_requests: Slack threads waiting on a person ----
  /** Distinct Slack threads with an unexpired pending request raised by one of their tasks. In no particular order. */
  listSlackThreadsAwaitingHuman(): Promise<{ channelId: string; threadTs: string }[]>;
  isSlackThreadAwaitingHuman(channelId: string, threadTs: string): Promise<boolean>;
  /** Workflow count and enabled count. */
  countWorkflows(): Promise<{ total: number; enabled: number | null } | null>;
  /** Replaces a run's sealed replay context. */
  setRunContextReplay(runId: string, contextReplay: string): Promise<void>;
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
  /** The engine's insertion-order tie-break for `alias` (or the only table). */
  protected abstract insertionOrder(alias?: SqlQuery): SqlQuery;

  /** `OFFSET` with no row limit. */
  protected abstract offsetWithoutLimit(offset: number): SqlQuery;

  insertWorkflow(w: NewWorkflow): Promise<WorkflowRow | null> {
    return this.db.get<WorkflowRow>(sql`
      INSERT INTO workflows (id, "key", name, description, definition, triggers, cooldown, input,
        "triggerSchema", params, "requiredParams", requires, dir, vcs_repo, "createdByAgentId",
        "updatedByAgentId", created_by, updated_by, enabled)
      VALUES (${w.id}, ${w.key}, ${w.name}, ${w.description}, ${w.definition}, ${jsonText(w.triggers)},
        ${w.cooldown}, ${w.input}, ${jsonText(w.triggerSchema)}, ${jsonText(w.params)},
        ${jsonText(w.requiredParams)}, ${jsonText(w.requires)},
        ${w.dir}, ${w.vcsRepo}, ${w.createdByAgentId}, ${w.createdByAgentId}, ${w.createdBy},
        ${w.createdBy}, ${w.enabled})
      RETURNING *`);
  }

  findWorkflowById(id: string): Promise<WorkflowRow | null> {
    return this.db.get<WorkflowRow>(sql`SELECT * FROM workflows WHERE id = ${id}`);
  }

  listWorkflows(f: WorkflowListFilter): Promise<WorkflowRow[]> {
    const conditions: SqlQuery[] = [];
    if (f.enabled !== undefined) conditions.push(sql`enabled = ${f.enabled}`);
    if (f.key !== undefined) conditions.push(sql`"key" = ${f.key}`);
    else if (f.keyPattern !== undefined) {
      conditions.push(sql`${likeAsciiCi(sql`"key"`, sql`${f.keyPattern}`, "\\")}`);
    }
    if (f.lastRunStatus !== undefined) {
      conditions.push(sql`(SELECT status FROM workflow_runs WHERE "workflowId" = workflows.id
        ORDER BY "startedAt" DESC LIMIT 1) = ${f.lastRunStatus}`);
    }
    if (f.consecutiveErrorsMin !== undefined) {
      conditions.push(sql`(
        SELECT COUNT(*)
        FROM workflow_runs wr
        WHERE wr."workflowId" = workflows.id
          AND wr.status = 'failed'
          AND NOT EXISTS (
            SELECT 1
            FROM workflow_runs newer_non_failed
            WHERE newer_non_failed."workflowId" = wr."workflowId"
              AND newer_non_failed.status != 'failed'
              AND newer_non_failed."startedAt" > wr."startedAt"
          )
      ) >= ${f.consecutiveErrorsMin}`);
    }
    if (f.textPattern !== undefined) {
      const p = sql`${f.textPattern}`;
      conditions.push(
        sql`(${likeAsciiCi(sql`name`, p, "\\")} OR ${likeAsciiCi(sql`description`, p, "\\")} OR ${likeAsciiCi(sql`"key"`, p, "\\")})`,
      );
    }
    const limit = f.limit === undefined ? EMPTY : sql` LIMIT ${f.limit}`;
    return this.db.query<WorkflowRow>(sql`
      SELECT * FROM workflows${sqlWhere(conditions)}
      ORDER BY "lastUpdatedAt" DESC, ${this.insertionOrder()}${limit}`);
  }

  updateWorkflowColumns(
    id: string,
    u: WorkflowColumnUpdate,
    now: string,
  ): Promise<WorkflowRow | null> {
    const sets: SqlQuery[] = [];
    if (u.key !== undefined) sets.push(sql`"key" = ${u.key}`);
    if (u.name !== undefined) sets.push(sql`name = ${u.name}`);
    if (u.description !== undefined) sets.push(sql`description = ${u.description}`);
    if (u.enabled !== undefined) sets.push(sql`enabled = ${u.enabled}`);
    if (u.definition !== undefined) sets.push(sql`definition = ${u.definition}`);
    if (u.triggers !== undefined) sets.push(sql`triggers = ${jsonText(u.triggers)}`);
    if (u.cooldown !== undefined) sets.push(sql`cooldown = ${u.cooldown}`);
    if (u.input !== undefined) sets.push(sql`input = ${u.input}`);
    if (u.triggerSchema !== undefined)
      sets.push(sql`"triggerSchema" = ${jsonText(u.triggerSchema)}`);
    if (u.params !== undefined) sets.push(sql`params = ${jsonText(u.params)}`);
    if (u.requiredParams !== undefined)
      sets.push(sql`"requiredParams" = ${jsonText(u.requiredParams)}`);
    if (u.requires !== undefined) sets.push(sql`requires = ${jsonText(u.requires)}`);
    if (u.dir !== undefined) sets.push(sql`dir = ${u.dir}`);
    if (u.vcsRepo !== undefined) sets.push(sql`vcs_repo = ${u.vcsRepo}`);
    if (u.updatedBy !== undefined) sets.push(sql`updated_by = ${u.updatedBy}`);
    if (u.updatedByAgentId !== undefined)
      sets.push(sql`"updatedByAgentId" = ${u.updatedByAgentId}`);
    sets.push(sql`"lastUpdatedAt" = ${now}`);
    return this.db.get<WorkflowRow>(
      sql`UPDATE workflows SET ${sqlJoin(sets, sql`, `)} WHERE id = ${id} RETURNING *`,
    );
  }

  abstract listEnabledByScheduleId(scheduleId: string): Promise<WorkflowRow[]>;

  async listRunDefinitionHashesOfWorkflow(workflowId: string): Promise<string[]> {
    const rows = await this.db.query<{ definitionHash: string }>(sql`
      SELECT DISTINCT "definitionHash" FROM workflow_runs
       WHERE "workflowId" = ${workflowId} AND "definitionHash" IS NOT NULL
       ORDER BY "definitionHash"`);
    return rows.map((row) => row.definitionHash);
  }

  async deleteStepsOfWorkflow(workflowId: string): Promise<void> {
    await this.db.run(sql`
      DELETE FROM workflow_run_steps
       WHERE "runId" IN (SELECT id FROM workflow_runs WHERE "workflowId" = ${workflowId})`);
  }

  async deleteRunsOfWorkflow(workflowId: string): Promise<void> {
    await this.db.run(sql`DELETE FROM workflow_runs WHERE "workflowId" = ${workflowId}`);
  }

  async deleteWorkflow(id: string): Promise<number> {
    const result = await this.db.run(sql`DELETE FROM workflows WHERE id = ${id}`);
    return result.changes;
  }

  insertRun(r: NewWorkflowRun): Promise<WorkflowRunRow | null> {
    return this.db.get<WorkflowRunRow>(sql`
      INSERT INTO workflow_runs (id, "workflowId", "triggerType", "startedAt", "triggerData",
        created_by, "parentStepId", "parentStepAttempt", "triggeredByAgentId", "definitionHash",
        "sourceStepId", principal)
      VALUES (${r.id}, ${r.workflowId}, ${r.triggerType}, ${r.startedAt}, ${jsonText(r.triggerData)},
        ${r.createdBy}, ${r.parentStepId}, ${r.parentStepAttempt}, ${r.triggeredByAgentId},
        ${r.definitionHash}, ${r.sourceStepId}, ${r.principal})
      RETURNING *`);
  }

  findRunById(id: string): Promise<WorkflowRunRow | null> {
    return this.db.get<WorkflowRunRow>(sql`SELECT * FROM workflow_runs WHERE id = ${id}`);
  }

  updateRunColumns(
    id: string,
    u: WorkflowRunColumnUpdate,
    now: string,
  ): Promise<WorkflowRunRow | null> {
    const sets: SqlQuery[] = [];
    if (u.status !== undefined) sets.push(sql`status = ${u.status}`);
    if (u.context !== undefined) sets.push(sql`context = ${jsonText(u.context)}`);
    if (u.context_replay !== undefined) sets.push(sql`context_replay = ${u.context_replay}`);
    if (u.error !== undefined) sets.push(sql`error = ${u.error}`);
    if (u.finishedAt !== undefined) sets.push(sql`"finishedAt" = ${u.finishedAt}`);
    sets.push(sql`"lastUpdatedAt" = ${now}`);
    return this.db.get<WorkflowRunRow>(
      sql`UPDATE workflow_runs SET ${sqlJoin(sets, sql`, `)} WHERE id = ${id} RETURNING *`,
    );
  }

  listRuns(
    workflowId: string,
    opts: { status?: string; limit?: number; offset?: number; includeContext: boolean },
  ): Promise<WorkflowRunRow[]> {
    const columns = opts.includeContext ? sql`*` : RUN_SUMMARY_COLUMNS;
    const status = opts.status ? sql` AND status = ${opts.status}` : EMPTY;
    const page =
      opts.limit !== undefined
        ? sql` LIMIT ${opts.limit} OFFSET ${opts.offset ?? 0}`
        : opts.offset !== undefined
          ? sql` ${this.offsetWithoutLimit(opts.offset)}`
          : EMPTY;
    return this.db.query<WorkflowRunRow>(sql`
      SELECT ${columns} FROM workflow_runs
       WHERE "workflowId" = ${workflowId}${status}
       ORDER BY "startedAt" DESC, id DESC${page}`);
  }

  async countRuns(workflowId: string, status?: string): Promise<number> {
    const filter = status ? sql` AND status = ${status}` : EMPTY;
    const row = await this.db.get<{ count: number | string }>(sql`
      SELECT COUNT(*) AS count FROM workflow_runs WHERE "workflowId" = ${workflowId}${filter}`);
    return Number(row?.count ?? 0);
  }

  lastSuccessfulRun(workflowId: string): Promise<WorkflowRunRow | null> {
    return this.db.get<WorkflowRunRow>(sql`
      SELECT * FROM workflow_runs
       WHERE "workflowId" = ${workflowId} AND status = 'completed'
       ORDER BY "finishedAt" DESC NULLS LAST LIMIT 1`);
  }

  lastRunStart(workflowId: string): Promise<WorkflowRunRow | null> {
    return this.db.get<WorkflowRunRow>(sql`
      SELECT * FROM workflow_runs
       WHERE "workflowId" = ${workflowId} AND status NOT IN ('skipped')
       ORDER BY "startedAt" DESC LIMIT 1`);
  }

  abstract listStuckRuns(): Promise<StuckWorkflowRunRow[]>;

  insertRunningStep(s: NewRunningWorkflowStep): Promise<WorkflowRunStepRow | null> {
    return this.db.get<WorkflowRunStepRow>(sql`
      INSERT INTO workflow_run_steps (id, "runId", "nodeId", "nodeType", status, "startedAt", input, "idempotencyKey")
      VALUES (${s.id}, ${s.runId}, ${s.nodeId}, ${s.nodeType}, 'running', ${s.startedAt}, ${s.input}, ${s.idempotencyKey})
      RETURNING *`);
  }

  findStepById(id: string): Promise<WorkflowRunStepRow | null> {
    return this.db.get<WorkflowRunStepRow>(sql`SELECT * FROM workflow_run_steps WHERE id = ${id}`);
  }

  findStepByIdempotencyKey(key: string): Promise<WorkflowRunStepRow | null> {
    return this.db.get<WorkflowRunStepRow>(
      sql`SELECT * FROM workflow_run_steps WHERE "idempotencyKey" = ${key}`,
    );
  }

  updateStepColumns(
    id: string,
    u: WorkflowRunStepColumnUpdate,
  ): Promise<WorkflowRunStepRow | null> {
    const sets: SqlQuery[] = [];
    if (u.status !== undefined) sets.push(sql`status = ${u.status}`);
    if (u.output !== undefined) sets.push(sql`output = ${u.output}`);
    if (u.output_replay !== undefined) sets.push(sql`output_replay = ${u.output_replay}`);
    if (u.error !== undefined) sets.push(sql`error = ${u.error}`);
    if (u.finishedAt !== undefined) sets.push(sql`"finishedAt" = ${u.finishedAt}`);
    if (u.retryCount !== undefined) sets.push(sql`"retryCount" = ${u.retryCount}`);
    if (u.maxRetries !== undefined) sets.push(sql`"maxRetries" = ${u.maxRetries}`);
    if (u.nextRetryAt !== undefined) sets.push(sql`"nextRetryAt" = ${u.nextRetryAt}`);
    if (u.idempotencyKey !== undefined) sets.push(sql`"idempotencyKey" = ${u.idempotencyKey}`);
    if (u.diagnostics !== undefined) sets.push(sql`diagnostics = ${u.diagnostics}`);
    if (u.nextPort !== undefined) sets.push(sql`"nextPort" = ${u.nextPort}`);
    if (sets.length === 0) throw new Error("updateStepColumns needs at least one column");
    return this.db.get<WorkflowRunStepRow>(
      sql`UPDATE workflow_run_steps SET ${sqlJoin(sets, sql`, `)} WHERE id = ${id} RETURNING *`,
    );
  }

  listSteps(runId: string): Promise<WorkflowRunStepRow[]> {
    return this.db.query<WorkflowRunStepRow>(sql`
      SELECT * FROM workflow_run_steps WHERE "runId" = ${runId}
       ORDER BY "startedAt" ASC, ${this.insertionOrder()} ASC`);
  }

  listDueRetrySteps(now: string): Promise<WorkflowRunStepRow[]> {
    return this.db.query<WorkflowRunStepRow>(sql`
      SELECT s.* FROM workflow_run_steps s
        JOIN workflow_runs r ON r.id = s."runId"
       WHERE s.status = 'failed'
         AND s."nextRetryAt" IS NOT NULL
         AND s."nextRetryAt" <= ${now}
         AND r.status IN ('running', 'waiting', 'failed')
       ORDER BY s."nextRetryAt" ASC, ${this.insertionOrder(sql`s`)} ASC`);
  }

  async listCompletedStepNodeIds(runId: string): Promise<string[]> {
    const rows = await this.db.query<{ nodeId: string }>(sql`
      SELECT "nodeId" FROM workflow_run_steps
       WHERE "runId" = ${runId} AND status = 'completed'
       ORDER BY ${this.insertionOrder()}`);
    return rows.map((row) => row.nodeId);
  }

  latestStepForNode(runId: string, nodeId: string): Promise<WorkflowRunStepRow | null> {
    return this.db.get<WorkflowRunStepRow>(sql`
      SELECT * FROM workflow_run_steps WHERE "runId" = ${runId} AND "nodeId" = ${nodeId}
       ORDER BY "startedAt" DESC, ${this.insertionOrder()} DESC LIMIT 1`);
  }

  lastInsertedStepForNode(runId: string, nodeId: string): Promise<WorkflowRunStepRow | null> {
    return this.db.get<WorkflowRunStepRow>(sql`
      SELECT * FROM workflow_run_steps WHERE "runId" = ${runId} AND "nodeId" = ${nodeId}
       ORDER BY ${this.insertionOrder()} DESC LIMIT 1`);
  }

  abstract hasCompletedStepInsertedAfter(
    runId: string,
    nodeIds: readonly string[],
    afterStepId: string,
  ): Promise<boolean>;

  insertVersion(v: {
    id: string;
    workflowId: string;
    version: number;
    snapshot: string;
    changedByAgentId: string | null;
  }): Promise<WorkflowVersionRow | null> {
    return this.db.get<WorkflowVersionRow>(sql`
      INSERT INTO workflow_versions (id, "workflowId", version, snapshot, "changedByAgentId")
      VALUES (${v.id}, ${v.workflowId}, ${v.version}, ${jsonText(v.snapshot)}, ${v.changedByAgentId})
      RETURNING *`);
  }

  listVersions(workflowId: string): Promise<WorkflowVersionRow[]> {
    return this.db.query<WorkflowVersionRow>(sql`
      SELECT * FROM workflow_versions WHERE "workflowId" = ${workflowId} ORDER BY version DESC`);
  }

  getVersion(workflowId: string, version: number): Promise<WorkflowVersionRow | null> {
    return this.db.get<WorkflowVersionRow>(sql`
      SELECT * FROM workflow_versions WHERE "workflowId" = ${workflowId} AND version = ${version}`);
  }
  insertApproval(a: NewApprovalRequest): Promise<ApprovalRequestRow | null> {
    return this.db.get<ApprovalRequestRow>(sql`
      INSERT INTO approval_requests
        (id, title, questions, "workflowRunId", "workflowRunStepId", "sourceTaskId",
         approvers, status, "resolutionReason", "resolvedAt", "timeoutSeconds", "expiresAt",
         "notificationChannels", created_by, "createdAt", "updatedAt")
      VALUES (${a.id}, ${a.title}, ${jsonText(a.questions)}, ${a.workflowRunId}, ${a.workflowRunStepId},
        ${a.sourceTaskId}, ${jsonText(a.approvers)}, ${a.status}, ${a.resolutionReason}, ${a.resolvedAt},
        ${a.timeoutSeconds}, ${a.expiresAt}, ${jsonText(a.notificationChannels)}, ${a.createdBy}, ${a.now},
        ${a.now})
      RETURNING *`);
  }

  findApprovalById(id: string): Promise<ApprovalRequestRow | null> {
    return this.db.get<ApprovalRequestRow>(sql`SELECT * FROM approval_requests WHERE id = ${id}`);
  }

  findApprovalByStepId(stepId: string): Promise<ApprovalRequestRow | null> {
    return this.db.get<ApprovalRequestRow>(sql`
      SELECT * FROM approval_requests WHERE "workflowRunStepId" = ${stepId}
       ORDER BY ${this.insertionOrder()} LIMIT 1`);
  }

  resolveApproval(
    id: string,
    r: ApprovalResolution,
    requireActionableWorkflow: boolean,
  ): Promise<ApprovalRequestRow | null> {
    const actionable = requireActionableWorkflow
      ? sql` AND (
          "workflowRunId" IS NULL
          OR (
            EXISTS (
              SELECT 1 FROM workflow_runs
              WHERE id = approval_requests."workflowRunId"
                AND status IN ('running', 'waiting')
            )
            AND EXISTS (
              SELECT 1 FROM workflow_run_steps
              WHERE id = approval_requests."workflowRunStepId"
                AND "runId" = approval_requests."workflowRunId"
                AND status = 'waiting'
            )
          )
        )`
      : EMPTY;
    return this.db.get<ApprovalRequestRow>(sql`
      UPDATE approval_requests
         SET status = ${r.status}, responses = ${r.responses},
             approvals = COALESCE(${r.approvals}, approvals), "resolvedBy" = ${r.resolvedBy},
             "resolutionReason" = ${r.resolutionReason}, "resolvedAt" = ${r.now}, "updatedAt" = ${r.now}
       WHERE id = ${id} AND status = 'pending'${actionable}
       RETURNING *`);
  }

  cancelApproval(
    id: string,
    reason: string,
    resolvedBy: string | null,
    now: string,
  ): Promise<ApprovalRequestRow | null> {
    return this.db.get<ApprovalRequestRow>(sql`
      UPDATE approval_requests
         SET status = 'cancelled', "resolutionReason" = ${reason}, "resolvedBy" = ${resolvedBy},
             "resolvedAt" = ${now}, "updatedAt" = ${now}
       WHERE id = ${id} AND status = 'pending'
       RETURNING *`);
  }

  cancelPendingApprovalsOfRun(
    runId: string,
    reason: string,
    now: string,
  ): Promise<ApprovalRequestRow[]> {
    return this.db.query<ApprovalRequestRow>(sql`
      UPDATE approval_requests
         SET status = 'cancelled', "resolutionReason" = ${reason}, "resolvedAt" = ${now}, "updatedAt" = ${now}
       WHERE "workflowRunId" = ${runId} AND status = 'pending'
       RETURNING *`);
  }

  listCancelledApprovalsOfRun(runId: string): Promise<ApprovalRequestRow[]> {
    return this.db.query<ApprovalRequestRow>(sql`
      SELECT * FROM approval_requests
       WHERE "workflowRunId" = ${runId} AND status = 'cancelled'
       ORDER BY ${this.insertionOrder()}`);
  }

  listCancelledApprovalsOfStep(stepId: string): Promise<ApprovalRequestRow[]> {
    return this.db.query<ApprovalRequestRow>(sql`
      SELECT * FROM approval_requests
       WHERE "workflowRunStepId" = ${stepId} AND status = 'cancelled'
       ORDER BY ${this.insertionOrder()}`);
  }

  private settledClause(anyTerminal: boolean): SqlQuery {
    return anyTerminal ? sql`status <> 'pending'` : sql`status = 'cancelled'`;
  }

  findSettledApproval(id: string, anyTerminal: boolean): Promise<ApprovalRequestRow | null> {
    return this.db.get<ApprovalRequestRow>(sql`
      SELECT * FROM approval_requests WHERE id = ${id} AND ${this.settledClause(anyTerminal)}`);
  }

  async setApprovalNotificationClaims(
    id: string,
    claims: string,
    now: string,
    anyTerminal: boolean,
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE approval_requests
         SET "cancellationNotificationClaims" = ${jsonText(claims)}, "updatedAt" = ${now}
       WHERE id = ${id} AND ${this.settledClause(anyTerminal)}`);
  }

  getApprovalNotificationClaims(id: string): Promise<{ claims: string | null } | null> {
    return this.db.get<{ claims: string | null }>(sql`
      SELECT "cancellationNotificationClaims" AS claims FROM approval_requests WHERE id = ${id}`);
  }

  async setApprovalNotificationChannels(id: string, channels: string, now: string): Promise<void> {
    await this.db.run(sql`
      UPDATE approval_requests SET "notificationChannels" = ${jsonText(channels)}, "updatedAt" = ${now}
       WHERE id = ${id}`);
  }

  protected approvalListTail(f: ApprovalListFilter): SqlQuery {
    const conditions: SqlQuery[] = [];
    if (f.status) conditions.push(sql`status = ${f.status}`);
    if (f.workflowRunId) conditions.push(sql`"workflowRunId" = ${f.workflowRunId}`);
    return sql`${sqlWhere(conditions)} ORDER BY "createdAt" DESC NULLS LAST, ${this.insertionOrder()} ASC LIMIT ${f.limit}`;
  }

  listApprovals(f: ApprovalListFilter): Promise<ApprovalRequestRow[]> {
    return this.db.query<ApprovalRequestRow>(
      sql`SELECT * FROM approval_requests${this.approvalListTail(f)}`,
    );
  }

  abstract listApprovalSummaries(filter: ApprovalListFilter): Promise<ApprovalRequestSummaryRow[]>;

  listStuckApprovalRuns(): Promise<StuckApprovalRunRow[]> {
    return this.db.query<StuckApprovalRunRow>(sql`
      SELECT
          wr.id as "runId",
          wrs.id as "stepId",
          wrs."nodeId",
          wr."workflowId",
          ar.id as "approvalId",
          ar.status as "approvalStatus",
          ar.responses as "approvalResponses",
          ar."expiresAt"
        FROM workflow_runs wr
        JOIN workflow_run_steps wrs ON wrs."runId" = wr.id AND wrs.status = 'waiting'
        JOIN approval_requests ar ON ar."workflowRunStepId" = wrs.id
       WHERE wr.status = 'waiting'
         AND (ar.status IN ('approved', 'rejected', 'timeout')
              OR (ar.status = 'pending' AND ar."expiresAt" IS NOT NULL AND ar."expiresAt" < ${nowIso}))
       ORDER BY ${this.insertionOrder(sql`wrs`)}, ${this.insertionOrder(sql`ar`)}`);
  }

  async pendingApprovalStats(
    now: string,
  ): Promise<{ pending: number; oldestCreatedAt: string | null; overdue: number }> {
    const row = await this.db.get<{
      pending: number;
      oldestCreatedAt: string | null;
      overdue: number | null;
    }>(sql`
      SELECT count(*) AS pending, MIN("createdAt") AS "oldestCreatedAt",
             SUM(CASE WHEN "expiresAt" IS NOT NULL AND "expiresAt" < ${now} THEN 1 ELSE 0 END) AS overdue
        FROM approval_requests WHERE status = 'pending'`);
    return {
      pending: Number(row?.pending ?? 0),
      oldestCreatedAt: row?.oldestCreatedAt ?? null,
      overdue: Number(row?.overdue ?? 0),
    };
  }

  listExpiredPendingApprovals(now: string): Promise<ApprovalRequestRow[]> {
    return this.db.query<ApprovalRequestRow>(sql`
      SELECT * FROM approval_requests
       WHERE status = 'pending' AND "expiresAt" IS NOT NULL AND "expiresAt" < ${now}
       ORDER BY "expiresAt" ASC, ${this.insertionOrder()} ASC`);
  }

  listStalePendingApprovals(cutoff: string): Promise<ApprovalRequestRow[]> {
    return this.db.query<ApprovalRequestRow>(sql`
      SELECT * FROM approval_requests
       WHERE status = 'pending' AND "expiresAt" IS NULL AND "createdAt" < ${cutoff}
       ORDER BY "createdAt" ASC, ${this.insertionOrder()} ASC`);
  }

  listPendingApprovalVotes(
    ids: readonly string[],
  ): Promise<{ id: string; approvers: string; approvals: string | null }[]> {
    return this.db.query<{ id: string; approvers: string; approvals: string | null }>(sql`
      SELECT id, approvers, approvals FROM approval_requests
       WHERE status = 'pending' AND id IN (${sqlList(ids)})
       ORDER BY id`);
  }

  async recordApprovalVotes(id: string, approvals: string, now: string): Promise<boolean> {
    const row = await this.db.get<{ id: string }>(sql`
      UPDATE approval_requests SET approvals = ${approvals}, "updatedAt" = ${now}
       WHERE id = ${id} AND status = 'pending'
       RETURNING id`);
    return row != null;
  }

  listPendingApprovalsForTasks(
    taskIds: readonly string[],
  ): Promise<{ id: string; status: "pending"; sourceTaskId: string; title: string }[]> {
    return this.db.query<{
      id: string;
      status: "pending";
      sourceTaskId: string;
      title: string;
    }>(sql`
      SELECT id, status, "sourceTaskId", title FROM approval_requests
       WHERE "sourceTaskId" IN (${sqlList(taskIds)}) AND status = 'pending'
       ORDER BY "createdAt", id`);
  }

  listCancelledNotifiedApprovals(
    runIds: readonly string[],
  ): Promise<{ id: string; notificationChannels: string; claims: string | null }[]> {
    return this.db.query<{ id: string; notificationChannels: string; claims: string | null }>(sql`
      SELECT id, "notificationChannels", "cancellationNotificationClaims" AS claims
        FROM approval_requests
       WHERE "workflowRunId" IN (${sqlList(runIds)})
         AND status = 'cancelled' AND "notificationChannels" IS NOT NULL
       ORDER BY ${this.insertionOrder()}`);
  }

  insertWaitState(w: NewWaitState): Promise<WaitStateRow | null> {
    return this.db.get<WaitStateRow>(sql`
      INSERT INTO wait_states
        (id, "workflowRunId", "workflowRunStepId", mode, "wakeUpAt", "eventName", "eventFilter",
         "expiresAt", "eventScope", "createdAt", "updatedAt")
      VALUES (${w.id}, ${w.workflowRunId}, ${w.workflowRunStepId}, ${w.mode}, ${w.wakeUpAt},
        ${w.eventName}, ${jsonText(w.eventFilter)}, ${w.expiresAt}, ${w.eventScope}, ${w.now}, ${w.now})
      RETURNING *`);
  }

  findWaitStateById(id: string): Promise<WaitStateRow | null> {
    return this.db.get<WaitStateRow>(sql`SELECT * FROM wait_states WHERE id = ${id}`);
  }

  findWaitStateByStepId(stepId: string): Promise<WaitStateRow | null> {
    return this.db.get<WaitStateRow>(sql`
      SELECT * FROM wait_states WHERE "workflowRunStepId" = ${stepId}
       ORDER BY ${this.insertionOrder()} LIMIT 1`);
  }

  listDueWaitStates(): Promise<WaitStateRow[]> {
    return this.db.query<WaitStateRow>(sql`
      SELECT * FROM wait_states
       WHERE status = 'pending'
         AND (
           (mode = 'time' AND "wakeUpAt" IS NOT NULL AND "wakeUpAt" <= ${nowIso})
           OR
           (mode = 'event' AND "expiresAt" IS NOT NULL AND "expiresAt" <= ${nowIso})
         )
       ORDER BY "expiresAt" NULLS FIRST, ${this.insertionOrder()}`);
  }

  async listPendingEventWaitNames(): Promise<string[]> {
    const rows = await this.db.query<{ eventName: string }>(sql`
      SELECT DISTINCT "eventName" FROM wait_states
       WHERE status = 'pending' AND "eventName" IS NOT NULL
       ORDER BY "eventName"`);
    return rows.map((row) => row.eventName);
  }

  listPendingWaitsByEvent(eventName: string, runId?: string): Promise<WaitStateRow[]> {
    const run = runId !== undefined ? sql` AND "workflowRunId" = ${runId}` : EMPTY;
    return this.db.query<WaitStateRow>(sql`
      SELECT * FROM wait_states
       WHERE status = 'pending' AND mode = 'event' AND "eventName" = ${eventName}${run}
       ORDER BY ${this.insertionOrder()}`);
  }

  resolveWaitState(
    id: string,
    status: string,
    firedPayload: string | null,
    now: string,
  ): Promise<WaitStateRow | null> {
    return this.db.get<WaitStateRow>(sql`
      UPDATE wait_states
         SET status = ${status}, "firedPayload" = ${jsonText(firedPayload)}, "resolvedAt" = ${now}, "updatedAt" = ${now}
       WHERE id = ${id} AND status = 'pending'
       RETURNING *`);
  }

  listStuckWaitRuns(): Promise<StuckWaitRunRow[]> {
    return this.db.query<StuckWaitRunRow>(sql`
      SELECT
          wr.id as "runId",
          wrs.id as "stepId",
          wrs."nodeId",
          wr."workflowId",
          ws.id as "waitId",
          ws.mode as "waitMode",
          ws.status as "waitStatus",
          ws."wakeUpAt" as "wakeUpAt",
          ws."expiresAt" as "expiresAt",
          ws."firedPayload" as "firedPayload"
        FROM workflow_runs wr
        JOIN workflow_run_steps wrs ON wrs."runId" = wr.id AND wrs.status = 'waiting' AND wrs."nodeType" = 'wait'
        JOIN wait_states ws ON ws."workflowRunStepId" = wrs.id
       WHERE wr.status = 'waiting'
         AND (
           ws.status IN ('fired', 'timeout')
           OR (
             ws.status = 'pending'
             AND (
               (ws."wakeUpAt" IS NOT NULL AND ws."wakeUpAt" <= ${nowIso})
               OR
               (ws."expiresAt" IS NOT NULL AND ws."expiresAt" <= ${nowIso})
             )
           )
         )
       ORDER BY ${this.insertionOrder(sql`wrs`)}, ${this.insertionOrder(sql`ws`)}`);
  }

  async findWorkflowIdByName(name: string): Promise<string | null> {
    const row = await this.db.get<{ id: string }>(
      sql`SELECT id FROM workflows WHERE name = ${name}`,
    );
    return row?.id ?? null;
  }

  /** Insertion order differs per engine (SQLite `rowid`). */
  abstract listEnabledPreflightRows(): Promise<AutomationPreflightRowText[]>;

  async hasOtherSetupFailureRun(
    workflowId: string,
    runId: string,
    start: string,
    end: string,
  ): Promise<boolean> {
    const row = await this.db.get<{ found: number }>(sql`
      SELECT 1 AS found FROM workflow_runs
       WHERE "workflowId" = ${workflowId} AND id != ${runId} AND status = 'failed'
         AND ${likeAsciiCi(sql`error`, sql`'needs_setup:%'`)}
         AND "startedAt" >= ${start} AND "startedAt" < ${end}
       LIMIT 1`);
    return row !== null;
  }

  async findFirstTopLevelSetupFailureRunId(
    workflowId: string,
    start: string,
    end: string,
  ): Promise<string | null> {
    const row = await this.db.get<{ id: string }>(sql`
      SELECT id FROM workflow_runs
       WHERE "workflowId" = ${workflowId} AND status = 'failed' AND "parentStepId" IS NULL
         AND ${likeAsciiCi(sql`error`, sql`'needs_setup:%'`)}
         AND "startedAt" >= ${start} AND "startedAt" < ${end}
       ORDER BY "startedAt" ASC LIMIT 1`);
    return row?.id ?? null;
  }

  async insertFailedRun(r: {
    id: string;
    workflowId: string;
    triggerType: string;
    triggerData: string | null;
    error: string;
    createdBy: string | null;
    now: string;
  }): Promise<void> {
    await this.db.run(sql`
      INSERT INTO workflow_runs
        (id, "workflowId", status, "triggerType", "triggerData", error, created_by,
         "startedAt", "lastUpdatedAt", "finishedAt")
      VALUES (${r.id}, ${r.workflowId}, 'failed', ${r.triggerType}, ${jsonText(r.triggerData)}, ${r.error},
        ${r.createdBy}, ${r.now}, ${r.now}, ${r.now})`);
  }

  async countCompletedRunsAll(): Promise<number> {
    const row = await this.db.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM workflow_runs WHERE status = 'completed'`,
    );
    return row?.count ?? 0;
  }

  // ---- approval_requests: Slack threads waiting on a person ----

  listSlackThreadsAwaitingHuman(): Promise<{ channelId: string; threadTs: string }[]> {
    return this.db.query<{ channelId: string; threadTs: string }>(sql`
      SELECT DISTINCT task."slackChannelId" AS "channelId", task."slackThreadTs" AS "threadTs"
      FROM approval_requests request
      JOIN agent_tasks task ON task.id = request."sourceTaskId"
      WHERE request.status = 'pending'
        AND (request."expiresAt" IS NULL OR request."expiresAt" > ${nowIso})
        AND task."slackChannelId" IS NOT NULL
        AND task."slackThreadTs" IS NOT NULL`);
  }

  async isSlackThreadAwaitingHuman(channelId: string, threadTs: string): Promise<boolean> {
    const row = await this.db.get<{ waiting: number }>(sql`
      SELECT 1 AS waiting
      FROM approval_requests request
      JOIN agent_tasks task ON task.id = request."sourceTaskId"
      WHERE request.status = 'pending'
        AND (request."expiresAt" IS NULL OR request."expiresAt" > ${nowIso})
        AND task."slackChannelId" = ${channelId}
        AND task."slackThreadTs" = ${threadTs}
      LIMIT 1`);
    return !!row;
  }

  countWorkflows(): Promise<{ total: number; enabled: number | null } | null> {
    return this.db.get(sql`
      SELECT COUNT(*) AS total, SUM(CASE WHEN enabled = ${true} THEN 1 ELSE 0 END) AS enabled
      FROM workflows`);
  }

  async setRunContextReplay(runId: string, contextReplay: string): Promise<void> {
    await this.db.run(
      sql`UPDATE workflow_runs SET context_replay = ${contextReplay} WHERE id = ${runId}`,
    );
  }
}
