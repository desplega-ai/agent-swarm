import type { WorkflowRunRow, WorkflowRunStepRow } from "@desplega/storage";
import {
  TERMINAL_TASK_STATUSES,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowRunStep,
  type WorkflowRunStepSlim,
  type WorkflowRunStepStatus,
  type WorkflowRunSummary,
} from "../../types";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { normalizeDate, normalizeDateRequired } from "../date-utils";
import { scrubJsonValue } from "../scrub-json";
import { getStorage } from "../storage";
import { defineWorkflowPayload, type WorkflowPayloadView } from "../workflow-replay";

const workflowsRepo = () => getStorage().repos.workflows;

// Parent/child links between workflow runs (migration 203): a `sub-workflow`
// step starts a child run that records the step in `parentStepId`, and the
// step's `retryCount` at that time in `parentStepAttempt` (migration 240).

export type { WorkflowRunRow, WorkflowRunStepRow };

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

/**
 * `getWorkflowRun` without `context`, in the display view. Backs
 * `GET /api/workflow-runs/{id}?fields=slim`: the large column is neither read
 * nor parsed.
 */
/**
 * The principal decided when the run pinned its definition (migration 367, a
 * JSON `WorkflowRunPrincipal`), plus the agent the server stamped when the run
 * started (migration 247; null for webhook, event and older runs). Null
 * `principal` means a run from before migration 367.
 */
export async function getWorkflowRunPrincipalRow(
  runId: string,
): Promise<{ principal: string | null; triggeredByAgentId: string | null } | null> {
  return workflowsRepo().getRunPrincipal(runId);
}

export async function getWorkflowRunSummary(id: string): Promise<WorkflowRunSummary | null> {
  const row = await workflowsRepo().getRunSummary(id);
  return row ? rowToWorkflowRun(row, "display") : null;
}

/**
 * `getWorkflowRunStepsByRunId` without `input`, in the display view. Same
 * order, including the rowid tie-break for steps that share `startedAt`.
 */
export async function getWorkflowRunStepsSlimByRunId(
  runId: string,
): Promise<WorkflowRunStepSlim[]> {
  // Everything but `input` (a context snapshot per step, so loops grow it with
  // every iteration) and `output_replay` (the display view never opens it).
  const rows = await workflowsRepo().listStepsSlim(runId);
  return rows.map((row) => rowToWorkflowRunStep(row, "display"));
}

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
  const rows = await workflowsRepo().listRunLineage(runId, WORKFLOW_RUN_TREE_MAX_DEPTH);
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
      for (const id of await workflowsRepo().listChildRunIds(chunk)) {
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
  return ((await workflowsRepo().getRunStatus(runId)) as WorkflowRunStatus | null) ?? null;
}

/** Run `fn` over `ids` in chunks small enough for one statement's bound parameters. */
async function forEachChunk(ids: string[], fn: (chunk: string[]) => Promise<void>): Promise<void> {
  for (let i = 0; i < ids.length; i += TREE_QUERY_CHUNK) {
    await fn(ids.slice(i, i + TREE_QUERY_CHUNK));
  }
}

/**
 * Ids of the non-terminal tasks of the given runs, including tasks of earlier
 * attempts: a retry detaches a task from its step, but the run link stays.
 */
export async function getOpenWorkflowTreeTaskIds(runIds: string[]): Promise<string[]> {
  const ids: string[] = [];
  await forEachChunk(runIds, async (chunk) => {
    ids.push(
      ...(await getStorage().repos.tasks.listOpenTaskIdsOfRuns(chunk, TERMINAL_TASK_STATUSES)),
    );
  });
  return ids;
}

/**
 * Ids of tasks that a non-terminal task lists in `dependsOn`: the only
 * dependents a cancel can fail. One scan over open tasks, so a cancel of many
 * tasks looks for dependents once instead of once per task.
 */
export async function getTaskIdsWithDependents(): Promise<Set<string>> {
  return new Set(await getStorage().repos.tasks.listDependedOnTaskIds(TERMINAL_TASK_STATUSES));
}

/**
 * True when any of the given runs still has work a cancel would close: a live
 * run, a pending, running or waiting step, a queued retry, an open task or a
 * pending approval. Reads only, with a LIMIT 1 probe per chunk.
 */
export async function workflowRunTreeHasOpenWork(runIds: string[]): Promise<boolean> {
  const repo = workflowsRepo();
  const probes: Array<(chunk: string[]) => Promise<boolean>> = [
    (chunk) => repo.hasLiveRun(chunk),
    (chunk) => repo.hasOpenStep(chunk),
    (chunk) => getStorage().repos.tasks.hasOpenTaskOfRuns(chunk, TERMINAL_TASK_STATUSES),
    (chunk) => repo.hasPendingApproval(chunk),
  ];
  let open = false;
  await forEachChunk(runIds, async (chunk) => {
    for (const probe of probes) {
      if (open) return;
      if (await probe(chunk)) open = true;
    }
  });
  return open;
}

export type WorkflowRunTree = {
  rootRunId: string;
  /** Root first, in `getWorkflowRunTreeIds` order. List rows: no `context`. */
  runs: WorkflowRun[];
  hasOpenWork: boolean;
};

/**
 * The run and every run below it, with whether any of them still has open
 * work (see `workflowRunTreeHasOpenWork`). One read transaction, so `runs` and
 * `hasOpenWork` come from the same snapshot. Null when the root is missing.
 * Throws WorkflowRunTreeError on a cycle or a chain past the depth bound.
 */
export async function getWorkflowRunTree(rootRunId: string): Promise<WorkflowRunTree | null> {
  return getStorage().transaction(
    async () => {
      if ((await getWorkflowRunStatus(rootRunId)) === null) return null;
      const ids = await getWorkflowRunTreeIds(rootRunId);
      const byId = new Map<string, WorkflowRun>();
      await forEachChunk(ids, async (chunk) => {
        const rows = await workflowsRepo().listRunSummariesByIds(chunk);
        for (const row of rows) byId.set(row.id, rowToWorkflowRun(row, "display"));
      });
      const runs = ids.flatMap((id) => byId.get(id) ?? []);
      return { rootRunId, runs, hasOpenWork: await workflowRunTreeHasOpenWork(ids) };
    },
    { readOnly: true },
  );
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
  await forEachChunk(runIds, async (chunk) => {
    await workflowsRepo().cancelOpenStepsOfRuns(chunk, scrubSecrets(reason), finishedAt);
  });
}

/**
 * Count and wait of the pending approval requests that `cancelOpenWorkflowTreeSteps`
 * closes through the step-cancel trigger (migration 140). Counted in SQL, so
 * a tree of any size reports every request. Call it before the step cancel.
 */
export async function summarizeTreeStepPendingApprovals(
  runIds: string[],
  nowMs: number,
): Promise<{ count: number; waitMsTotal: number; waitMsMax: number }> {
  const summary = { count: 0, waitMsTotal: 0, waitMsMax: 0 };
  await forEachChunk(runIds, async (chunk) => {
    const row = await workflowsRepo().summarizePendingApprovalsOfOpenSteps(chunk, nowMs);
    summary.count += Number(row.count);
    summary.waitMsTotal += Math.max(0, Number(row.waitMsTotal ?? 0));
    summary.waitMsMax = Math.max(summary.waitMsMax, Number(row.waitMsMax ?? 0));
  });
  return summary;
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
  await forEachChunk(runIds, async (chunk) => {
    await workflowsRepo().disarmRetriesOfRuns(chunk, finishedAt);
  });
}

/**
 * Mark the given runs that are still running or waiting `cancelled`, without
 * the per-run `workflow.child.finished` wake-up: it is for runs whose parent
 * step the same cancel closes. Each run it cancels still emits
 * `workflow.run.finished`. A terminal run keeps its status and reason.
 */
export async function cancelLiveWorkflowTreeRuns(
  runIds: string[],
  reason: string,
  finishedAt: string,
): Promise<void> {
  await forEachChunk(runIds, async (chunk) => {
    const cancelled = await workflowsRepo().cancelLiveRuns(chunk, scrubSecrets(reason), finishedAt);
    for (const run of cancelled) emitRunFinished(run.id, run.workflowId, "cancelled");
  });
}

/** The id of the child run a `sub-workflow` step started on `attempt`, if any. */
export async function getChildWorkflowRunId(
  parentStepId: string,
  attempt: number,
): Promise<string | null> {
  return workflowsRepo().getChildRunId(parentStepId, attempt);
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
  const runId = await workflowsRepo().getLiveStepAttemptRunId(parentStepId, attempt);
  return runId != null && (await getRunLineageBlock(runId)) == null;
}

/**
 * Why `stepId` may not start new work (a task, an approval, a child run), or
 * null when it may: the step is `running` in a live run whose lineage is not
 * blocked. Call it inside the transaction that inserts the work.
 */
export async function getStepExecutionBlock(stepId: string): Promise<string | null> {
  const row = await workflowsRepo().getStepExecutionState(stepId);
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
  return workflowsRepo().listRunningSubWorkflowSteps();
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
  return workflowsRepo().getRunParent(parentStepId);
}

/**
 * Workflow ids of a run and the ancestor runs that started it, nearest first.
 * Stops `maxDepth` ancestors up, so it returns at most `maxDepth + 1` ids.
 */
export async function getWorkflowRunLineage(runId: string, maxDepth: number): Promise<string[]> {
  return workflowsRepo().listRunLineageWorkflowIds(runId, maxDepth);
}

/** Waiting `sub-workflow` steps whose current attempt's child run is terminal or deleted. */
export async function getSettledChildRunParentSteps(): Promise<string[]> {
  return workflowsRepo().listSettledChildRunParentStepIds();
}

/**
 * Before a workflow's runs are deleted, queue a wake-up for every step that
 * started one of them as a child, so the step fails instead of waiting forever.
 */
export async function wakeParentsOfDeletedRuns(workflowId: string): Promise<void> {
  const rows = await workflowsRepo().listChildRunsOfWorkflow(workflowId);
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
  emitBusEventAfterCommit("workflow.child.finished", { childRunId, parentStepId });
}

/** Bus event every run emits once when it turns terminal. */
export const WORKFLOW_RUN_FINISHED_EVENT = "workflow.run.finished";

export function isTerminalWorkflowRunStatus(status: WorkflowRunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Announce after commit that a run turned terminal, top-level and child runs
 * alike, so an event-mode `wait` can resume when any run ends. Callers emit
 * only when a live run (running or waiting) turns terminal, never on a later
 * update of a run that is already terminal. The id is `runId`, never `workflowRunId` or
 * `_runId`: those would put the finished run in the waiting run's own `run`
 * scope, so waiters use scope `global` and filter on `runId`.
 */
export function emitRunFinished(
  runId: string,
  workflowId: string,
  status: WorkflowRunStatus,
): void {
  if (!TERMINAL_STATUSES.has(status)) return;
  emitBusEventAfterCommit(WORKFLOW_RUN_FINISHED_EVENT, { runId, workflowId, status });
}

function emitBusEventAfterCommit(event: string, payload: Record<string, unknown>): void {
  getStorage().afterCommit(() => {
    import("../../workflows/event-bus")
      .then(({ workflowEventBus }) => {
        workflowEventBus.emit(event, payload);
      })
      .catch((err) =>
        console.error(
          `[db] ${event} event not emitted:`,
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
  return getStorage().transaction(async () => {
    const repo = workflowsRepo();
    const existingNodeIds = new Set(await repo.listStepNodeIdsWithPrefix(runId, prefix));
    const now = new Date().toISOString();
    let created = 0;
    for (const row of rows) {
      if (existingNodeIds.has(row.nodeId)) continue;
      await repo.insertPendingStep({
        id: row.id,
        runId,
        nodeId: row.nodeId,
        nodeType: row.nodeType,
        startedAt: now,
        input: scrubJsonValue(row.input),
        idempotencyKey: row.idempotencyKey,
      });
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
  return getStorage().transaction(async () => {
    const repo = workflowsRepo();
    const now = new Date().toISOString();
    let created = 0;
    for (const row of rows) {
      const attempt = await repo.countStepsForNode(runId, row.nodeId);
      const inserted = await repo.insertPendingStepIfNewKey({
        id: crypto.randomUUID(),
        runId,
        nodeId: row.nodeId,
        nodeType: row.nodeType,
        startedAt: now,
        input: scrubJsonValue({ itemKey: row.itemKey, index: row.index, attempt }),
        idempotencyKey: `${runId}:${row.nodeId}:${attempt}`,
      });
      if (inserted) created++;
    }
    return created;
  });
}
