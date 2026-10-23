import { z } from "zod";
import { getChildWorkflowRunId, getWorkflowRunLineage } from "../../be/db/workflow-runs";
import type { ExecutorMeta, WorkflowRun } from "../../types";
import { ParentStepNotCurrentError, startWorkflowExecution } from "../engine";
import type { ExecutorDependencies, ExecutorResult } from "./base";
import { BaseExecutor } from "./base";
import type { ExecutorRegistry } from "./registry";

// ─── Config / Output Schemas ────────────────────────────────

const SubWorkflowConfigSchema = z.object({
  workflowId: z.string().min(1).describe("Workflow to run as a child"),
  inputs: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Trigger data for the child run, validated against its triggerSchema"),
});

const SubWorkflowOutputSchema = z.object({
  runId: z.string(),
  /** The child's per-node outputs, keyed by node id. */
  outputs: z.record(z.string(), z.unknown()),
  /** Set when the child completed with a partial failure. */
  error: z.string().optional(),
});

type SubWorkflowOutput = z.infer<typeof SubWorkflowOutputSchema>;

/** Deepest child run a root run may start, counting the root as depth 0. */
export const MAX_SUB_WORKFLOW_DEPTH = 16;

/** Run-context keys that are not node outputs. `input` can hold resolved secrets. */
const NON_NODE_CONTEXT_KEYS = new Set(["trigger", "input", "swarm", "workflow"]);

/**
 * The parent step's outcome for a child run: its result once the child
 * completed, an error once it failed, was cancelled or was skipped, and null
 * while it is still running or waiting. Only a failed child is retryable: a
 * cancel or a skip is a decision, and a node retry must not override it. The
 * synchronous (executor) and the parked (`resumeFromChildRun`) paths both
 * apply this, so the same child end gets the same policy whenever it lands.
 */
export function childRunOutcome(
  child: WorkflowRun,
): { output: SubWorkflowOutput } | { error: string; retryable: boolean } | null {
  if (child.status === "running" || child.status === "waiting") return null;
  if (child.status !== "completed") {
    const reason = child.error ? `: ${child.error}` : "";
    return {
      error: `Child workflow run ${child.id} ${child.status}${reason}`,
      retryable: child.status === "failed",
    };
  }
  const outputs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(child.context ?? {})) {
    if (!NON_NODE_CONTEXT_KEYS.has(key)) outputs[key] = value;
  }
  return { output: { runId: child.id, outputs, error: child.error } };
}

// ─── Executor ───────────────────────────────────────────────

/**
 * Runs another workflow as a child run and waits for it. The child run records
 * this step and its attempt (`retryCount`) as its parent, so a re-executed or
 * recovered step reconnects to it instead of starting a second child, while a
 * retry starts a new one. The resume path is `resumeFromChildRun`.
 */
export class SubWorkflowExecutor extends BaseExecutor<
  typeof SubWorkflowConfigSchema,
  typeof SubWorkflowOutputSchema
> {
  readonly type = "sub-workflow";
  readonly mode = "async" as const;
  readonly configSchema = SubWorkflowConfigSchema;
  readonly outputSchema = SubWorkflowOutputSchema;

  constructor(
    deps: ExecutorDependencies,
    private readonly registry: ExecutorRegistry,
  ) {
    super(deps);
  }

  protected async execute(
    config: z.infer<typeof SubWorkflowConfigSchema>,
    _context: Readonly<Record<string, unknown>>,
    meta: ExecutorMeta,
  ): Promise<ExecutorResult<SubWorkflowOutput>> {
    const { db } = this.deps;

    // The retry poller re-executes a failed step under the same id with a
    // higher retryCount; that attempt must not settle on the previous child.
    const attempt = (await db.getWorkflowRunStep(meta.stepId))?.retryCount ?? 0;
    const existingId = await getChildWorkflowRunId(meta.stepId, attempt);
    const existing = existingId ? await db.getWorkflowRun(existingId) : null;
    if (existing) return this.settle(existing, config.workflowId);

    // Capped at the max depth, so a long chain fails closed instead of
    // hiding a cycle past the end of the scan.
    const lineage = await getWorkflowRunLineage(meta.runId, MAX_SUB_WORKFLOW_DEPTH);
    if (lineage.length > MAX_SUB_WORKFLOW_DEPTH) {
      return {
        status: "failed",
        error: `Sub-workflow nesting exceeds ${MAX_SUB_WORKFLOW_DEPTH} levels`,
      };
    }
    if (config.workflowId === meta.workflowId || lineage.includes(config.workflowId)) {
      return {
        status: "failed",
        error: `Sub-workflow recursion: workflow ${config.workflowId} is already running in this run's ancestry`,
      };
    }

    const workflow = await db.getWorkflow(config.workflowId);
    if (!workflow) return { status: "failed", error: `Workflow ${config.workflowId} not found` };
    if (!workflow.enabled) {
      return { status: "failed", error: `Workflow ${config.workflowId} is disabled` };
    }

    // Returns once the child run exists; the child walks on its own. A child
    // that already ended (cooldown, readiness, input failure) settles here,
    // and a concurrent execution of this attempt gets the child it created.
    let childRunId: string;
    try {
      childRunId = await startWorkflowExecution(workflow, config.inputs ?? {}, this.registry, {
        requestedByUserId: meta.requestedByUserId,
        parentStepId: meta.stepId,
        parentStepAttempt: attempt,
      });
    } catch (err) {
      if (err instanceof ParentStepNotCurrentError) return { status: "failed", error: err.message };
      throw err;
    }
    const child = await db.getWorkflowRun(childRunId);
    if (!child) return { status: "failed", error: `Child workflow run ${childRunId} not found` };
    return this.settle(child, config.workflowId);
  }

  private settle(child: WorkflowRun, workflowId: string): ExecutorResult<SubWorkflowOutput> {
    // The attempt already started a child of another workflow (the config
    // changed under a recovered step). That is a conflict, not a reason to
    // start a replacement next to it.
    if (child.workflowId !== workflowId) {
      return {
        status: "failed",
        error: `Child workflow run ${child.id} runs workflow ${child.workflowId}, not ${workflowId}`,
      };
    }
    const outcome = childRunOutcome(child);
    if (!outcome) {
      return {
        status: "success",
        async: true,
        waitFor: "workflow.child.finished",
        correlationId: child.id,
      } as ExecutorResult<SubWorkflowOutput>;
    }
    if ("error" in outcome) {
      return { status: "failed", error: outcome.error, retryable: outcome.retryable };
    }
    return { status: "success", output: outcome.output, nextPort: "success" };
  }
}
