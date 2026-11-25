import { getAgentById } from "../be/db/agents";
import { getWorkflowRunPrincipalRow } from "../be/db/workflow-runs";
import type { Workflow } from "../types";
import { getCurrentRequestAuth } from "../utils/request-auth-context";

export type WorkflowRunPrincipal =
  | { ok: true; agentId?: string; userId?: string; operator?: boolean }
  | { ok: false; error: string };

/**
 * The agent a run's `swarm-script` and `sub-workflow` nodes act as: the
 * workflow's creator, else the agent the server stamped on the run. Any agent
 * can edit a workflow, so the creator's identity holds only while the last
 * edit came from the creator, a lead, or a person (no agent).
 *
 * Pass the workflow exactly as the run pins it: the decision is stored on the
 * run row, so a later edit or re-save of the live row cannot change it.
 */
export async function decideWorkflowRunPrincipal(
  workflow: Workflow | null,
  triggeredByAgentId: string | null | undefined,
): Promise<WorkflowRunPrincipal> {
  const auth = getCurrentRequestAuth();
  if (auth?.kind === "guest" || auth?.kind === "controller")
    return { ok: false, error: "Workflow execution requires a trusted principal" };
  if (auth?.kind === "user") return { ok: true, userId: auth.userId };
  if (!triggeredByAgentId && auth?.kind === "agent") triggeredByAgentId = auth.agentId;
  if (!triggeredByAgentId && !auth && workflow?.createdBy)
    return { ok: true, userId: workflow.createdBy };
  const creator = workflow?.createdByAgentId;
  if (!creator)
    return { ok: true, agentId: triggeredByAgentId ?? undefined, operator: !triggeredByAgentId };
  const editor = workflow.updatedByAgentId;
  if (!editor || editor === creator || (await getAgentById(editor))?.isLead) {
    return { ok: true, agentId: creator };
  }
  return {
    ok: false,
    error:
      `workflow "${workflow.name}" was last edited by agent ${editor}, not by its creator ${creator}, when this run started. ` +
      "Its swarm-script and sub-workflow nodes run as the creator, so they stay blocked until the creator or a lead saves the workflow and a new run starts.",
  };
}

/**
 * The principal stored when the run pinned its definition. A run from before
 * migration 367 has none and decides from the live row, as it did before.
 */
export async function resolveWorkflowRunPrincipal(
  liveWorkflow: Workflow | null,
  runId: string,
): Promise<WorkflowRunPrincipal> {
  const row = await getWorkflowRunPrincipalRow(runId);
  if (!row?.principal) {
    if (!row?.triggeredByAgentId && !liveWorkflow?.createdByAgentId)
      return { ok: false, error: "Historical workflow run has no trusted execution principal" };
    return decideWorkflowRunPrincipal(liveWorkflow, row?.triggeredByAgentId);
  }
  try {
    const stored = JSON.parse(row.principal) as WorkflowRunPrincipal;
    if (stored.ok === true || (stored.ok === false && typeof stored.error === "string")) {
      return stored;
    }
  } catch {}
  return { ok: false, error: "the run's stored principal is unreadable" };
}
