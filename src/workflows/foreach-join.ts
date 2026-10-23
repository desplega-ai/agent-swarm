import {
  getDbClient,
  getLatestStepForNode,
  getWorkflowRun,
  getWorkflowRunStep,
  getWorkflowRunStepsByRunId,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import { getRunLineageBlock } from "../be/db/workflow-runs";
import type {
  WorkflowDefinition,
  WorkflowNode,
  WorkflowRunStep,
  WorkflowRunStepStatus,
} from "../types";
import { checkpointStep } from "./checkpoint";
import { getSuccessors } from "./definition";
import type { ForeachOutput } from "./executors/foreach";
import type { ExecutorRegistry } from "./executors/registry";
import { effectiveFailurePolicy } from "./foreach-body";
import { startForeachDrive } from "./foreach-driver";

export const FOREACH_TERMINAL_STEP_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "skipped",
]);

/**
 * A failed step queued for the retry poller (`nextRetryAt` set). A foreach
 * child in this state is still in flight: it is not settled and holds its
 * concurrency slot until the poller re-queues it.
 */
export function isRetryPending(step: Pick<WorkflowRunStep, "status" | "nextRetryAt">): boolean {
  return step.status === "failed" && step.nextRetryAt != null;
}

/** A foreach child whose outcome is final: terminal and not queued for a retry. */
export function isForeachChildSettled(
  step: Pick<WorkflowRunStep, "status" | "nextRetryAt">,
): boolean {
  return FOREACH_TERMINAL_STEP_STATUSES.has(step.status) && !isRetryPending(step);
}

export interface SyntheticNodeId {
  parentNodeId: string;
  itemKey: string;
}

export function parseSyntheticNodeId(nodeId: string): SyntheticNodeId | null {
  // Keep this parser aligned with `apps/ui/src/lib/synthetic-step-id.ts`. This side
  // stays permissive because every caller verifies the parsed parent is a real
  // `foreach` node (resolveForeachParent / the executor's meta.nodeId match); the UI
  // variant takes the foreach-id set explicitly for the same guarantee.
  const separatorIndex = nodeId.indexOf("#");
  if (separatorIndex <= 0 || separatorIndex === nodeId.length - 1) return null;
  return {
    parentNodeId: nodeId.slice(0, separatorIndex),
    itemKey: nodeId.slice(separatorIndex + 1),
  };
}

export function resolveForeachParent(
  def: Pick<WorkflowDefinition, "nodes">,
  nodeId: string,
): WorkflowNode | null {
  const parsed = parseSyntheticNodeId(nodeId);
  if (!parsed) return null;
  const parent = def.nodes.find((node) => node.id === parsed.parentNodeId);
  return parent?.type === "foreach" ? parent : null;
}

export interface ForeachJoinResult {
  joined: boolean;
  parentNodeId: string;
  successors: WorkflowNode[];
}

export async function joinForeach(
  def: WorkflowDefinition,
  runId: string,
  childStep: WorkflowRunStep,
  ctx: Record<string, unknown>,
): Promise<ForeachJoinResult> {
  const parent = resolveForeachParent(def, childStep.nodeId);
  if (!parent) {
    throw new Error(`Step "${childStep.nodeId}" is not a foreach child`);
  }

  const children = latestForeachChildren(def, parent.id, await getWorkflowRunStepsByRunId(runId));

  // `pending` (queued, not started) and a child queued for a retry are
  // non-terminal like running and waiting.
  if (children.some((step) => !isForeachChildSettled(step))) {
    return { joined: false, parentNodeId: parent.id, successors: [] };
  }

  const parentStep = await getLatestStepForNode(runId, parent.id);
  if (!parentStep) {
    throw new Error(`Waiting foreach parent step "${parent.id}" was not found`);
  }
  if (parentStep.status === "completed") {
    // A run re-walk reconstructs successors from completed parent steps. A
    // second closer must not mint another successor iteration here.
    return { joined: false, parentNodeId: parent.id, successors: [] };
  }

  const aggregate = buildForeachAggregate(children);

  await checkpointStep(runId, parentStep.id, parent.id, { output: aggregate }, ctx);
  return {
    joined: true,
    parentNodeId: parent.id,
    successors: getSuccessors(def, parent.id),
  };
}

/**
 * The latest step row per child node id of foreach `parentNodeId`, in item
 * order. `steps` must be in insert order (as `getWorkflowRunStepsByRunId`
 * returns them), so a later attempt row supersedes an earlier one.
 */
export function latestForeachChildren(
  def: WorkflowDefinition,
  parentNodeId: string,
  steps: WorkflowRunStep[],
): WorkflowRunStep[] {
  const latest = new Map<string, WorkflowRunStep>();
  for (const step of steps) {
    if (resolveForeachParent(def, step.nodeId)?.id === parentNodeId) latest.set(step.nodeId, step);
  }
  return [...latest.values()].sort((a, b) => childIndex(a) - childIndex(b));
}

export function buildForeachAggregate(children: WorkflowRunStep[]): ForeachOutput {
  // Only the latest row per child node id counts (insert order).
  const latest = new Map<string, WorkflowRunStep>();
  for (const step of children) latest.set(step.nodeId, step);
  const orderedChildren = [...latest.values()].sort((a, b) => childIndex(a) - childIndex(b));
  const results: ForeachOutput["results"] = orderedChildren.map((step) => {
    const parsed = parseSyntheticNodeId(step.nodeId)!;
    const status = resultStatus(step);
    return {
      itemKey: parsed.itemKey,
      status,
      output: step.output,
    };
  });
  // Only `completed` without an error is ok: failed, cancelled, skipped and the
  // legacy completed+error shape all count as failed.
  const failedCount = results.filter((result) => result.status !== "completed").length;
  const cancelledCount = results.filter((result) => result.status === "cancelled").length;
  const aggregate: ForeachOutput = {
    results,
    okCount: results.length - failedCount,
    failedCount,
    ...(cancelledCount > 0 ? { cancelledCount } : {}),
  };
  return aggregate;
}

function childIndex(step: WorkflowRunStep): number {
  if (typeof step.input !== "object" || step.input === null) return Number.MAX_SAFE_INTEGER;
  const index = (step.input as Record<string, unknown>).index;
  return typeof index === "number" ? index : Number.MAX_SAFE_INTEGER;
}

function resultStatus(step: WorkflowRunStep): ForeachOutput["results"][number]["status"] {
  if (step.status !== "completed") return step.status as "failed" | "cancelled" | "skipped";
  // An onNodeFailure:"continue" completion persists its failure reason on
  // step.error (completeTaskStepAndResolveSuccessors). Classify on that explicit
  // metadata — a successful child whose OUTPUT merely begins with "[FAILED:"
  // (e.g. an agent quoting a log line) is user-controlled text, not a failure.
  return step.error ? "failed" : "completed";
}

/** The terminal outcome of one foreach item. */
export interface ForeachChildOutcome {
  status: "completed" | "failed" | "cancelled";
  output?: unknown;
  /**
   * The failure reason. On a `completed` outcome it marks the legacy
   * `onNodeFailure: "continue"` shape (completed with error), which the
   * aggregate counts as failed.
   */
  error?: string;
  /** Stored on the child row for display only: a body's ports do not route. */
  nextPort?: string;
}

export interface ForeachSettleResult {
  /** False when the child was not in an expected status, or the run is no longer live. */
  claimed: boolean;
  foreachChild: true;
  /** True when this settlement closed the join and checkpointed the parent. */
  joined: boolean;
  /** The parent's successors to walk, when `joined`. */
  successors: WorkflowNode[];
  /** True when this settlement failed the run (a failed item under fail-fast). */
  runFailed: boolean;
}

/**
 * The one place a foreach child reaches a terminal status. Every resume path
 * (task, approval, wait, child run, and their failure paths) and the foreach
 * driver's inline items settle through here.
 *
 * In one transaction:
 * 1. Re-read the child; claim it only while it is in one of `from` (default
 *    `waiting`, the parked status every resume path expects).
 * 2. Write the terminal status, output, error and port.
 * 3. A run that is no longer live (failed, cancelled) only records the
 *    outcome: a late sibling must not revive a failed run or route its join.
 * 4. A failed or cancelled item under fail-fast (see effectiveFailurePolicy)
 *    cancels the queued siblings and fails the run; in-flight siblings still
 *    record their outcomes. Under collect-outcomes it counts as failed in the
 *    aggregate and the join proceeds.
 * 5. Otherwise run the join and set the run `running`.
 *
 * When the join stays open with a queued (`pending`) item and a `registry` is
 * passed, a drive of the parent starts after commit, so the next item starts.
 * Orphaned `running` items are the recovery sweep's.
 */
export async function settleForeachChild(
  def: WorkflowDefinition,
  runId: string,
  childStepId: string,
  outcome: ForeachChildOutcome,
  ctx: Record<string, unknown>,
  options: {
    from?: readonly WorkflowRunStepStatus[];
    registry?: ExecutorRegistry;
    /** Run error when this outcome fails the run. Defaults to the outcome error. */
    runError?: string;
  } = {},
): Promise<ForeachSettleResult> {
  const from = options.from ?? ["waiting"];
  return await getDbClient().transaction(async (): Promise<ForeachSettleResult> => {
    const unclaimed: ForeachSettleResult = {
      claimed: false,
      foreachChild: true,
      joined: false,
      successors: [],
      runFailed: false,
    };
    const current = await getWorkflowRunStep(childStepId);
    if (!current || !from.includes(current.status)) return unclaimed;
    const parent = resolveForeachParent(def, current.nodeId);
    if (!parent) throw new Error(`Step "${current.nodeId}" is not a foreach child`);
    const run = await getWorkflowRun(runId);
    if (!run) return unclaimed;

    const finishedAt = new Date().toISOString();
    await updateWorkflowRunStep(childStepId, {
      status: outcome.status,
      ...(outcome.output !== undefined ? { output: outcome.output } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      ...(outcome.nextPort ? { nextPort: outcome.nextPort } : {}),
      finishedAt,
    });

    if (run.status !== "running" && run.status !== "waiting") return unclaimed;
    // The outcome stays on the item as history; a cancelled tree routes nothing.
    if (await getRunLineageBlock(runId)) return unclaimed;

    if (outcome.status !== "completed" && effectiveFailurePolicy(parent, def) === "fail-fast") {
      const reason = options.runError ?? outcome.error ?? `foreach item ${current.nodeId} failed`;
      await cancelQueuedForeachChildren(def, runId, parent.id, current.nodeId);
      await updateWorkflowRun(runId, { status: "failed", error: reason, finishedAt });
      return { ...unclaimed, claimed: true, runFailed: true };
    }

    const join = await joinForeach(def, runId, current, ctx);
    await updateWorkflowRun(runId, { status: "running" });
    const registry = options.registry;
    if (!join.joined && registry && (await hasQueuedChild(def, runId, parent.id))) {
      getDbClient().afterCommit(() => startForeachDrive(runId, parent.id, registry));
    }
    return {
      claimed: true,
      foreachChild: true,
      joined: join.joined,
      successors: join.successors,
      runFailed: false,
    };
  });
}

/**
 * Fail-fast: cancel every queued (`pending`) child of the fan-out so none of
 * them starts, and every child queued for a retry so the retry poller does not
 * revive the failed run. In-flight children are left to finish and record their
 * outcome. A run retry gives each cancelled item a new attempt.
 */
export async function cancelQueuedForeachChildren(
  def: WorkflowDefinition,
  runId: string,
  parentNodeId: string,
  failedChildNodeId?: string,
): Promise<number> {
  const failedKey = failedChildNodeId
    ? (parseSyntheticNodeId(failedChildNodeId)?.itemKey ?? failedChildNodeId)
    : undefined;
  const error = failedKey
    ? `not started: fail-fast after item ${failedKey} failed`
    : "not started: fail-fast after the run failed";
  const finishedAt = new Date().toISOString();
  let cancelled = 0;
  await getDbClient().transaction(async () => {
    const children = latestForeachChildren(
      def,
      parentNodeId,
      await getWorkflowRunStepsByRunId(runId),
    );
    for (const child of children) {
      if (child.status !== "pending" && !isRetryPending(child)) continue;
      const row = await getDbClient().get<{ id: string }>(
        `UPDATE workflow_run_steps SET status = 'cancelled', error = ?, finishedAt = ?, nextRetryAt = NULL
          WHERE id = ? AND (status = 'pending' OR (status = 'failed' AND nextRetryAt IS NOT NULL))
          RETURNING id`,
        [error, finishedAt, child.id],
      );
      if (row) cancelled++;
    }
  });
  return cancelled;
}

async function hasQueuedChild(
  def: WorkflowDefinition,
  runId: string,
  parentNodeId: string,
): Promise<boolean> {
  return latestForeachChildren(def, parentNodeId, await getWorkflowRunStepsByRunId(runId)).some(
    (child) => child.status === "pending",
  );
}
