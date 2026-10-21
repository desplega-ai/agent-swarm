import type { WorkflowRunStatus } from "../../types";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { scrubJsonValue } from "../scrub-json";
import { getDbClient } from "./runtime";

// Parent/child links between workflow runs (migration 203): a `sub-workflow`
// step starts a child run that records the step in `parentStepId`.

const TERMINAL_STATUSES = new Set<WorkflowRunStatus>([
  "completed",
  "failed",
  "cancelled",
  "skipped",
]);

/** The id of the child run a `sub-workflow` step started, if any. */
export async function getChildWorkflowRunId(parentStepId: string): Promise<string | null> {
  const row = await getDbClient().get<{ id: string }>(
    "SELECT id FROM workflow_runs WHERE parentStepId = ?",
    [parentStepId],
  );
  return row?.id ?? null;
}

/** Where a child run came from: the `sub-workflow` step that started it and that step's run. */
export type WorkflowRunParent = {
  runId: string;
  workflowId: string;
  stepId: string;
  nodeId: string;
};

/** The parent of a child run, or null when the step (or its run) is gone. */
export async function getWorkflowRunParent(
  parentStepId: string,
): Promise<WorkflowRunParent | null> {
  const row = await getDbClient().get<WorkflowRunParent>(
    `SELECT s.runId AS runId, r.workflowId AS workflowId, s.id AS stepId, s.nodeId AS nodeId
       FROM workflow_run_steps s
       JOIN workflow_runs r ON r.id = s.runId
      WHERE s.id = ?`,
    [parentStepId],
  );
  return row ?? null;
}

/**
 * Workflow ids of a run and the ancestor runs that started it, nearest first.
 * Stops `maxDepth` ancestors up, so it returns at most `maxDepth + 1` ids.
 */
export async function getWorkflowRunLineage(runId: string, maxDepth: number): Promise<string[]> {
  const rows = await getDbClient().query<{ workflowId: string }>(
    `WITH RECURSIVE lineage(id, workflowId, parentStepId, depth) AS (
       SELECT id, workflowId, parentStepId, 0 FROM workflow_runs WHERE id = ?
       UNION ALL
       SELECT r.id, r.workflowId, r.parentStepId, l.depth + 1
         FROM lineage l
         JOIN workflow_run_steps s ON s.id = l.parentStepId
         JOIN workflow_runs r ON r.id = s.runId
        WHERE l.depth < ?
     )
     SELECT workflowId FROM lineage ORDER BY depth`,
    [runId, maxDepth],
  );
  return rows.map((row) => row.workflowId);
}

/** Waiting `sub-workflow` steps whose child run is terminal or deleted. */
export async function getSettledChildRunParentSteps(): Promise<string[]> {
  const rows = await getDbClient().query<{ id: string }>(
    `SELECT s.id
       FROM workflow_run_steps s
       LEFT JOIN workflow_runs c ON c.parentStepId = s.id
      WHERE s.status = 'waiting' AND s.nodeType = 'sub-workflow'
        AND (c.id IS NULL OR c.status IN ('completed', 'failed', 'cancelled', 'skipped'))`,
  );
  return rows.map((row) => row.id);
}

/**
 * Before a workflow's runs are deleted, queue a wake-up for every step that
 * started one of them as a child, so the step fails instead of waiting forever.
 */
export async function wakeParentsOfDeletedRuns(workflowId: string): Promise<void> {
  const rows = await getDbClient().query<{ id: string; parentStepId: string }>(
    "SELECT id, parentStepId FROM workflow_runs WHERE workflowId = ? AND parentStepId IS NOT NULL",
    [workflowId],
  );
  for (const row of rows) emitAfterCommit(row.id, row.parentStepId);
}

/**
 * Wake the waiting `sub-workflow` step once its child run is terminal. Emitted
 * after commit; a missed event is caught by the recovery sweep
 * (`getSettledChildRunParentSteps`).
 */
export function emitChildRunFinished(
  childRunId: string,
  parentStepId: string,
  status: WorkflowRunStatus,
): void {
  if (TERMINAL_STATUSES.has(status)) emitAfterCommit(childRunId, parentStepId);
}

function emitAfterCommit(childRunId: string, parentStepId: string): void {
  getDbClient().afterCommit(() => {
    import("../../workflows/event-bus")
      .then(({ workflowEventBus }) => {
        workflowEventBus.emit("workflow.child.finished", { childRunId, parentStepId });
      })
      .catch((err) =>
        console.error(
          "[db] workflow.child.finished event not emitted:",
          scrubSecrets(err instanceof Error ? err.message : String(err)),
        ),
      );
  });
}

/**
 * Insert a foreach parent's missing child step rows as `pending` (queued), all
 * in one transaction, so a crash never leaves a partial child set and the join
 * always sees every item. Children that already exist (any row for the child
 * node id) are skipped inside the transaction, which makes a concurrent
 * re-execution of the same parent insert nothing twice. Returns how many rows
 * this call inserted.
 */
export async function createForeachChildSteps(
  runId: string,
  parentNodeId: string,
  rows: Array<{
    id: string;
    nodeId: string;
    nodeType: string;
    input: unknown;
    idempotencyKey: string;
  }>,
): Promise<number> {
  if (rows.length === 0) return 0;
  const prefix = `${parentNodeId}#`;
  return getDbClient().transaction(async (tx) => {
    const existing = await tx.query<{ nodeId: string }>(
      "SELECT DISTINCT nodeId FROM workflow_run_steps WHERE runId = ? AND substr(nodeId, 1, ?) = ?",
      [runId, prefix.length, prefix],
    );
    const existingNodeIds = new Set(existing.map((row) => row.nodeId));
    const now = new Date().toISOString();
    let created = 0;
    for (const row of rows) {
      if (existingNodeIds.has(row.nodeId)) continue;
      await tx.run(
        `INSERT INTO workflow_run_steps (id, runId, nodeId, nodeType, status, startedAt, input, idempotencyKey)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
        [
          row.id,
          runId,
          row.nodeId,
          row.nodeType,
          now,
          scrubJsonValue(row.input),
          row.idempotencyKey,
        ],
      );
      existingNodeIds.add(row.nodeId);
      created++;
    }
    return created;
  });
}

/**
 * Insert a new `pending` attempt row for each foreach item being retried. Each
 * row reuses its item's child node id and gets a fresh step id, so the body
 * starts a new invocation (a new task, child run, approval or wait) while the
 * earlier attempt rows stay as history. `attempt` is the number of rows the
 * item already has, and the idempotency key `<runId>:<childNodeId>:<attempt>`
 * is UNIQUE, so a duplicated retry of the same attempt inserts nothing.
 * Call it inside the retry's transaction. Returns how many rows it inserted.
 */
export async function createForeachAttemptSteps(
  runId: string,
  rows: Array<{ nodeId: string; nodeType: string; itemKey: string; index: number }>,
): Promise<number> {
  if (rows.length === 0) return 0;
  return getDbClient().transaction(async (tx) => {
    const now = new Date().toISOString();
    let created = 0;
    for (const row of rows) {
      const count = await tx.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM workflow_run_steps WHERE runId = ? AND nodeId = ?",
        [runId, row.nodeId],
      );
      const attempt = count?.n ?? 0;
      const inserted = await tx.get<{ id: string }>(
        `INSERT INTO workflow_run_steps (id, runId, nodeId, nodeType, status, startedAt, input, idempotencyKey)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
           ON CONFLICT(idempotencyKey) DO NOTHING
           RETURNING id`,
        [
          crypto.randomUUID(),
          runId,
          row.nodeId,
          row.nodeType,
          now,
          scrubJsonValue({ itemKey: row.itemKey, index: row.index, attempt }),
          `${runId}:${row.nodeId}:${attempt}`,
        ],
      );
      if (inserted) created++;
    }
    return created;
  });
}
