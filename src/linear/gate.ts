/**
 * Linear assignment-time gating: decides whether an incoming AgentSessionEvent
 * should trigger swarm task creation based on the issue's workflow state and
 * labels.
 *
 * Rules:
 * - Issues in `triage` or `backlog` workflow states are SKIPPED (treated as
 *   "tracked but not ready").
 * - The `swarm-ready` label (case-insensitive) overrides the state gate so
 *   users can pre-stage backlog issues to auto-trigger when assigned.
 * - All other states (unstarted/Todo, started/In Progress, completed,
 *   canceled) trigger as today.
 */

export const SWARM_READY_LABEL = "swarm-ready";

const GATED_STATE_TYPES = new Set(["triage", "backlog"]);

export interface LinearGateInput {
  /** Linear `WorkflowState.type` value, lowercased. Null if unknown. */
  stateType: string | null;
  /** Names of labels attached to the issue. Case is preserved; matching is case-insensitive. */
  labelNames: string[];
}

export type LinearGateDecision =
  | { create: true; reason: "ready" | "label-override" }
  | { create: false; reason: "backlog" | "triage" };

/**
 * Pure decision function: should this Linear assignment create a swarm task?
 *
 * Exported separately from the side-effecting webhook handler so it can be
 * unit-tested without spinning up the DB or Linear API.
 */
export function shouldCreateTaskFromLinearEvent(input: LinearGateInput): LinearGateDecision {
  const hasReadyLabel = input.labelNames.some(
    (name) => name.trim().toLowerCase() === SWARM_READY_LABEL,
  );
  if (hasReadyLabel) {
    return { create: true, reason: "label-override" };
  }

  const stateType = input.stateType?.toLowerCase() ?? null;
  if (stateType && GATED_STATE_TYPES.has(stateType)) {
    return { create: false, reason: stateType as "backlog" | "triage" };
  }

  return { create: true, reason: "ready" };
}

/**
 * Build the user-facing message posted on a skipped Linear assignment.
 */
export function buildSkipMessage(reason: "backlog" | "triage"): string {
  const stateLabel = reason === "backlog" ? "Backlog" : "Triage";
  return [
    `Agent Swarm received the assignment but skipped — this issue is in ${stateLabel}.`,
    "",
    `To trigger work, move it to **Todo** (or **In Progress**), or add the \`${SWARM_READY_LABEL}\` label and re-assign the agent.`,
  ].join("\n");
}
