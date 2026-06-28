/**
 * Linear assignment-time gating: decides whether an incoming AgentSessionEvent
 * should trigger swarm task creation based on the issue's workflow state and
 * labels.
 *
 * Rules:
 * - The set of allowed `WorkflowState.type` values is configurable via
 *   `LINEAR_ALLOWED_STATES` (CSV). Default: `unstarted,started,completed,canceled`,
 *   which matches Linear's enum minus `triage` and `backlog` ("tracked but not
 *   ready").
 * - The override label name is configurable via `LINEAR_SWARM_READY_LABEL`.
 *   Default: `swarm-ready`. Matching is case-insensitive.
 * - If the state cannot be resolved (null), default to allow (fail-open) so
 *   assignments aren't silently swallowed by missing data.
 */

export const DEFAULT_SWARM_READY_LABEL = "swarm-ready";
export const DEFAULT_ALLOWED_STATE_TYPES = [
  "unstarted",
  "started",
  "completed",
  "canceled",
] as const;

/** Backwards-compat alias kept so tests can reference the default override label. */
export const SWARM_READY_LABEL = DEFAULT_SWARM_READY_LABEL;

export interface LinearGateConfig {
  /** Lowercased `WorkflowState.type` values that should trigger task creation. */
  allowedStateTypes: Set<string>;
  /** Lowercased label name that bypasses the state gate. */
  swarmReadyLabel: string;
}

export interface LinearGateInput {
  /** Linear `WorkflowState.type` value. Null if unknown. */
  stateType: string | null;
  /** Names of labels attached to the issue. Case-insensitive matching. */
  labelNames: string[];
}

export type LinearGateDecision =
  | { create: true; reason: "ready" | "label-override" }
  | { create: false; reason: string };

/**
 * Resolve the gate config from environment variables, with sensible defaults.
 * Read on each call so tests / runtime overrides are picked up without restart.
 */
export function getLinearGateConfig(): LinearGateConfig {
  const statesEnv = process.env.LINEAR_ALLOWED_STATES;
  const allowedStateTypes = parseStateList(statesEnv);

  const labelEnv = process.env.LINEAR_SWARM_READY_LABEL?.trim();
  const swarmReadyLabel = (
    labelEnv && labelEnv.length > 0 ? labelEnv : DEFAULT_SWARM_READY_LABEL
  ).toLowerCase();

  return { allowedStateTypes, swarmReadyLabel };
}

function parseStateList(csv: string | undefined): Set<string> {
  if (csv === undefined) {
    return new Set(DEFAULT_ALLOWED_STATE_TYPES);
  }
  // An explicit empty value locks down all states (only label override works).
  return new Set(
    csv
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

/**
 * Pure decision function: should this Linear assignment create a swarm task?
 *
 * Exported separately from the side-effecting webhook handler so it can be
 * unit-tested without spinning up the DB or Linear API. Config is injectable
 * for tests; production callers can rely on the env-driven default.
 */
export function shouldCreateTaskFromLinearEvent(
  input: LinearGateInput,
  config: LinearGateConfig = getLinearGateConfig(),
): LinearGateDecision {
  const labelMatch = config.swarmReadyLabel;
  const hasReadyLabel = input.labelNames.some((name) => name.trim().toLowerCase() === labelMatch);
  if (hasReadyLabel) {
    return { create: true, reason: "label-override" };
  }

  const stateType = input.stateType?.toLowerCase() ?? null;
  // Fail-open: if we couldn't resolve the state, default to today's behavior
  // rather than silently swallowing assignments.
  if (stateType === null) {
    return { create: true, reason: "ready" };
  }
  if (!config.allowedStateTypes.has(stateType)) {
    return { create: false, reason: stateType };
  }
  return { create: true, reason: "ready" };
}

/**
 * Build the user-facing message posted on a skipped Linear assignment.
 */
export function buildSkipMessage(
  reason: string,
  swarmReadyLabel: string = getLinearGateConfig().swarmReadyLabel,
): string {
  const stateLabel = titleCase(reason);
  return [
    `Agent Swarm received the assignment but skipped — this issue is in ${stateLabel}.`,
    "",
    `To trigger work, move it to an allowed workflow state (e.g. **Todo** or **In Progress**), or add the \`${swarmReadyLabel}\` label and re-assign the agent.`,
  ].join("\n");
}

function titleCase(s: string): string {
  if (s.length === 0) return s;
  return (s[0] ?? "").toUpperCase() + s.slice(1);
}
