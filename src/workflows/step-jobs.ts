import { getRunWorkflow, getWorkflowRun, getWorkflowRunStep, updateWorkflowRun } from "../be/db";
import { getRunLineageBlock } from "../be/db/workflow-runs";
import { scriptRunnerSessions } from "../be/script-runners/sessions";
import { getStorage } from "../be/storage";
import type { ExecutorMeta } from "../types";
import type { AsyncExecutorResult } from "./executors/base";
import { resolveForeachParent } from "./foreach-join";

export function shouldParkScriptNode(): boolean {
  return (
    getStorage().capabilities.scriptRunners &&
    (scriptRunnerSessions.size > 0 ||
      (process.env.SCRIPT_EMBEDDED_RUNNER_SLOTS !== undefined &&
        Number(process.env.SCRIPT_EMBEDDED_RUNNER_SLOTS) === 0))
  );
}

/** Commit the waiting step, reference-only job and wake-up together. */
export async function parkStepJob<T = never>(
  kind: string,
  meta: ExecutorMeta,
  _context: Readonly<Record<string, unknown>>,
): Promise<AsyncExecutorResult<T>> {
  const id = crypto.randomUUID();
  const storage = getStorage();
  await storage.transaction(async () => {
    const step = await getWorkflowRunStep(meta.stepId);
    const run = await getWorkflowRun(meta.runId);
    if (
      !step ||
      !run ||
      (await getRunLineageBlock(meta.runId)) ||
      !(await storage.repos.workflows.parkRunningStep(meta.runId, meta.stepId))
    )
      throw new Error("Workflow step no longer accepts a job");
    const workflow = await getRunWorkflow(run);
    if (
      workflow &&
      !resolveForeachParent(workflow.definition, step.nodeId) &&
      run.status === "running"
    )
      await updateWorkflowRun(run.id, { status: "waiting" });
    const saved = { ...((step.input ?? {}) as Record<string, unknown>) };
    if (step.retryCount === 0) delete saved._stepJobReferences;
    await storage.repos.workflows.updateStepColumns(step.id, { input: JSON.stringify(saved) });
    const now = new Date().toISOString();
    await storage.repos.workflowStepJobs.insert({
      id,
      runId: meta.runId,
      stepId: meta.stepId,
      attempt: step.retryCount,
      kind,
      status: "queued",
      ownerId: null,
      leaseExpiresAt: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      createdBy: null,
      updatedBy: null,
    });
    await storage.executionBus!.publish("workflow.step_job.requested", { jobId: id });
  });
  return {
    status: "success",
    async: true,
    waitFor: "workflow.step_job.finished",
    correlationId: id,
  };
}
