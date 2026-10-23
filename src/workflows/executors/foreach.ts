import { z } from "zod";
import { createForeachChildSteps } from "../../be/db/workflow-runs";
import type { ExecutorMeta } from "../../types";
import { FOREACH_ITEMS_WAIT_FOR } from "../constants";
import { getSuccessors } from "../definition";
import { foreachBodyTypeError } from "../foreach-body";
import {
  buildForeachAggregate,
  isForeachChildSettled,
  parseSyntheticNodeId,
} from "../foreach-join";
import { getMaxWorkflowStepsPerRun } from "../limits";
import type { AsyncExecutorResult, ExecutorResult } from "./base";
import { BaseExecutor } from "./base";

// Any registered executor except `foreach` (see foreach-body.ts); the guard in
// execute() and definition validation enforce the policy.
const ForeachBodySchema = z.object({
  type: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
});

export const ForeachConfigSchema = z.object({
  over: z.array(z.record(z.string(), z.unknown())),
  itemKey: z.string().min(1),
  body: ForeachBodySchema,
  /** Items in flight at once (`running` or `waiting` children). Unbounded when absent. */
  concurrency: z.number().int().min(1).optional(),
  /** Defaults from the workflow `onNodeFailure` (see effectiveFailurePolicy). */
  // Literal, not FOREACH_FAILURE_POLICIES: foreach-body.ts sits in an import
  // cycle with this module and would be read before it initializes.
  failurePolicy: z.enum(["fail-fast", "collect-outcomes"]).optional(),
});

const ForeachResultSchema = z.object({
  itemKey: z.string(),
  status: z.enum(["completed", "failed", "cancelled", "skipped"]),
  output: z.unknown().optional(),
});

export const ForeachOutputSchema = z.object({
  results: z.array(ForeachResultSchema),
  okCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  /** Items cancelled before they finished (fail-fast queued items, cancelled bodies). Counted in failedCount too. */
  cancelledCount: z.number().int().nonnegative().optional(),
});

export type ForeachOutput = z.infer<typeof ForeachOutputSchema>;

export class ForeachExecutor extends BaseExecutor<
  typeof ForeachConfigSchema,
  typeof ForeachOutputSchema
> {
  readonly type = "foreach";
  readonly mode = "async" as const;
  readonly configSchema = ForeachConfigSchema;
  readonly outputSchema = ForeachOutputSchema;

  protected async execute(
    config: z.infer<typeof ForeachConfigSchema>,
    _context: Readonly<Record<string, unknown>>,
    meta: ExecutorMeta,
  ): Promise<ExecutorResult<ForeachOutput>> {
    if (config.over.length === 0) {
      return {
        status: "success",
        output: { results: [], okCount: 0, failedCount: 0 },
      };
    }

    const items = config.over.map((item, index) => {
      const rawItemKey = item[config.itemKey];
      if (typeof rawItemKey !== "string" || rawItemKey.length === 0) {
        throw new Error(
          `foreach item at index ${index} is missing non-empty string itemKey property "${config.itemKey}"`,
        );
      }
      return { item, index, itemKey: rawItemKey };
    });

    const seenItemKeys = new Set<string>();
    for (const { itemKey } of items) {
      if (seenItemKeys.has(itemKey)) {
        throw new Error(`foreach itemKey "${itemKey}" is duplicated`);
      }
      seenItemKeys.add(itemKey);
    }

    const bodyTypeError = foreachBodyTypeError(meta.nodeId, config.body.type);
    if (bodyTypeError) return { status: "failed", error: bodyTypeError };

    const runSteps = await this.deps.db.getWorkflowRunStepsByRunId(meta.runId);
    const existingChildNodeIds = new Set(
      runSteps
        .filter((step) => parseSyntheticNodeId(step.nodeId)?.parentNodeId === meta.nodeId)
        .map((step) => step.nodeId),
    );
    const missingItems = items.filter(
      ({ itemKey }) => !existingChildNodeIds.has(`${meta.nodeId}#${itemKey}`),
    );
    const childCountToCreate = missingItems.length;
    const maxSteps = getMaxWorkflowStepsPerRun();
    // walkGraph's circuit breaker rejects any post-join walk once allSteps.length
    // >= maxSteps, so a fan-out with a successor that lands exactly on the cap would
    // spend all its child work and then fail routing. Reserve that headroom here,
    // before any child is dispatched — but only when there IS a post-join walk: a
    // terminal foreach (no successors) just closes the join and finalizes, so an
    // exact-cap fan-out is allowed there.
    const workflow = await this.deps.db.getWorkflow(meta.workflowId);
    const hasSuccessors = workflow
      ? getSuccessors(workflow.definition, meta.nodeId).length > 0
      : true;
    const totalSteps = runSteps.length + childCountToCreate;
    const capBreached = hasSuccessors ? totalSteps >= maxSteps : totalSteps > maxSteps;
    if (childCountToCreate > 0 && capBreached) {
      return {
        status: "failed",
        error: `foreach would reach ${maxSteps} total steps (WORKFLOW_MAX_STEPS_PER_RUN): ${runSteps.length} existing + ${childCountToCreate} children${hasSuccessors ? " leaves no room for the post-join walk" : " exceeds the per-run cap"}`,
      };
    }

    // Materialize EVERY child row, queued (`pending`), in one transaction and
    // before any child starts. An early child can complete (and trigger the
    // join) while later children are still being set up, so the join must
    // always see the full child set. The item value is not persisted: the
    // driver looks it up by key in the re-interpolated `over`, which keeps
    // resolved secrets out of step rows.
    await createForeachChildSteps(
      meta.runId,
      meta.nodeId,
      missingItems.map(({ index, itemKey }) => {
        const childNodeId = `${meta.nodeId}#${itemKey}`;
        return {
          id: crypto.randomUUID(),
          nodeId: childNodeId,
          nodeType: config.body.type,
          input: { itemKey, index, attempt: 0 },
          idempotencyKey: `${meta.runId}:${childNodeId}:0`,
        };
      }),
    );

    const childSteps = (await this.deps.db.getWorkflowRunStepsByRunId(meta.runId)).filter(
      (step) => parseSyntheticNodeId(step.nodeId)?.parentNodeId === meta.nodeId,
    );
    if (childSteps.every(isForeachChildSettled)) {
      return { status: "success", output: buildForeachAggregate(childSteps) };
    }

    // The engine parks the parent and the foreach driver starts the children.
    return {
      status: "success",
      async: true,
      waitFor: FOREACH_ITEMS_WAIT_FOR,
      correlationId: meta.stepId,
    } as AsyncExecutorResult<ForeachOutput>;
  }
}
