import { TERMINAL_TASK_STATUSES, type WorkflowRunStatus } from "../../types";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { scrubJsonValue } from "../scrub-json";
import { getDbClient } from "./runtime";

// Parent/child links between workflow runs (migration 203): a `sub-workflow`
// step starts a child run that records the step in `parentStepId`, and the
// step's `retryCount` at that time in `parentStepAttempt` (migration 240).

const TERMINAL_STATUSES = new Set<WorkflowRunStatus>([
  "completed",
  "failed",
  "cancelled",
  "skipped",
]);

/**
 * Deepest run tree the lineage guard and the cascade cancel walk. Twice the
 * sub-workflow nesting cap (MAX_SUB_WORKFLOW_DEPTH, 16), so any tree the
 * engine admits fits; a deeper chain is corrupt and fails closed.
 */
export const WORKFLOW_RUN_TREE_MAX_DEPTH = 32;

/** Thrown when a run's stored parent links cannot be walked: a cycle, or a chain past the depth bound. */
export class WorkflowRunTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowRunTreeError";
  }
}

/**
 * Thrown when work is created for a workflow step that may no longer run: the
 * step is not `running`, its run is not live, or the run's lineage is blocked
 * (see `getRunLineageBlock`).
 */
export class WorkflowStepNotExecutableError extends Error {
  constructor(stepId: string, reason: string) {
    super(`Workflow step ${stepId} may not start new work: ${reason}`);
    this.name = "WorkflowStepNotExecutableError";
  }
}

/**
 * Why the run and its ancestors forbid new engine work, or null when they
 * allow it. Blocked when the run is missing, the run or an ancestor is
 * `cancelled`, a stored parent link points at a missing step or run, the
 * links form a cycle, or the chain is deeper than WORKFLOW_RUN_TREE_MAX_DEPTH.
 * A completed or failed ancestor does not block: a child of an earlier
 * attempt may outlive its parent's run. The run's own live status is left to
 * the caller, since the retry claim also revives a `failed` run.
 *
 * Call it inside the transaction that writes the new work, so a cascade
 * cancel either commits first and is seen here or sees the new row itself.
 */
export async function getRunLineageBlock(runId: string): Promise<string | null> {
  const rows = await getDbClient().query<{
    id: string;
    status: WorkflowRunStatus;
    parentStepId: string | null;
    depth: number;
  }>(
    `WITH RECURSIVE lineage(id, status, parentStepId, depth) AS (
       SELECT id, status, parentStepId, 0 FROM workflow_runs WHERE id = ?
       UNION ALL
       SELECT r.id, r.status, r.parentStepId, l.depth + 1
         FROM lineage l
         JOIN workflow_run_steps s ON s.id = l.parentStepId
         JOIN workflow_runs r ON r.id = s.runId
        WHERE l.depth < ?
     )
     SELECT id, status, parentStepId, depth FROM lineage ORDER BY depth`,
    [runId, WORKFLOW_RUN_TREE_MAX_DEPTH],
  );
  if (rows.length === 0) return `Workflow run ${runId} is missing`;
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) return `Workflow run ${runId} has a cycle in its parent links`;
    seen.add(row.id);
    if (row.status === "cancelled") {
      return row.id === runId
        ? `Workflow run ${runId} is cancelled`
        : `Ancestor workflow run ${row.id} is cancelled`;
    }
  }
  const top = rows[rows.length - 1]!;
  if (top.parentStepId == null) return null;
  if (top.depth >= WORKFLOW_RUN_TREE_MAX_DEPTH) {
    return `Workflow run ${runId} is nested deeper than ${WORKFLOW_RUN_TREE_MAX_DEPTH} levels`;
  }
  return `Parent step ${top.parentStepId} of workflow run ${top.id} is missing`;
}

/**
 * The run and every run below it, root first: children of every attempt of
 * every step, through terminal runs too, since a run that ended can still have
 * a live child of an earlier attempt. The tree comes from stored links only
 * (child.parentStepId → step → run). There is no size limit: the engine admits
 * any number of children per run, and a tree it admitted must stay
 * cancellable. Throws WorkflowRunTreeError on a cycle or past `maxDepth`, so
 * the caller's transaction rolls back whole.
 */
export async function getWorkflowRunTreeIds(
  rootId: string,
  bounds: { maxDepth?: number } = {},
): Promise<string[]> {
  const maxDepth = bounds.maxDepth ?? WORKFLOW_RUN_TREE_MAX_DEPTH;
  const ids = [rootId];
  const seen = new Set(ids);
  // One level per pass, so a cycle stops at its first repeated run instead of
  // unrolling down to the depth bound.
  let level = [rootId];
  for (let depth = 1; level.length > 0; depth++) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += TREE_QUERY_CHUNK) {
      const chunk = level.slice(i, i + TREE_QUERY_CHUNK);
      const rows = await getDbClient().query<{ id: string }>(
        `SELECT c.id
           FROM workflow_run_steps s
           JOIN workflow_runs c ON c.parentStepId = s.id
          WHERE s.runId IN (${chunk.map(() => "?").join(", ")})`,
        chunk,
      );
      for (const { id } of rows) {
        // Each run has one parent link, so reaching a run twice means a cycle.
        if (seen.has(id)) {
          throw new WorkflowRunTreeError(`Workflow run tree of ${rootId} has a cycle at run ${id}`);
        }
        seen.add(id);
        next.push(id);
      }
    }
    if (next.length > 0 && depth > maxDepth) {
      throw new WorkflowRunTreeError(
        `Workflow run tree of ${rootId} is nested deeper than ${maxDepth} levels`,
      );
    }
    ids.push(...next);
    level = next;
  }
  return ids;
}

/** Parent runs per children query, well under SQLite's bound-parameter limit. */
const TREE_QUERY_CHUNK = 500;

/** A run's status alone, without opening its sealed context. Null when the run is missing. */
export async function getWorkflowRunStatus(runId: string): Promise<WorkflowRunStatus | null> {
  const row = await getDbClient().get<{ status: WorkflowRunStatus }>(
    "SELECT status FROM workflow_runs WHERE id = ?",
    [runId],
  );
  return row?.status ?? null;
}

/** Run `fn` over `ids` in chunks small enough for one statement's bound parameters. */
async function forEachChunk(
  ids: string[],
  fn: (chunk: string[], placeholders: string) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < ids.length; i += TREE_QUERY_CHUNK) {
    const chunk = ids.slice(i, i + TREE_QUERY_CHUNK);
    await fn(chunk, chunk.map(() => "?").join(", "));
  }
}

/**
 * Ids of the non-terminal tasks of the given runs, including tasks of earlier
 * attempts: a retry detaches a task from its step, but the run link stays.
 */
export async function getOpenWorkflowTreeTaskIds(runIds: string[]): Promise<string[]> {
  const ids: string[] = [];
  const terminal = TERMINAL_TASK_STATUSES.map(() => "?").join(", ");
  await forEachChunk(runIds, async (chunk, placeholders) => {
    const rows = await getDbClient().query<{ id: string }>(
      `SELECT id FROM agent_tasks
        WHERE workflowRunId IN (${placeholders}) AND status NOT IN (${terminal})`,
      [...chunk, ...TERMINAL_TASK_STATUSES],
    );
    for (const row of rows) ids.push(row.id);
  });
  return ids;
}

/**
 * Ids of tasks some other task lists in `dependsOn`. One scan, so a cancel of
 * many tasks looks for dependents once instead of once per task.
 */
export async function getTaskIdsWithDependents(): Promise<Set<string>> {
  const rows = await getDbClient().query<{ id: string }>(
    `SELECT DISTINCT dep.value AS id
       FROM agent_tasks t, json_each(t.dependsOn) AS dep
      WHERE t.dependsOn IS NOT NULL AND t.dependsOn != '[]'`,
  );
  return new Set(rows.map((row) => row.id));
}

/**
 * Cancel the pending, running and waiting steps of the given runs. The
 * migration-140 trigger closes each cancelled step's pending approval.
 */
export async function cancelOpenWorkflowTreeSteps(
  runIds: string[],
  reason: string,
  finishedAt: string,
): Promise<void> {
  await forEachChunk(runIds, async (chunk, placeholders) => {
    await getDbClient().run(
      `UPDATE workflow_run_steps
          SET status = 'cancelled', error = ?, finishedAt = ?
        WHERE runId IN (${placeholders}) AND status IN ('pending', 'running', 'waiting')`,
      [scrubSecrets(reason), finishedAt, ...chunk],
    );
  });
}

/**
 * Drop the pending retries of the failed steps of the given runs. The step
 * keeps its status, error, output and retryCount; only the queued next
 * attempt goes.
 */
export async function disarmWorkflowTreeRetries(
  runIds: string[],
  finishedAt: string,
): Promise<void> {
  await forEachChunk(runIds, async (chunk, placeholders) => {
    await getDbClient().run(
      `UPDATE workflow_run_steps
          SET nextRetryAt = NULL, finishedAt = COALESCE(finishedAt, ?)
        WHERE runId IN (${placeholders}) AND status = 'failed' AND nextRetryAt IS NOT NULL`,
      [finishedAt, ...chunk],
    );
  });
}

/**
 * Mark the given runs that are still running or waiting `cancelled`, without
 * the per-run `workflow.child.finished` wake-up: it is for runs whose parent
 * step the same cancel closes. A terminal run keeps its status and reason.
 */
export async function cancelLiveWorkflowTreeRuns(
  runIds: string[],
  reason: string,
  finishedAt: string,
): Promise<void> {
  await forEachChunk(runIds, async (chunk, placeholders) => {
    await getDbClient().run(
      `UPDATE workflow_runs
          SET status = 'cancelled', error = ?, finishedAt = ?, lastUpdatedAt = ?
        WHERE id IN (${placeholders}) AND status IN ('running', 'waiting')`,
      [scrubSecrets(reason), finishedAt, finishedAt, ...chunk],
    );
  });
}

/** The id of the child run a `sub-workflow` step started on `attempt`, if any. */
export async function getChildWorkflowRunId(
  parentStepId: string,
  attempt: number,
): Promise<string | null> {
  const row = await getDbClient().get<{ id: string }>(
    "SELECT id FROM workflow_runs WHERE parentStepId = ? AND parentStepAttempt = ?",
    [parentStepId, attempt],
  );
  return row?.id ?? null;
}

/**
 * True while `attempt` of the step is executing in a live run: the step is
 * `running` with that `retryCount` and no ancestor run is cancelled. A child
 * run is created only then, so a cancelled run or tree, a step another attempt
 * moved on, or a step already parked never gets a new child.
 */
export async function isParentStepAttemptCurrent(
  parentStepId: string,
  attempt: number,
): Promise<boolean> {
  const row = await getDbClient().get<{ runId: string }>(
    `SELECT r.id AS runId
       FROM workflow_run_steps s
       JOIN workflow_runs r ON r.id = s.runId
      WHERE s.id = ? AND s.status = 'running' AND s.retryCount = ?
        AND r.status IN ('running', 'waiting')`,
    [parentStepId, attempt],
  );
  return row != null && (await getRunLineageBlock(row.runId)) == null;
}

/**
 * Why `stepId` may not start new work (a task, an approval, a child run), or
 * null when it may: the step is `running` in a live run whose lineage is not
 * blocked. Call it inside the transaction that inserts the work.
 */
export async function getStepExecutionBlock(stepId: string): Promise<string | null> {
  const row = await getDbClient().get<{
    stepStatus: string;
    runId: string;
    runStatus: WorkflowRunStatus;
  }>(
    `SELECT s.status AS stepStatus, r.id AS runId, r.status AS runStatus
       FROM workflow_run_steps s
       JOIN workflow_runs r ON r.id = s.runId
      WHERE s.id = ?`,
    [stepId],
  );
  if (!row) return "the step or its run is missing";
  if (row.runStatus !== "running" && row.runStatus !== "waiting") {
    return `its run is ${row.runStatus}`;
  }
  if (row.stepStatus !== "running") return `the step is ${row.stepStatus}`;
  return getRunLineageBlock(row.runId);
}

/**
 * `sub-workflow` steps left `running` in a live run: each is its node's latest
 * row, so a row a newer one superseded is not listed. The caller skips the
 * ones this process is still executing.
 */
export async function getRunningSubWorkflowSteps(): Promise<
  Array<{ stepId: string; runId: string; nodeId: string }>
> {
  return getDbClient().query<{ stepId: string; runId: string; nodeId: string }>(
    `SELECT s.id AS stepId, s.runId AS runId, s.nodeId AS nodeId
       FROM workflow_run_steps s
       JOIN workflow_runs r ON r.id = s.runId
      WHERE s.status = 'running' AND s.nodeType = 'sub-workflow'
        AND r.status IN ('running', 'waiting')
        AND s.rowid = (
          SELECT MAX(rowid) FROM workflow_run_steps
           WHERE runId = s.runId AND nodeId = s.nodeId
        )`,
  );
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

/** Waiting `sub-workflow` steps whose current attempt's child run is terminal or deleted. */
export async function getSettledChildRunParentSteps(): Promise<string[]> {
  const rows = await getDbClient().query<{ id: string }>(
    `SELECT s.id
       FROM workflow_run_steps s
       LEFT JOIN workflow_runs c
         ON c.parentStepId = s.id AND c.parentStepAttempt = s.retryCount
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
