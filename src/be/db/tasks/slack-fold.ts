import type { PreparedTaskCreate } from "../../../tasks/sibling-awareness";
import type { AgentTask, TaskSlackParticipants } from "../../../types";
import { createLogEntry, createTaskExtended } from "../../db";
import { getStorage } from "../../storage";

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
  const rows = await getStorage().repos.tasks.listDeliveredSlackMessageTs(channelId, threadTs);
  return new Set(rows.flatMap((ts) => (ts ? [ts] : [])));
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
  const tasks = getStorage().repos.tasks;
  return await getStorage().transaction(async () => {
    const changes = await tasks.foldPendingTaskText({
      taskId: args.taskId,
      expectedTask: args.expectedTask,
      nextTask: args.nextTask,
      toDraft: args.toDraft,
      slackParticipants: args.slackParticipants ? JSON.stringify(args.slackParticipants) : null,
      now: new Date().toISOString(),
    });
    if (changes === 0) return false;
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

/**
 * Create a Slack task that carries more messages than its trigger (a buffered
 * burst): the task row and a delivered-message entry per extra message commit
 * together, so a retry of any message in the burst sees it as delivered. The
 * entries are the ones a fold or a steer writes, so those messages' reactions
 * are finalized with the task. `prepared` must come from
 * `prepareTaskWithSiblingAwareness`, run outside this transaction.
 */
export async function createSlackTaskCarryingMessages(
  prepared: PreparedTaskCreate,
  carried: { slackChannelId: string; messageTs: readonly string[] },
): Promise<AgentTask> {
  return await getStorage().transaction(async () => {
    const task = await createTaskExtended(prepared.description, prepared.options);
    for (const messageTs of carried.messageTs) {
      await createLogEntry({
        eventType: "task_steering",
        taskId: task.id,
        newValue: "slack_reaction",
        metadata: {
          slackChannelId: carried.slackChannelId,
          slackMessageTs: messageTs,
          buffered: true,
        },
      });
    }
    return task;
  });
}
