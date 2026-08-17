import { getDb } from "./be/db";
import { getSlackApp } from "./slack/app";

export const QUEUE_STALL_THRESHOLD_MS = 30 * 60 * 1000;
export const QUEUE_STALL_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const QUEUE_STALL_STARTUP_DELAY_MS = 10_000;

export interface QueueStallSnapshot {
  claimableCount: number;
  oldestTaskId: string | null;
  oldestCreatedAt: string | null;
  oldestAgeMs: number;
  recentPickupCount: number;
}

type QueueStallNotifier = (message: string) => Promise<void>;

let alarmInterval: ReturnType<typeof setInterval> | null = null;
let startupTimeout: ReturnType<typeof setTimeout> | null = null;
let checkInFlight = false;
let alarmActive = false;

/**
 * Read the queue denominator and oldest age in one snapshot. Tasks with unmet
 * dependencies are excluded because a worker cannot start them yet.
 */
export function getQueueStallSnapshot(now = new Date()): QueueStallSnapshot {
  const oldest = getDb()
    .prepare<
      { claimableCount: number; oldestTaskId: string | null; oldestCreatedAt: string | null },
      []
    >(
      `WITH claimable AS (
         SELECT t.id, t.createdAt
         FROM agent_tasks t
         WHERE t.status IN ('pending', 'unassigned')
           AND NOT EXISTS (
             SELECT 1
             FROM json_each(COALESCE(t.dependsOn, '[]')) dep
             LEFT JOIN agent_tasks prerequisite ON prerequisite.id = dep.value
             WHERE prerequisite.id IS NULL OR prerequisite.status != 'completed'
           )
       ),
       oldest AS (
         SELECT id, createdAt FROM claimable ORDER BY createdAt ASC LIMIT 1
       )
       SELECT
         (SELECT COUNT(*) FROM claimable) AS claimableCount,
         (SELECT id FROM oldest) AS oldestTaskId,
         (SELECT createdAt FROM oldest) AS oldestCreatedAt`,
    )
    .get();

  const pickupCutoff = new Date(now.getTime() - QUEUE_STALL_THRESHOLD_MS).toISOString();
  const recentPickupCount =
    getDb()
      .prepare<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count
         FROM agent_log
         WHERE eventType = 'task_status_change'
           AND oldValue IN ('pending', 'unassigned')
           AND newValue = 'in_progress'
           AND createdAt >= ?`,
      )
      .get(pickupCutoff)?.count ?? 0;

  const oldestCreatedAt = oldest?.oldestCreatedAt ?? null;
  return {
    claimableCount: oldest?.claimableCount ?? 0,
    oldestTaskId: oldest?.oldestTaskId ?? null,
    oldestCreatedAt,
    oldestAgeMs: oldestCreatedAt
      ? Math.max(0, now.getTime() - new Date(oldestCreatedAt).getTime())
      : 0,
    recentPickupCount,
  };
}

export function isQueueStalled(snapshot: QueueStallSnapshot): boolean {
  return snapshot.claimableCount > 0 && snapshot.oldestAgeMs >= QUEUE_STALL_THRESHOLD_MS;
}

function formatAge(ageMs: number): string {
  return `${Math.floor(ageMs / 60_000)}m`;
}

async function notifySlack(message: string): Promise<void> {
  const channel = process.env.SLACK_ALERTS_CHANNEL?.trim();
  if (!channel) throw new Error("SLACK_ALERTS_CHANNEL is not configured");

  const app = getSlackApp();
  if (!app) throw new Error("Slack is not connected");

  await app.client.chat.postMessage({
    channel,
    text: message,
    unfurl_links: false,
    unfurl_media: false,
  });
}

/** Run one detector tick. Exported so tests and operators can exercise it directly. */
export async function checkQueueStall(
  now = new Date(),
  notify: QueueStallNotifier = notifySlack,
): Promise<QueueStallSnapshot> {
  const snapshot = getQueueStallSnapshot(now);
  const stalled = isQueueStalled(snapshot);

  if (stalled && !alarmActive) {
    await notify(
      `🚨 *Agent Swarm queue pickup stalled*\n` +
        `Claimable tasks: *${snapshot.claimableCount}*\n` +
        `Oldest wait: *${formatAge(snapshot.oldestAgeMs)}* (task \`${snapshot.oldestTaskId}\`)\n` +
        `Pickups in the last 30m: *${snapshot.recentPickupCount}*\n\n` +
        "This alarm runs in the API process and does not require an agent to claim a task.",
    );
    alarmActive = true;
    console.error(
      `[Queue Stall Alarm] Fired: claimable=${snapshot.claimableCount}, oldest=${snapshot.oldestTaskId}, age=${formatAge(snapshot.oldestAgeMs)}, recent_pickups=${snapshot.recentPickupCount}`,
    );
  } else if (!stalled && alarmActive) {
    await notify(
      `✅ *Agent Swarm queue pickup recovered*\nClaimable tasks: *${snapshot.claimableCount}*\nPickups in the last 30m: *${snapshot.recentPickupCount}*`,
    );
    alarmActive = false;
    console.log("[Queue Stall Alarm] Recovery notification sent");
  }

  return snapshot;
}

function scheduleCheck(): void {
  if (checkInFlight) return;
  checkInFlight = true;
  checkQueueStall()
    .catch((error) => {
      console.error(
        `[Queue Stall Alarm] Check or notification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    })
    .finally(() => {
      checkInFlight = false;
    });
}

export function startQueueStallAlarm(): void {
  if (alarmInterval || startupTimeout) return;

  console.log(
    `[Queue Stall Alarm] Starting (threshold ${formatAge(QUEUE_STALL_THRESHOLD_MS)}, interval ${formatAge(QUEUE_STALL_CHECK_INTERVAL_MS)})`,
  );
  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    scheduleCheck();
  }, QUEUE_STALL_STARTUP_DELAY_MS);
  alarmInterval = setInterval(scheduleCheck, QUEUE_STALL_CHECK_INTERVAL_MS);
}

export function stopQueueStallAlarm(): void {
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }
  if (alarmInterval) {
    clearInterval(alarmInterval);
    alarmInterval = null;
  }
  checkInFlight = false;
}

export const _test = {
  resetState(): void {
    stopQueueStallAlarm();
    alarmActive = false;
  },
};
