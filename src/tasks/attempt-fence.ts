import type { IncomingMessage } from "node:http";
import type { AgentTask } from "../types";
import { isTerminalTaskStatus } from "../types";

/**
 * Attempt fence (specs/tla/heartbeat/HeartbeatSimple.tla `Fenced`).
 *
 * The heartbeat reclaims a stalled task in place: same row, `attempt + 1`,
 * back to `pending`. The process running the earlier attempt may still be
 * alive (unresponsive, not dead), and with several runtimes serving one agent
 * the replacement attempt can run in a different process under the SAME
 * agent id. Agent ownership therefore cannot tell the two apart.
 *
 * The token is the runtime instance that started the current attempt,
 * stamped as `attemptRuntimeId` by every start write (poll start, pool
 * claim, paused resume). Every local runner and harness session already sends
 * it as `X-Runtime-Instance-ID`, so no new identity is threaded through the
 * providers. A runtime runs at most one process per task (the runner keeps
 * the old process when the same runtime is handed its own reclaimed task
 * back), so the runtime identifies the attempt's process.
 *
 * Callers evaluate this inside the same transaction as their write, on a
 * fresh read, so the check and the write are atomic.
 *
 * Returns the rejection message, or `null` when the write may proceed.
 */
export function staleAttemptWriteReason(
  task: AgentTask,
  caller: { agentId: string; isLead?: boolean; runtimeInstanceId?: string | null },
): string | null {
  if (isTerminalTaskStatus(task.status)) return null;
  const ownsRow = task.agentId === caller.agentId;

  // Reclaimed and not (yet) restarted by this agent: pending, back in the
  // pool, or started by another agent. Leads keep their override for rows
  // they do not own.
  if ((task.attempt ?? 0) > 0 && !caller.isLead && (task.status !== "in_progress" || !ownsRow)) {
    return `Task ${task.id} was reclaimed by the heartbeat (attempt ${task.attempt}, now ${task.status}) and is no longer yours to write. Stop working on it; it will be re-run.`;
  }

  // Same agent, different runtime: the current attempt runs elsewhere.
  if (ownsRow && task.status === "in_progress" && task.attemptRuntimeId) {
    if (caller.runtimeInstanceId && task.attemptRuntimeId !== caller.runtimeInstanceId) {
      return `Task ${task.id} attempt ${task.attempt ?? 0} is running in another runtime; this process holds an earlier attempt. Stop working on it.`;
    }
    // Fail closed on a reclaimed row: a caller that cannot say which runtime
    // it is may be the attempt the heartbeat took the row away from. Rows
    // never reclaimed (attempt 0) have one attempt only, so a headerless
    // caller (remote harness) keeps the status + agent check there.
    if (!caller.runtimeInstanceId && (task.attempt ?? 0) > 0) {
      return `Task ${task.id} was reclaimed by the heartbeat (attempt ${task.attempt}) and restarted by a runtime; this call names no runtime (X-Runtime-Instance-ID), so it cannot prove it holds the current attempt. Stop working on it.`;
    }
  }

  return null;
}

/** `X-Runtime-Instance-ID` of an HTTP request, when sent. */
export function headerRuntimeInstanceId(req: IncomingMessage): string | undefined {
  const value = req.headers["x-runtime-instance-id"];
  const first = Array.isArray(value) ? value[0] : value;
  return first || undefined;
}
