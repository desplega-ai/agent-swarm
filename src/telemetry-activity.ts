/**
 * The hourly `org.activity` rollup: per-install counts of script runs,
 * human-in-the-loop requests and workflow steps, by kind and status.
 *
 * A busy install runs ~10k scripts and up to 60k workflow steps a day, so these
 * travel as in-memory counters flushed once an hour by the telemetry ticker
 * (and at shutdown), not as one event each. Counts and durations only: no
 * script names, sources, args, request content or IDs.
 *
 * API server only. Workers never import this file.
 */

import { isTelemetryEnabled, isTelemetryReady, telemetry } from "./telemetry";
import type { PropsFor } from "./telemetry-contract";

export type OrgActivity = PropsFor<"org.activity">;

/** What started a script execution. `other`: app actions, API endpoints, durable objects, task gates. */
export type ScriptRunTrigger = "task" | "workflow_node" | "schedule" | "inline" | "other";

const zero = () =>
  ({
    script_runs: 0,
    script_runs_completed: 0,
    script_runs_failed: 0,
    script_runs_timeout: 0,
    script_runs_task: 0,
    script_runs_workflow_node: 0,
    script_runs_schedule: 0,
    script_runs_inline: 0,
    script_runs_other: 0,
    script_runs_native: 0,
    script_runs_quickjs: 0,
    script_runs_duration_ms_total: 0,
    script_runs_duration_ms_max: 0,
    hitl_requests_created: 0,
    hitl_requests_from_workflow: 0,
    hitl_requests_from_task: 0,
    hitl_requests_approved: 0,
    hitl_requests_rejected: 0,
    hitl_requests_timeout: 0,
    hitl_requests_cancelled: 0,
    hitl_wait_ms_total: 0,
    hitl_wait_ms_max: 0,
    workflow_steps: 0,
    workflow_steps_agent_task: 0,
    workflow_steps_hitl: 0,
    workflow_steps_script: 0,
    workflow_steps_other: 0,
  }) satisfies Omit<OrgActivity, "window_minutes">;

let counters = zero();
let windowStart = Date.now();

const ms = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);

/** Count one finished script execution. A no-op while telemetry is off. */
export function recordScriptRun(run: {
  trigger: ScriptRunTrigger;
  executor: string;
  status: "completed" | "failed" | "timeout";
  durationMs: number;
}): void {
  if (!isTelemetryEnabled()) return;
  const duration = ms(run.durationMs);
  counters.script_runs++;
  counters[`script_runs_${run.status}`]++;
  counters[`script_runs_${run.trigger}`]++;
  counters[run.executor === "quickjs" ? "script_runs_quickjs" : "script_runs_native"]++;
  counters.script_runs_duration_ms_total += duration;
  counters.script_runs_duration_ms_max = Math.max(counters.script_runs_duration_ms_max, duration);
}

/** Count one started workflow step by its node type. A no-op while telemetry is off. */
export function recordWorkflowStep(nodeType: string): void {
  if (!isTelemetryEnabled()) return;
  counters.workflow_steps++;
  if (nodeType === "agent-task") counters.workflow_steps_agent_task++;
  else if (nodeType === "human-in-the-loop") counters.workflow_steps_hitl++;
  else if (nodeType === "swarm-script" || nodeType === "script") counters.workflow_steps_script++;
  else counters.workflow_steps_other++;
}

type HitlRequest = {
  status: string;
  workflowRunId?: string | null;
  sourceTaskId?: string | null;
  createdAt?: string | null;
  resolvedAt?: string | null;
};

/** Count a created HITL request, and settle it at once when it was born terminal. */
export function recordHitlCreated(request: HitlRequest): void {
  if (!isTelemetryEnabled()) return;
  counters.hitl_requests_created++;
  if (request.workflowRunId) counters.hitl_requests_from_workflow++;
  else if (request.sourceTaskId) counters.hitl_requests_from_task++;
  if (request.status !== "pending") recordHitlSettled([request]);
}

/** Count HITL requests that reached a terminal status, with their wait. */
export function recordHitlSettled(requests: readonly HitlRequest[]): void {
  if (!isTelemetryEnabled()) return;
  for (const request of requests) {
    const key = `hitl_requests_${request.status}` as const;
    if (
      key !== "hitl_requests_approved" &&
      key !== "hitl_requests_rejected" &&
      key !== "hitl_requests_timeout" &&
      key !== "hitl_requests_cancelled"
    ) {
      continue;
    }
    counters[key]++;
    const created = Date.parse(request.createdAt ?? "");
    const resolved = Date.parse(request.resolvedAt ?? "");
    const wait = Number.isFinite(created) && Number.isFinite(resolved) ? ms(resolved - created) : 0;
    counters.hitl_wait_ms_total += wait;
    counters.hitl_wait_ms_max = Math.max(counters.hitl_wait_ms_max, wait);
  }
}

/** Count `count` HITL requests cancelled together, from their summed and longest wait. */
export function recordHitlCancelled(batch: {
  count: number;
  waitMsTotal: number;
  waitMsMax: number;
}): void {
  if (!isTelemetryEnabled() || batch.count <= 0) return;
  counters.hitl_requests_cancelled += batch.count;
  counters.hitl_wait_ms_total += ms(batch.waitMsTotal);
  counters.hitl_wait_ms_max = Math.max(counters.hitl_wait_ms_max, ms(batch.waitMsMax));
}

function reset(now: number): void {
  counters = zero();
  windowStart = now;
}

/**
 * Send the window's counters as one `org.activity` and start a new window.
 * Returns true when an event was sent. Telemetry off drops the counters; not
 * yet identified keeps them for the next tick. An empty window sends nothing.
 */
export function flushOrgActivity(now = Date.now()): boolean {
  if (!isTelemetryEnabled()) {
    reset(now);
    return false;
  }
  if (!isTelemetryReady()) return false;
  const window = counters;
  const windowMinutes = Math.max(0, Math.round((now - windowStart) / 60_000));
  reset(now);
  if (!Object.values(window).some((n) => n > 0)) return false;
  telemetry.org("activity", { window_minutes: windowMinutes, ...window });
  return true;
}

/**
 * Drop the counters and start a fresh window. Called on every telemetry on/off
 * transition, so an opt-out never ships what was counted before it.
 */
export function discardOrgActivity(now = Date.now()): void {
  reset(now);
}
