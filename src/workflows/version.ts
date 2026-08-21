import {
  createWorkflowVersion,
  getDbClient,
  getWorkflow,
  getWorkflowVersions,
  updateWorkflow,
} from "../be/db";
import type { Workflow, WorkflowSnapshot, WorkflowVersion } from "../types";

/**
 * Create a version snapshot of a workflow's current state.
 *
 * Call this BEFORE applying an update to preserve the pre-update state.
 *
 * 1. Load current workflow state
 * 2. Get max version number for this workflow
 * 3. Insert workflow_versions row with version+1 and full snapshot
 */
export async function snapshotWorkflow(
  workflowId: string,
  changedByAgentId?: string,
): Promise<WorkflowVersion> {
  const workflow = await getWorkflow(workflowId);
  if (!workflow) {
    throw new Error(`Workflow ${workflowId} not found — cannot create snapshot`);
  }

  // Get existing versions to determine next version number
  const existingVersions = await getWorkflowVersions(workflowId);
  const maxVersion = existingVersions.length > 0 ? existingVersions[0]!.version : 0;
  const nextVersion = maxVersion + 1;

  // Build snapshot of current state
  const snapshot: WorkflowSnapshot = {
    name: workflow.name,
    description: workflow.description,
    definition: workflow.definition,
    triggers: workflow.triggers,
    cooldown: workflow.cooldown,
    input: workflow.input,
    triggerSchema: workflow.triggerSchema,
    dir: workflow.dir,
    vcsRepo: workflow.vcsRepo,
    enabled: workflow.enabled,
  };

  return createWorkflowVersion({
    workflowId,
    version: nextVersion,
    snapshot,
    changedByAgentId,
  });
}

/**
 * Snapshot the current state and apply a full update as ONE client transaction.
 *
 * Both full-update paths (HTTP PUT and the update-workflow tool) previously
 * snapshotted outside any transaction. Two concurrent updates could read the
 * same max version, collide on the (workflowId, version) unique index, and
 * the loser applied its update with no snapshot preserved. Inside a client
 * transaction the FIFO lock spans read/allocate/insert/update, so version
 * allocation is race-free and every committed edit keeps its history row.
 *
 * With `snapshotOptional: true` a snapshot failure is swallowed and the
 * update still applies (the HTTP PUT contract); otherwise it propagates and
 * rolls the whole update back.
 */
export async function snapshotAndUpdateWorkflow(
  workflowId: string,
  updates: Parameters<typeof updateWorkflow>[1],
  opts: { changedByAgentId?: string; snapshotOptional: true },
): Promise<{ workflow: Workflow | null; version: WorkflowVersion | null }>;
export async function snapshotAndUpdateWorkflow(
  workflowId: string,
  updates: Parameters<typeof updateWorkflow>[1],
  opts?: { changedByAgentId?: string; snapshotOptional?: false },
): Promise<{ workflow: Workflow | null; version: WorkflowVersion }>;
export async function snapshotAndUpdateWorkflow(
  workflowId: string,
  updates: Parameters<typeof updateWorkflow>[1],
  opts: { changedByAgentId?: string; snapshotOptional?: boolean } = {},
): Promise<{ workflow: Workflow | null; version: WorkflowVersion | null }> {
  return await getDbClient().transaction(async () => {
    let version: WorkflowVersion | null = null;
    if (opts.snapshotOptional) {
      try {
        version = await snapshotWorkflow(workflowId, opts.changedByAgentId);
      } catch {
        // Snapshot failure must not block the update on this path.
      }
    } else {
      version = await snapshotWorkflow(workflowId, opts.changedByAgentId);
    }
    const workflow = await updateWorkflow(workflowId, updates);
    return { workflow, version };
  });
}
