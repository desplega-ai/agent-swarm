/**
 * Follow-up re-delegation guard, shared by every agent dispatch path that can
 * run inside a follow-up session: MCP `send-task` and durable-run
 * `ctx.step.agentTask` steps (`src/http/script-runs.ts`).
 *
 * When the dispatching session's source task is a `follow-up` in a Slack
 * thread, two rules stop the cycle
 * worker completes → follow-up → Lead re-delegates → repeat,
 * while a distinct next step (step 2 of a chain, a fix round, a retry) passes:
 *
 * 1. same-work: the new task matches a completed task in the thread under the
 *    dedup similarity rules. Bypassed when a task in the thread was cancelled
 *    or failed after that completion: the work was interrupted or went wrong,
 *    so re-dispatch is the correct response, not a deduped no-op.
 * 2. loop-cap: the caller already made FOLLOW_UP_DISPATCH_CAP dispatches into
 *    the thread within FOLLOW_UP_DISPATCH_WINDOW_MINUTES. A durable script run
 *    counts once however many steps it dispatched. Independent of similarity,
 *    so a loop that rewords each re-delegation still stops.
 *
 * Callers bypass both with `allowRedelegation` and log the override. Each
 * caller evaluates the rules inside the write transaction that inserts the
 * task, so two concurrent dispatches into one thread (send-task or a run's
 * first step, in any mix) cannot both read the count below the cap.
 */
import {
  countAgentDispatchesInThread,
  findCompletedTasksInThread,
  findRecentCancelledTaskInThread,
  findRecentFailedTaskInThread,
  getTaskById,
} from "../be/db";
import { type DedupMatch, matchSimilarTask } from "../tools/task-dedup";

/** How far back the same-work rule looks for a completed task in the thread. */
export const FOLLOW_UP_SAME_WORK_WINDOW_MINUTES = 2880; // 48 hours
/**
 * Loop cap: dispatches one agent may make into one Slack thread per window
 * before a follow-up session needs allowRedelegation. A long legitimate chain
 * (plan, implement, review, fix, re-review, fix, CI fix, retry) is about 8
 * dispatches; a runaway loop makes one per worker run (minutes), so it hits
 * 10 within a few hours and burns at most 10 worker sessions.
 */
export const FOLLOW_UP_DISPATCH_CAP = 10;
export const FOLLOW_UP_DISPATCH_WINDOW_MINUTES = 360; // 6 hours

/** Rows per page when the same-work rule scans a thread's completions. */
export const FOLLOW_UP_SAME_WORK_PAGE_SIZE = 200;

export type FollowUpThread = { channelId: string; threadTs: string; userId?: string };

export type FollowUpRedelegationBlock = {
  rule: "same-work" | "loop-cap";
  message: string;
};

/**
 * The Slack thread the guard applies to, or null when the source task is not
 * a `follow-up` in a Slack thread. A `resume` source is intentionally exempt:
 * a resume IS the legitimate re-dispatch.
 */
export async function followUpThreadForSourceTask(
  sourceTaskId: string | null | undefined,
): Promise<FollowUpThread | null> {
  if (!sourceTaskId) return null;
  const sourceTask = await getTaskById(sourceTaskId);
  if (
    sourceTask?.taskType !== "follow-up" ||
    !sourceTask.slackChannelId ||
    !sourceTask.slackThreadTs
  ) {
    return null;
  }
  return {
    channelId: sourceTask.slackChannelId,
    threadTs: sourceTask.slackThreadTs,
    userId: sourceTask.slackUserId,
  };
}

/**
 * The most recent completed task in the thread's same-work window whose
 * description matches this dispatch. Pages through every completion in the
 * window (an older match can sit behind any number of newer unrelated ones),
 * one bounded query per page, and stops at the first match.
 */
async function findMatchingCompletedWork(args: {
  channelId: string;
  threadTs: string;
  taskDescription: string;
  targetAgentId?: string;
}): Promise<DedupMatch | null> {
  let before: { lastUpdatedAt: string; id: string } | undefined;
  for (;;) {
    const page = await findCompletedTasksInThread(
      args.channelId,
      args.threadTs,
      FOLLOW_UP_SAME_WORK_WINDOW_MINUTES,
      FOLLOW_UP_SAME_WORK_PAGE_SIZE,
      before,
    );
    for (const existing of page) {
      const match = matchSimilarTask(existing, args);
      if (match) return match;
    }
    const last = page.at(-1);
    if (!last || page.length < FOLLOW_UP_SAME_WORK_PAGE_SIZE) return null;
    before = { lastUpdatedAt: last.lastUpdatedAt, id: last.id };
  }
}

/**
 * The follow-up re-delegation rules. Returns the rule that blocks this
 * dispatch, or null when it may proceed.
 */
export async function evaluateFollowUpRedelegation(args: {
  channelId: string;
  threadTs: string;
  creatorAgentId: string;
  taskDescription: string;
  targetAgentId?: string;
}): Promise<FollowUpRedelegationBlock | null> {
  const { channelId, threadTs } = args;
  const match = await findMatchingCompletedWork(args);
  if (match) {
    const existing = match.task;
    const [cancelled, failed] = await Promise.all([
      findRecentCancelledTaskInThread(channelId, threadTs, FOLLOW_UP_SAME_WORK_WINDOW_MINUTES),
      findRecentFailedTaskInThread(channelId, threadTs, FOLLOW_UP_SAME_WORK_WINDOW_MINUTES),
    ]);
    const completedAt = new Date(existing.lastUpdatedAt).getTime();
    const interruptedLater = [cancelled, failed].some(
      (t) => t && new Date(t.lastUpdatedAt).getTime() > completedAt,
    );
    if (!interruptedLater) {
      return {
        rule: "same-work",
        message: `Blocked by the follow-up re-delegation guard (same-work rule): this task matches completed task ${existing.id.slice(0, 8)} in this Slack thread (${match.reason}), so the work was already done. If it must run again, pass allowRedelegation: true.`,
      };
    }
  }

  const dispatched = await countAgentDispatchesInThread(
    channelId,
    threadTs,
    args.creatorAgentId,
    FOLLOW_UP_DISPATCH_WINDOW_MINUTES,
  );
  if (dispatched >= FOLLOW_UP_DISPATCH_CAP) {
    return {
      rule: "loop-cap",
      message: `Blocked by the follow-up re-delegation guard (loop-cap rule): you already dispatched ${dispatched} times into this Slack thread in the last ${FOLLOW_UP_DISPATCH_WINDOW_MINUTES / 60} hours (cap ${FOLLOW_UP_DISPATCH_CAP}; a durable script run counts once). If this is a deliberate next step and not a re-delegation loop, pass allowRedelegation: true.`,
    };
  }
  return null;
}
