import { createWorkflowVersion, getWorkflow, getWorkflowVersions } from "../be/db";
import type { WorkflowSnapshot, WorkflowVersion } from "../types";

/**
 * Create a version snapshot of a workflow's current state.
 *
 * Call this BEFORE applying an update to preserve the pre-update state.
 *
 * 1. Load current workflow state
 * 2. Get max version number for this workflow
 * 3. Insert workflow_versions row with version+1 and full snapshot
 */
export function snapshotWorkflow(workflowId: string, changedByAgentId?: string): WorkflowVersion {
  const workflow = getWorkflow(workflowId);
  if (!workflow) {
    throw new Error(`Workflow ${workflowId} not found — cannot create snapshot`);
  }

  // Get existing versions to determine next version number
  const existingVersions = getWorkflowVersions(workflowId);
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
