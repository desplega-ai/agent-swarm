import { getAgentById } from "../be/db/agents";
import { getWorkflowRunTriggeredByAgentId } from "../be/db/workflow-runs";
import type { Workflow } from "../types";

export type WorkflowRunPrincipal = { ok: true; agentId?: string } | { ok: false; error: string };

/**
 * The agent a run's `swarm-script` and `sub-workflow` nodes act as: the
 * workflow's creator, else the agent the server stamped on the run. Any agent
 * can edit a workflow, so the creator's identity holds only while the last
 * edit came from the creator, a lead, or a person (no agent).
 */
export async function resolveWorkflowRunPrincipal(
  workflow: Workflow | null,
  runId: string,
): Promise<WorkflowRunPrincipal> {
  const creator = workflow?.createdByAgentId;
  if (!creator) {
    return { ok: true, agentId: (await getWorkflowRunTriggeredByAgentId(runId)) ?? undefined };
  }
  const editor = workflow.updatedByAgentId;
  if (!editor || editor === creator || (await getAgentById(editor))?.isLead) {
    return { ok: true, agentId: creator };
  }
  return {
    ok: false,
    error:
      `workflow "${workflow.name}" was last edited by agent ${editor}, not by its creator ${creator}. ` +
      "Its swarm-script and sub-workflow nodes run as the creator, so they stay blocked until the creator or a lead saves the workflow again.",
  };
}
