import { renderAutomationTokens } from "../be/automation-preflight";
import {
  detachTaskFromWorkflowRunStep,
  getDbClient,
  getLatestStepForNode,
  getTaskByWorkflowRunStepId,
  getWorkflow,
  getWorkflowRun,
  getWorkflowRunStep,
  getWorkflowRunStepsByRunId,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import { getRunLineageBlock, getWorkflowRunStatus } from "../be/db/workflow-runs";
import type {
  Workflow,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowRun,
  WorkflowRunStep,
} from "../types";
import { checkpointStepWaiting } from "./checkpoint";
import { FOREACH_ITEMS_WAIT_FOR } from "./constants";
import {
  hasRunningStep,
  holdWorkflowRun,
  interpolateNodeConfig,
  scriptBodyInterpolationError,
  walkGraph,
} from "./engine";
import type { AsyncExecutorResult } from "./executors/base";
import { ForeachConfigSchema } from "./executors/foreach";
import type { ExecutorRegistry } from "./executors/registry";
import { systemOneUnresolvedError } from "./executors/system-one-decision";
import {
  effectiveFailurePolicy,
  foreachConcurrencyCap,
  isForeachBodyType,
  resolveStepNode,
} from "./foreach-body";
import {
  cancelQueuedForeachChildren,
  FOREACH_TERMINAL_STEP_STATUSES,
  type ForeachChildOutcome,
  isRetryPending,
  latestForeachChildren,
  settleForeachChild,
} from "./foreach-join";
import { getSecretInputKeys } from "./input";
import { resolveNodeTimeoutMs } from "./node-timeout";
import { rebuildNodeExecutionInput } from "./step-input";

export { FOREACH_ITEMS_WAIT_FOR };

/**
 * Child step ids a drive in this process is starting right now. A `running`
 * child outside this set has no owner: a crash (or a lost drive) left it
 * between its claim and its settlement, and the next drive restarts it.
 */
const ownedChildren = new Set<string>();

/** Fire-and-forget drives, tracked so tests and shutdown can drain them. */
const activeDrives = new Set<Promise<void>>();

export interface ForeachDriveResult {
  /** True when a settlement in this drive closed the join. */
  joined: boolean;
  /** The parent's successors to walk, when `joined`. */
  successors: WorkflowNode[];
  /** How many children this drive claimed (queued or orphaned). */
  claimed: number;
}

const NOT_JOINED: ForeachDriveResult = { joined: false, successors: [], claimed: 0 };

export function isForeachChildOwned(stepId: string): boolean {
  return ownedChildren.has(stepId);
}

/** Drop in-process child ownership, as a restart would. Tests only. */
export function _resetForeachOwnershipForTests(): void {
  ownedChildren.clear();
}

/**
 * Park a foreach parent whose executor materialized its children, then drive
 * them. The run stays `running` while the drive starts the children; when the
 * join stays open it parks as `waiting` like any async step. Shared by
 * executeStep and the retry poller.
 */
export async function parkAndDriveForeach(input: {
  runId: string;
  stepId: string;
  parentNodeId: string;
  ctx: Record<string, unknown>;
  registry: ExecutorRegistry;
}): Promise<ForeachDriveResult & { parked: boolean }> {
  // A re-walk of an open fan-out (a run retry, recovery) reuses a parent step
  // that is already parked: drive it as it is.
  const parked =
    (await checkpointStepWaiting(input.runId, input.stepId, input.ctx, {
      keepRunStatus: true,
    })) || (await getWorkflowRunStep(input.stepId))?.status === "waiting";
  if (!parked) return { ...NOT_JOINED, parked: false };
  const drive = await driveForeach(input.runId, input.parentNodeId, input.registry, {
    ctx: input.ctx,
  });
  if (!drive.joined) await parkRunIfRunning(input.runId);
  return { ...drive, parked: true };
}

/**
 * Claim and start the children of foreach `parentNodeId` that are free to
 * run: queued (`pending`) children up to the cap, plus orphaned `running`
 * children no drive owns. Instant bodies run and settle here, each against its
 * own watchdog budget. Async bodies park, and their own resume path settles
 * them through `settleForeachChild`.
 *
 * Idempotent: the claim flips each child out of `pending` in a `BEGIN
 * IMMEDIATE` transaction, and every async executor dedupes on the child step
 * id, so a repeated drive never duplicates a task, child run or approval.
 */
export async function driveForeach(
  runId: string,
  parentNodeId: string,
  registry: ExecutorRegistry,
  options: { ctx?: Record<string, unknown> } = {},
): Promise<ForeachDriveResult> {
  const run = await getWorkflowRun(runId);
  if (!run || (run.status !== "running" && run.status !== "waiting")) return NOT_JOINED;
  const workflow = await getRenderedWorkflow(run.workflowId);
  if (!workflow) return NOT_JOINED;
  const def = workflow.definition;
  const parentNode = def.nodes.find((node) => node.id === parentNodeId);
  if (!parentNode || parentNode.type !== "foreach") return NOT_JOINED;
  const parentStep = await getLatestStepForNode(runId, parentNodeId);
  if (!parentStep || FOREACH_TERMINAL_STEP_STATUSES.has(parentStep.status)) return NOT_JOINED;

  const body = parentNode.config.body as { type?: unknown } | undefined;
  const bodyType = typeof body?.type === "string" ? body.type : "";
  // Rebuilt once, on the first claim: most drives (a settlement with nothing
  // queued behind it) claim nothing and never pay for the context rebuild.
  let parentInput: Awaited<ReturnType<typeof loadParentInput>> | undefined;
  let claimedTotal = 0;
  const notJoined = (): ForeachDriveResult => ({ ...NOT_JOINED, claimed: claimedTotal });

  for (;;) {
    const current = await getWorkflowRun(runId);
    if (!current || (current.status !== "running" && current.status !== "waiting")) {
      return notJoined();
    }
    const claimed = await claimChildren(def, runId, parentNode);
    if (claimed.length === 0) return notJoined();
    claimedTotal += claimed.length;
    const started = new Set<string>();
    let failedFast: string | undefined;
    try {
      parentInput ??= await loadParentInput(def, run, parentNode, registry, workflow.id, options);
      const { ctx, items, itemKeyField, meta } = parentInput;
      for (const child of claimed) {
        // An earlier body in this batch can run for a long time. A cancel (of
        // the run or this child) that landed meanwhile must stop the rest of
        // the batch before it reaches an executor. A fail-fast failure of a
        // sibling elsewhere ends the run too; `finally` cancels the rest.
        const liveness = await childLiveness(runId, child.id);
        if (liveness === "run-ended") return notJoined();
        if (liveness === "child-ended") continue;
        started.add(child.id);
        const outcome = await startChild({
          def,
          child,
          registry,
          ctx,
          meta,
          bodyType,
          item: items.find((candidate) => candidate[itemKeyField] === childItemKey(child)),
        });
        if (!outcome) continue;
        const settled = await settleForeachChild(def, runId, child.id, outcome, ctx, {
          from: ["running"],
        });
        ownedChildren.delete(child.id);
        if (settled.joined) {
          return { joined: true, successors: settled.successors, claimed: claimedTotal };
        }
        if (settled.runFailed) {
          failedFast = child.nodeId;
          return notJoined();
        }
      }
    } finally {
      // A child claimed but never started (an earlier sibling failed the run,
      // or the input rebuild threw) goes back to the queue, so a run retry
      // starts it. After a fail-fast failure it is cancelled with the rest of
      // the queue instead: it never started.
      for (const child of claimed) {
        ownedChildren.delete(child.id);
        if (!started.has(child.id)) await requeueChild(child.id);
      }
      if (
        effectiveFailurePolicy(parentNode, def) === "fail-fast" &&
        (failedFast || (await getWorkflowRun(runId))?.status === "failed")
      ) {
        await cancelQueuedForeachChildren(def, runId, parentNodeId, failedFast);
      }
    }
  }
}

/**
 * The parent's execution input, rebuilt from persisted state the way the walk
 * built it. Items are looked up by key in the re-interpolated `over`, never
 * persisted on the child row, so resolved secrets stay out of step rows.
 */
async function loadParentInput(
  def: WorkflowDefinition,
  run: WorkflowRun,
  parentNode: WorkflowNode,
  registry: ExecutorRegistry,
  workflowId: string,
  options: { ctx?: Record<string, unknown> },
) {
  const input = await rebuildNodeExecutionInput(def, run, parentNode, registry, {
    ctx: options.ctx,
  });
  const parsed = ForeachConfigSchema.safeParse(input.config);
  return {
    ctx: input.ctx,
    items: parsed.success ? parsed.data.over : [],
    itemKeyField: parsed.success ? parsed.data.itemKey : "",
    meta: {
      runId: run.id,
      workflowId,
      dryRun: false,
      requestedByUserId: run.createdBy,
      inputCtx: input.inputCtx,
    },
  };
}

/**
 * Start a drive without awaiting it. When it closes the join, it walks the
 * parent's successors (or finalizes); otherwise it parks the run if nothing is
 * left running. Errors are logged.
 */
export function startForeachDrive(
  runId: string,
  parentNodeId: string,
  registry: ExecutorRegistry,
): void {
  const drive = runForeachDrive(runId, parentNodeId, registry)
    .then(() => undefined)
    .catch((err) => {
      console.error(`[workflows] foreach drive of ${parentNodeId} in run ${runId} failed:`, err);
    })
    .finally(() => {
      activeDrives.delete(drive);
    });
  activeDrives.add(drive);
}

/**
 * Drive a fan-out outside a live walk and route what it closes. Holds the run
 * for the duration so the running-run recovery leaves it alone. Returns true
 * when the drive started or settled at least one child.
 */
export async function runForeachDrive(
  runId: string,
  parentNodeId: string,
  registry: ExecutorRegistry,
): Promise<ForeachDriveResult> {
  const release = holdWorkflowRun(runId);
  try {
    const drive = await driveForeach(runId, parentNodeId, registry);
    if (!drive.joined) {
      await parkRunIfRunning(runId);
      return drive;
    }
    const run = await getWorkflowRun(runId);
    const workflow = run ? await getRenderedWorkflow(run.workflowId) : null;
    if (!run || !workflow) return drive;
    const ctx = (run.context ?? {}) as Record<string, unknown>;
    if (drive.successors.length > 0) {
      await walkGraph(
        workflow.definition,
        runId,
        ctx,
        drive.successors,
        registry,
        workflow.id,
        getSecretInputKeys(workflow.input),
      );
    } else {
      const { finalizeOrWait } = await import("./resume");
      await finalizeOrWait(runId);
    }
    return drive;
  } finally {
    release();
  }
}

/** Wait for every fire-and-forget drive, including drives they start. */
export async function drainForeachDrives(): Promise<void> {
  while (activeDrives.size > 0) {
    await Promise.allSettled([...activeDrives]);
  }
}

/**
 * The run's workflow with its install params rendered in, as
 * startWorkflowExecution rendered it before the walk. The driver and its
 * post-join walk reload the definition, so without this a `{{PARAM}}` token in
 * the body config or in `over` would reach the per-item pass unresolved.
 */
async function getRenderedWorkflow(workflowId: string): Promise<Workflow | null> {
  const workflow = await getWorkflow(workflowId);
  return workflow ? renderAutomationTokens(workflow, workflow.params ?? {}) : null;
}

/** Whether a claimed child may still start: its run is live and its row is still claimed. */
async function childLiveness(
  runId: string,
  stepId: string,
): Promise<"live" | "run-ended" | "child-ended"> {
  const run = await getWorkflowRun(runId);
  if (!run || (run.status !== "running" && run.status !== "waiting")) return "run-ended";
  const step = await getWorkflowRunStep(stepId);
  return step?.status === "running" ? "live" : "child-ended";
}

async function requeueChild(stepId: string): Promise<void> {
  await getDbClient().run(
    "UPDATE workflow_run_steps SET status = 'pending' WHERE id = ? AND status = 'running'",
    [stepId],
  );
}

/**
 * Park a `running` run as `waiting` once nothing in it is executing and a step
 * is waiting. Never completes the run: a drive that did not close the join
 * must not finalize a run whose joiner is still walking the successors.
 */
async function parkRunIfRunning(runId: string): Promise<void> {
  await getDbClient().transaction(async () => {
    const run = await getWorkflowRun(runId);
    if (run?.status !== "running") return;
    const steps = await getWorkflowRunStepsByRunId(runId);
    if (hasRunningStep(steps)) return;
    if (!steps.some((step) => step.status === "waiting")) return;
    await updateWorkflowRun(runId, { status: "waiting" });
  });
}

/**
 * Flip `pending` children to `running`, in item order, while fewer than the
 * fan-out's `concurrency` cap are in flight (`running`, `waiting` or queued
 * for a retry, latest attempt rows only), and collect unowned `running` ones. Ownership is registered before commit, so no other
 * drive can see a claimed row without also seeing it owned.
 */
async function claimChildren(
  def: WorkflowDefinition,
  runId: string,
  parentNode: WorkflowNode,
): Promise<WorkflowRunStep[]> {
  const claimed: WorkflowRunStep[] = [];
  try {
    // The in-flight count and the claim share one BEGIN IMMEDIATE transaction,
    // so concurrent drives (a settlement's drive and the recovery sweep)
    // serialize here and never exceed the cap together.
    await getDbClient().transaction(async () => {
      // A cancel of the run (or of an ancestor) that committed first wins.
      const status = await getWorkflowRunStatus(runId);
      if (status !== "running" && status !== "waiting") return;
      if (await getRunLineageBlock(runId)) return;
      const children = latestForeachChildren(
        def,
        parentNode.id,
        await getWorkflowRunStepsByRunId(runId),
      );
      for (const child of children) {
        if (child.status === "running" && !ownedChildren.has(child.id)) {
          ownedChildren.add(child.id);
          claimed.push(child);
        }
      }
      const inFlight = children.filter(
        (child) =>
          child.status === "running" || child.status === "waiting" || isRetryPending(child),
      ).length;
      let free = foreachConcurrencyCap(parentNode) - inFlight;
      for (const child of children) {
        if (free <= 0) break;
        if (child.status !== "pending") continue;
        const row = await getDbClient().get<{ id: string }>(
          "UPDATE workflow_run_steps SET status = 'running' WHERE id = ? AND status = 'pending' RETURNING id",
          [child.id],
        );
        if (!row) continue;
        ownedChildren.add(child.id);
        claimed.push({ ...child, status: "running" });
        free--;
      }
    });
  } catch (err) {
    for (const child of claimed) ownedChildren.delete(child.id);
    throw err;
  }
  return claimed;
}

/**
 * Run one claimed child's body. Returns its terminal outcome, or null when it
 * parked (or another handler moved it on).
 */
async function startChild(input: {
  def: WorkflowDefinition;
  child: WorkflowRunStep;
  registry: ExecutorRegistry;
  ctx: Record<string, unknown>;
  meta: {
    runId: string;
    workflowId: string;
    dryRun: boolean;
    requestedByUserId?: string;
    inputCtx: Record<string, unknown>;
  };
  bodyType: string;
  item: Record<string, unknown> | undefined;
}): Promise<ForeachChildOutcome | null> {
  const { def, child, registry, ctx, meta, bodyType, item } = input;
  if (!item) {
    return {
      status: "failed",
      error: `item "${childItemKey(child)}" is no longer present in over`,
    };
  }
  if (!isForeachBodyType(bodyType, registry)) {
    return { status: "failed", error: `foreach body type "${bodyType}" cannot run` };
  }
  const bodyNode = resolveStepNode(def, child.nodeId);
  if (!bodyNode) return { status: "failed", error: `foreach child ${child.nodeId} has no body` };

  // The per-item pass interpolates against the parent's declared-inputs
  // context plus item/index, NOT the full run context, so the body obeys the
  // same explicit-dataflow boundary as a normal node. A script body keeps the
  // script-source allowlist: `item` reaches it through `args`, never source.
  const index = childIndex(child);
  const bodyCtx = { ...meta.inputCtx, item, index };
  const interpolation = interpolateNodeConfig(bodyNode, bodyCtx);
  if (interpolation.scriptBodyUnresolved && interpolation.scriptBodyUnresolved.length > 0) {
    return {
      status: "failed",
      error: scriptBodyInterpolationError(child.nodeId, interpolation.scriptBodyUnresolved),
    };
  }
  if (interpolation.strictUnresolved && interpolation.strictUnresolved.length > 0) {
    return {
      status: "failed",
      error: systemOneUnresolvedError(child.nodeId, interpolation.strictUnresolved, bodyType),
    };
  }
  if (interpolation.unresolved.length > 0) {
    console.warn(
      `[workflow] Step ${child.nodeId}: unresolved interpolation tokens: ${interpolation.unresolved.join(", ")}`,
    );
    await updateWorkflowRunStep(child.id, {
      diagnostics: JSON.stringify({ unresolvedTokens: interpolation.unresolved }),
    });
  }
  const config = interpolation.value as Record<string, unknown>;

  if (bodyType === "agent-task") {
    // A retried item needs a fresh task. Detaching the stale terminal task keeps
    // the executor's one-task-per-step de-duplication deterministic and scoped.
    const linkedTask = await getTaskByWorkflowRunStepId(child.id);
    if (linkedTask?.status === "failed" || linkedTask?.status === "cancelled") {
      await detachTaskFromWorkflowRunStep(linkedTask.id);
    }
  }

  const executor = registry.get(bodyType);
  const timeoutMs = resolveNodeTimeoutMs({ type: bodyType, config });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: Awaited<ReturnType<typeof executor.run>>;
  try {
    result = await Promise.race([
      executor.run({
        config,
        context: { ...ctx, ...bodyCtx },
        meta: { ...meta, stepId: child.id, nodeId: child.nodeId },
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Step timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (result.status === "failed") {
    return {
      status: "failed",
      error: result.error || "Executor returned failed status",
      ...(result.output !== undefined ? { output: result.output } : {}),
    };
  }

  if ("async" in result && (result as AsyncExecutorResult).async) {
    const parked = await getDbClient().get<{ id: string }>(
      "UPDATE workflow_run_steps SET status = 'waiting' WHERE id = ? AND status = 'running' RETURNING id",
      [child.id],
    );
    // A child run that finished before the item parked had its event dropped.
    if (parked && (result as AsyncExecutorResult).waitFor === "workflow.child.finished") {
      ownedChildren.delete(child.id);
      const { resumeFromChildRun } = await import("./resume");
      await resumeFromChildRun(child.id, registry);
    }
    return null;
  }

  return {
    status: "completed",
    output: bodyType === "agent-task" ? normalizeExistingTaskOutput(result.output) : result.output,
    ...(result.nextPort ? { nextPort: result.nextPort } : {}),
  };
}

function childItemKey(child: WorkflowRunStep): string | undefined {
  const input = child.input as Record<string, unknown> | null | undefined;
  return typeof input?.itemKey === "string" ? input.itemKey : undefined;
}

function childIndex(child: WorkflowRunStep): number {
  const input = child.input as Record<string, unknown> | null | undefined;
  return typeof input?.index === "number" ? input.index : 0;
}

/** An agent-task body that reconnected to an already-completed task. */
function normalizeExistingTaskOutput(output: unknown): unknown {
  if (typeof output !== "object" || output === null) return output;
  const record = output as Record<string, unknown>;
  if (typeof record.taskOutput !== "string") return output;
  try {
    const parsed = JSON.parse(record.taskOutput);
    if (typeof parsed === "object" && parsed !== null) {
      return { ...record, taskOutput: parsed };
    }
  } catch {
    // Non-structured task output remains a string.
  }
  return output;
}
