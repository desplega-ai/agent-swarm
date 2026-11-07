import type { TaskSlackParticipants } from "../../../types";
import { createLogEntry } from "../../db";
import { getDbClient } from "../runtime";

/**
 * Slack message timestamps a task in this thread already carries: each task's
 * trigger message, plus every message delivered into a task later (steered or
 * folded into a pending task), which the Slack path logs as a `task_steering`
 * / `slack_reaction` entry. A buffered message whose ts is here must not be
 * delivered again.
 */
export async function getDeliveredSlackMessageTs(
  channelId: string,
  threadTs: string,
): Promise<Set<string>> {
  const rows = await getDbClient().query<{ ts: string | null }>(
    `SELECT slackTriggerMessageTs AS ts FROM agent_tasks
       WHERE slackChannelId = ? AND slackThreadTs = ? AND slackTriggerMessageTs IS NOT NULL
     UNION
     SELECT CASE WHEN json_valid(l.metadata) THEN json_extract(l.metadata, '$.slackMessageTs') END AS ts
       FROM agent_log l
       JOIN agent_tasks t ON t.id = l.taskId
       WHERE t.slackChannelId = ? AND t.slackThreadTs = ?
         AND l.eventType = 'task_steering' AND l.newValue = 'slack_reaction'`,
    [channelId, threadTs, channelId, threadTs],
  );
  return new Set(rows.flatMap((row) => (row.ts ? [row.ts] : [])));
}

/**
 * Fold buffered Slack thread messages into a task that nobody has claimed yet.
 * One compare-and-set: the row changes only while it is still `pending` and
 * its text is still `expectedTask`, so a claim (or a concurrent fold) that won
 * the race leaves it untouched and the caller falls back. With `toDraft` the
 * task moves to `draft` so no worker can claim it before the new files are
 * attached; the caller promotes it back with `promoteDraftTask`. Each folded
 * message ts is logged like a steered one, so its reaction is finalized with
 * the task and a re-flush of it is recognized. Returns whether the fold landed.
 */
export async function foldIntoPendingSlackTask(args: {
  taskId: string;
  expectedTask: string;
  nextTask: string;
  toDraft: boolean;
  slackChannelId: string;
  messageTs: readonly string[];
  slackParticipants?: TaskSlackParticipants;
}): Promise<boolean> {
  return await getDbClient().transaction(async (tx) => {
    const result = await tx.run(
      `UPDATE agent_tasks
         SET task = ?,
             status = CASE WHEN ? THEN 'draft' ELSE status END,
             slackParticipants = COALESCE(?, slackParticipants),
             lastUpdatedAt = ?
         WHERE id = ? AND status = 'pending' AND task = ?`,
      [
        args.nextTask,
        args.toDraft ? 1 : 0,
        args.slackParticipants ? JSON.stringify(args.slackParticipants) : null,
        new Date().toISOString(),
        args.taskId,
        args.expectedTask,
      ],
    );
    if (result.changes === 0) return false;
    if (args.toDraft) {
      await createLogEntry({
        eventType: "task_status_change",
        taskId: args.taskId,
        oldValue: "pending",
        newValue: "draft",
      });
    }
    for (const messageTs of args.messageTs) {
      await createLogEntry({
        eventType: "task_steering",
        taskId: args.taskId,
        newValue: "slack_reaction",
        metadata: { slackChannelId: args.slackChannelId, slackMessageTs: messageTs, folded: true },
      });
    }
    return true;
  });
}
