import { getUserById } from "../be/db";
import { getAgentById } from "../be/db/agents";
import { getRunWorkflow } from "../be/db/workflow-run-definitions";
import { getWorkflowRunParent, getWorkflowRunPrincipalRow } from "../be/db/workflow-runs";
import type { Workflow } from "../types";
import type { HttpRequestAuth } from "../utils/request-auth-context";

export type WorkflowRunPrincipal =
  | { ok: true; agentId?: string; userId?: string; operator?: boolean }
  | { ok: false; error: string };

const untrusted = (): WorkflowRunPrincipal => ({
  ok: false,
  error: "Workflow execution requires a trusted principal",
});

/** Older SDK clients label system runs with a synthetic agent header. */
export function workflowTriggerAgentId(auth: HttpRequestAuth | null | undefined, agentId?: string) {
  if (
    auth?.kind === "operator" &&
    auth.tokenId &&
    (agentId === "workflow" || agentId === "schedule")
  )
    return undefined;
  return agentId;
}

/** Convert verified request authentication at the entry point, before background work starts. */
export function workflowRequestPrincipal(
  auth: HttpRequestAuth | null | undefined,
  operatorAgentId?: string,
): WorkflowRunPrincipal {
  if (auth?.kind === "user") return { ok: true, userId: auth.userId };
  if (auth?.kind === "agent") {
    if (!(Date.parse(auth.expiresAt) > Date.now())) return untrusted();
    return { ok: true, agentId: auth.agentId };
  }
  if (auth?.kind === "operator")
    return operatorAgentId ? { ok: true, agentId: operatorAgentId } : { ok: true, operator: true };
  return untrusted();
}

async function verifyPrincipal(principal: WorkflowRunPrincipal): Promise<WorkflowRunPrincipal> {
  if (!principal.ok) return principal;
  const count =
    Number(!!principal.agentId) + Number(!!principal.userId) + Number(principal.operator === true);
  if (count !== 1) return untrusted();
  if (principal.agentId && !(await getAgentById(principal.agentId))) return untrusted();
  if (principal.userId) {
    const user = await getUserById(principal.userId);
    if (!user || user.status !== "active" || user.mergedIntoUserId) return untrusted();
  }
  return principal;
}

/** Decide from explicit server authority and the definition pinned by this run. */
export async function decideWorkflowRunPrincipal(
  workflow: Workflow | null,
  triggeredByAgentId: string | null | undefined,
  authority?: WorkflowRunPrincipal,
): Promise<WorkflowRunPrincipal> {
  const creator = workflow?.createdByAgentId;
  const knownAgent = triggeredByAgentId ?? creator;
  const trusted = await verifyPrincipal(
    authority ?? (knownAgent ? { ok: true, agentId: knownAgent } : untrusted()),
  );
  if (!trusted.ok) return trusted;
  if (creator) {
    if (!(await getAgentById(creator))) return untrusted();
    const editor = workflow.updatedByAgentId;
    if (editor && editor !== creator && !(await getAgentById(editor))?.isLead) {
      return {
        ok: false,
        error: `Workflow "${workflow.name}" was edited by another agent. Its creator or a lead must save it before execution.`,
      };
    }
    return trusted.userId ? trusted : { ok: true, agentId: creator };
  }
  if (trusted.userId || trusted.agentId) return trusted;
  if (triggeredByAgentId) return verifyPrincipal({ ok: true, agentId: triggeredByAgentId });
  if (workflow?.createdBy) return verifyPrincipal({ ok: true, userId: workflow.createdBy });
  return trusted;
}

/** Recover only identities supported by server-stamped run facts. Never read ambient request identity. */
export async function resolveWorkflowRunPrincipal(
  workflow: Workflow | null,
  runId: string,
  ancestors: readonly string[] = [],
): Promise<WorkflowRunPrincipal> {
  if (ancestors.includes(runId) || ancestors.length > 16) return untrusted();
  const row = await getWorkflowRunPrincipalRow(runId);
  if (!row) return untrusted();
  if (row.principal) {
    try {
      const stored = JSON.parse(row.principal) as WorkflowRunPrincipal;
      if (stored.ok === false && typeof stored.error === "string") return stored;
      if (stored.ok !== true) return untrusted();
      if (stored.agentId || stored.userId || stored.operator !== undefined)
        return verifyPrincipal(stored);
      // Older runs persisted {ok:true} for agentless executions.
    } catch {
      return { ok: false, error: "The run's stored principal is unreadable" };
    }
  }
  if (
    workflow?.createdByAgentId &&
    !(Date.parse(workflow.lastUpdatedAt) <= Date.parse(row.startedAt))
  ) {
    return {
      ok: false,
      error:
        "Historical workflow authority is ambiguous because the workflow changed after the run started",
    };
  }
  if (row.parentStepId) {
    const parent = await getWorkflowRunParent(row.parentStepId);
    if (!parent) return untrusted();
    const parentWorkflow = await getRunWorkflow({
      id: parent.runId,
      workflowId: parent.workflowId,
    });
    const authority = await resolveWorkflowRunPrincipal(parentWorkflow, parent.runId, [
      ...ancestors,
      runId,
    ]);
    return decideWorkflowRunPrincipal(workflow, row.triggeredByAgentId, authority);
  }
  if (workflow?.createdByAgentId || row.triggeredByAgentId) {
    return decideWorkflowRunPrincipal(workflow, row.triggeredByAgentId, {
      ok: true,
      operator: true,
    });
  }
  // Audit attribution can restrict a historical run to a user. It cannot grant operator authority.
  const userId = workflow?.createdBy ?? row.createdBy;
  if (userId) return verifyPrincipal({ ok: true, userId });
  if (row.triggerType === "event" || row.triggerType === "schedule") {
    return { ok: true, operator: true };
  }
  return {
    ok: false,
    error:
      "Historical workflow run has ambiguous authority: no verified owner, starting agent, or server event/schedule trigger",
  };
}
