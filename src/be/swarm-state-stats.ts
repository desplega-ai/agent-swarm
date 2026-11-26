import { getStorage } from "./storage";

/** Swarm state the API exports as OTel gauges (see `startSwarmStateMetrics`). */
export interface SwarmStateStats {
  /** Tasks failed in the last hour, cascade failures excluded. */
  failedTasks1h: number;
  pendingApprovals: number;
  /** Seconds since the oldest pending approval was created, 0 when none. */
  pendingApprovalMaxAgeSeconds: number;
  /** Pending approvals past their deadline: non-zero means the timeout sweep is not running. */
  overdueApprovals: number;
  claimableTasks: number;
  /** Seconds since the oldest claimable task became claimable, 0 when none. */
  oldestClaimableAgeSeconds: number;
}

const ageSeconds = (now: Date, at: string | null) =>
  at ? Math.max(0, (now.getTime() - new Date(at).getTime()) / 1000) : 0;

export async function readSwarmStateStats(now = new Date()): Promise<SwarmStateStats> {
  const { tasks, workflows } = getStorage().repos;
  const [failed, approvals, queue] = await Promise.all([
    tasks.countFailedSince(new Date(now.getTime() - 3_600_000).toISOString()),
    workflows.pendingApprovalStats(now.toISOString()),
    tasks.queueStallOldest(),
  ]);
  return {
    failedTasks1h: failed,
    pendingApprovals: approvals.pending,
    pendingApprovalMaxAgeSeconds: ageSeconds(now, approvals.oldestCreatedAt),
    overdueApprovals: approvals.overdue,
    claimableTasks: queue?.claimableCount ?? 0,
    oldestClaimableAgeSeconds: ageSeconds(now, queue?.oldestClaimableAt ?? null),
  };
}
