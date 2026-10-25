import type {
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowRunStep,
  WorkflowRunStepSlim,
  WorkflowRunStepStatus,
  WorkflowRunSummary,
} from "../../types";
import { normalizeDate, normalizeDateRequired } from "../date-utils";
import { defineWorkflowPayload, type WorkflowPayloadView } from "../workflow-replay";
import { getDbClient } from "./runtime";

// Row shapes and mappers for `workflow_runs` / `workflow_run_steps`, shared by
// the CRUD in db.ts, plus the column-limited reads behind
// `GET /api/workflow-runs/{id}?fields=slim`.

export type WorkflowRunRow = {
  id: string;
  workflowId: string;
  status: string;
  triggerType: string;
  triggerData: string | null;
  /** Absent from list rows: see `WORKFLOW_RUN_SUMMARY_COLUMNS`. */
  context?: string | null;
  /** Sealed exact `context` (migration 201). Absent from list rows. */
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

/**
 * `view` picks the `context` copy: `replay` (default) is the exact sealed value
 * the engine resumes from; `display` is the scrubbed column for API, MCP and UI
 * responses. See `src/be/workflow-replay.ts`.
 */
export function rowToWorkflowRun(
  row: WorkflowRunRow,
  view: WorkflowPayloadView = "replay",
): WorkflowRun {
  const run: WorkflowRun = {
    id: row.id,
    workflowId: row.workflowId,
    status: row.status as WorkflowRunStatus,
    triggerData: row.triggerData ? JSON.parse(row.triggerData) : undefined,
    context: undefined,
    error: row.error ?? undefined,
    createdBy: row.created_by ?? undefined,
    startedAt: normalizeDateRequired(row.startedAt),
    lastUpdatedAt: normalizeDateRequired(row.lastUpdatedAt),
    finishedAt: normalizeDate(row.finishedAt) ?? undefined,
    parentStepId: row.parentStepId ?? undefined,
    parentStepAttempt: row.parentStepId ? (row.parentStepAttempt ?? 0) : undefined,
  };
  return defineWorkflowPayload(run, "context", row.context, row.context_replay, view, {
    runId: row.id,
    target: "its context",
  });
}

// Everything but `context`. `triggerData` stays: it is small, and stored
// scripts read it off list rows (dedupe by trigger, failure reports). The
// parent link and attempt stay so a list row identifies a child's invocation.
export const WORKFLOW_RUN_SUMMARY_COLUMNS =
  "id, workflowId, status, triggerType, triggerData, error, created_by, startedAt, lastUpdatedAt, finishedAt, parentStepId, parentStepAttempt";

export type WorkflowRunStepRow = {
  id: string;
  runId: string;
  nodeId: string;
  nodeType: string;
  status: string;
  /** Absent from slim rows: see `WORKFLOW_RUN_STEP_SLIM_COLUMNS`. */
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

/** `view` picks the `output` copy, as in `rowToWorkflowRun`. */
export function rowToWorkflowRunStep(
  row: WorkflowRunStepRow,
  view: WorkflowPayloadView = "replay",
): WorkflowRunStep {
  const step: WorkflowRunStep = {
    id: row.id,
    runId: row.runId,
    nodeId: row.nodeId,
    nodeType: row.nodeType,
    status: row.status as WorkflowRunStepStatus,
    input: row.input ? JSON.parse(row.input) : undefined,
    output: undefined,
    error: row.error ?? undefined,
    startedAt: normalizeDateRequired(row.startedAt),
    finishedAt: normalizeDate(row.finishedAt) ?? undefined,
    retryCount: row.retryCount,
    maxRetries: row.maxRetries,
    nextRetryAt: normalizeDate(row.nextRetryAt) ?? undefined,
    idempotencyKey: row.idempotencyKey ?? undefined,
    diagnostics: row.diagnostics ?? undefined,
    nextPort: row.nextPort ?? undefined,
  };
  return defineWorkflowPayload(step, "output", row.output, row.output_replay, view, {
    runId: row.runId,
    target: `the output of step ${row.id} (node ${row.nodeId})`,
  });
}

// Everything but `input` (a context snapshot per step, so loops grow it with
// every iteration) and `output_replay` (the display view never opens it).
const WORKFLOW_RUN_STEP_SLIM_COLUMNS =
  "id, runId, nodeId, nodeType, status, output, error, startedAt, finishedAt, retryCount, maxRetries, nextRetryAt, idempotencyKey, diagnostics, nextPort";

/**
 * `getWorkflowRun` without `context`, in the display view. Backs
 * `GET /api/workflow-runs/{id}?fields=slim`: the large column is neither read
 * nor parsed.
 */
export async function getWorkflowRunSummary(id: string): Promise<WorkflowRunSummary | null> {
  const row = await getDbClient().get<WorkflowRunRow>(
    `SELECT ${WORKFLOW_RUN_SUMMARY_COLUMNS} FROM workflow_runs WHERE id = ?`,
    [id],
  );
  return row ? rowToWorkflowRun(row, "display") : null;
}

/**
 * `getWorkflowRunStepsByRunId` without `input`, in the display view. Same
 * order, including the rowid tie-break for steps that share `startedAt`.
 */
export async function getWorkflowRunStepsSlimByRunId(
  runId: string,
): Promise<WorkflowRunStepSlim[]> {
  const rows = await getDbClient().query<WorkflowRunStepRow>(
    `SELECT ${WORKFLOW_RUN_STEP_SLIM_COLUMNS} FROM workflow_run_steps WHERE runId = ? ORDER BY startedAt ASC, rowid ASC`,
    [runId],
  );
  return rows.map((row) => rowToWorkflowRunStep(row, "display"));
}
