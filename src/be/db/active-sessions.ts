import { getDbClient } from "./runtime";

/**
 * Minimum gap between two activity-driven liveness writes for one session.
 * Provider output is high-frequency (one observed session streamed 7,000+
 * reasoning deltas), so the write is gated in SQL: at most one per window.
 */
export const SESSION_ACTIVITY_REFRESH_MIN_INTERVAL_MS = 30_000;

/**
 * Refresh the active session of `taskId` because the task's provider produced
 * output (session-log ingestion). Tool-driven heartbeats cannot cover a long
 * reasoning stream with no tool calls, and the heartbeat sweep fails a workflow
 * step whose session looks stale.
 *
 * Scoped to the one session row for this task. The `lastHeartbeatAt < cutoff`
 * guard throttles the write across API processes with no in-memory state and
 * never moves the timestamp backwards. Returns whether the row was written.
 */
export async function refreshActiveSessionOnActivity(
  taskId: string,
  minIntervalMs: number = SESSION_ACTIVITY_REFRESH_MIN_INTERVAL_MS,
): Promise<boolean> {
  const nowMs = Date.now();
  const result = await getDbClient().run(
    "UPDATE active_sessions SET lastHeartbeatAt = ? WHERE taskId = ? AND lastHeartbeatAt < ?",
    [new Date(nowMs).toISOString(), taskId, new Date(nowMs - minIntervalMs).toISOString()],
  );
  return result.changes > 0;
}
