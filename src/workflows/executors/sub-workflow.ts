import { z } from "zod";
import { getChildWorkflowRunId, getWorkflowRunLineage } from "../../be/db/workflow-runs";
import type { ExecutorMeta, WorkflowRun } from "../../types";
import { startWorkflowExecution } from "../engine";
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

/** Run-context keys that are not node outputs. `input` can hold resolved secrets. */
const NON_NODE_CONTEXT_KEYS = new Set(["trigger", "input", "swarm", "workflow"]);

/**
 * The parent step's outcome for a child run: its result once the child
 * completed, an error once it failed, was cancelled or was skipped, and null
 * while it is still running or waiting.
 */
export function childRunOutcome(
  child: WorkflowRun,
): { output: SubWorkflowOutput } | { error: string } | null {
  if (child.status === "running" || child.status === "waiting") return null;
  if (child.status !== "completed") {
    const reason = child.error ? `: ${child.error}` : "";
    return { error: `Child workflow run ${child.id} ${child.status}${reason}` };
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
 * this step as its parent, so a re-executed step reconnects to it instead of
 * starting a second child. The resume path is `resumeFromChildRun`.
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

    const existingId = await getChildWorkflowRunId(meta.stepId);
    const existing = existingId ? await db.getWorkflowRun(existingId) : null;
    if (existing) return this.settle(existing);

    const lineage = await getWorkflowRunLineage(meta.runId);
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

    // Instant-only children finish inside this call; async ones return waiting.
    const childRunId = await startWorkflowExecution(workflow, config.inputs ?? {}, this.registry, {
      requestedByUserId: meta.requestedByUserId,
      parentStepId: meta.stepId,
    });
    const child = await db.getWorkflowRun(childRunId);
    if (!child) return { status: "failed", error: `Child workflow run ${childRunId} not found` };
    return this.settle(child);
  }

  private settle(child: WorkflowRun): ExecutorResult<SubWorkflowOutput> {
    const outcome = childRunOutcome(child);
    if (!outcome) {
      return {
        status: "success",
        async: true,
        waitFor: "workflow.child.finished",
        correlationId: child.id,
      } as unknown as ExecutorResult<SubWorkflowOutput>;
    }
    if ("error" in outcome) return { status: "failed", error: outcome.error };
    return { status: "success", output: outcome.output, nextPort: "success" };
  }
}
