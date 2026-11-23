import type { SlackReconcileSource } from "@desplega/storage";
import { getStorage } from "../storage";

/**
 * Close a tree once the sweep has nothing left to do for it: every task in
 * the thread is terminal, every outcome card is finalized or abandoned, and no
 * task or card changed after the tree. One statement, so a write that lands
 * before it is seen by the predicate; a write after it reopens the tree
 * through migration 278's triggers. Returns true when the tree was closed.
 */
export async function closeSlackTreeIfSettled(id: string): Promise<boolean> {
  return getStorage().repos.slack.closeTreeIfSettled(id, new Date().toISOString());
}

const THREAD_LOOKUP_CHUNK = 500;

/**
 * The Slack threads the given tasks belong to, for the event-driven render.
 * `wakeTouched` is true when any of them is a deferral wake-up, whose
 * settling can resolve a ⏳ card in another thread.
 */
export async function getSlackThreadsOfTasks(taskIds: string[]): Promise<{
  threads: { channelId: string; threadTs: string }[];
  wakeTouched: boolean;
}> {
  const threads = new Map<string, { channelId: string; threadTs: string }>();
  let wakeTouched = false;
  for (let i = 0; i < taskIds.length; i += THREAD_LOOKUP_CHUNK) {
    const chunk = taskIds.slice(i, i + THREAD_LOOKUP_CHUNK);
    const rows = await getStorage().repos.tasks.listTaskSlackThreads(chunk);
    for (const row of rows) {
      if (row.taskType === "deferred") wakeTouched = true;
      if (!row.slackChannelId || !row.slackThreadTs) continue;
      threads.set(`${row.slackChannelId}\u0000${row.slackThreadTs}`, {
        channelId: row.slackChannelId,
        threadTs: row.slackThreadTs,
      });
    }
  }
  return { threads: [...threads.values()], wakeTouched };
}

/**
 * Outcome cards answer live work; they are not a history backfill. A task
 * that ended before `finishedAfter` gets no card of its own, so a sweep over
 * terminal history never replies in a thread months later. A delegated ask
 * (closure mode) concludes when its closure goes quiet, which can be long
 * after the ask itself finished, so it also stays eligible while any task in
 * its thread changed after `closureActiveAfter`. The render pass applies the
 * exact closure bound; this SQL form is a superset of it.
 */
export type SlackOutcomeWindow = {
  finishedAfter: string;
  closureActiveAfter: string;
  delegationEnabled: boolean;
};

/** True when the bot replied in the thread at or after `since`, other than `taskId`'s own card. */
export async function slackThreadHasBotReplySince(
  channelId: string,
  threadTs: string,
  since: string,
  taskId: string,
): Promise<boolean> {
  return getStorage().repos.slack.threadHasBotReplySince(channelId, threadTs, since, taskId);
}

/**
 * True when agent `agentId` sent a `slack-reply` in the thread at or after
 * `since`, attributed to one of `taskIds`. A Lead follow-up passes the task
 * it reviews: the Lead can attribute its review reply to that task instead of
 * to the follow-up itself.
 */
export async function slackThreadHasAgentReplyOnTasksSince(
  channelId: string,
  threadTs: string,
  since: string,
  agentId: string,
  taskIds: readonly string[],
): Promise<boolean> {
  return getStorage().repos.slack.threadHasAgentReplyOnTasksSince(
    channelId,
    threadTs,
    since,
    agentId,
    taskIds,
  );
}

/**
 * True while the thread still owes an outcome card: a terminal Slack task
 * whose card is not finalized or abandoned, or a card still in flight. These
 * wait on time (conclusion settle, delivery backoff), not on a task event.
 */
export async function slackThreadHasOutcomeWork(
  thread: {
    channelId: string;
    threadTs: string;
  },
  window: SlackOutcomeWindow,
): Promise<boolean> {
  return getStorage().repos.slack.threadHasOutcomeWork(thread, window);
}

export type SlackRenderThread = { channelId: string; threadTs: string };

/** Persist only actual visibility transitions. Never reset the V2 activation boundary. */
export async function observeSlackTreeVisibility(enabled: boolean): Promise<string | null> {
  const repo = getStorage().repos.slack;
  const current = await repo.getTreeVisibility();
  if (!current || current.task_tree_enabled === Number(enabled)) {
    return current?.task_tree_enabled_at ?? null;
  }
  return repo.setTreeVisibility(enabled, new Date().toISOString());
}

/** Four independent pages reserve capacity for outcomes even when active work never drains. */
export const SLACK_RECONCILE_PAGE_SIZE = 50;

/**
 * Page raw candidates BEFORE checking eligibility. This bounds index visits even
 * when most terminal rows already have outcomes. Persist the last scanned id,
 * not the last eligible id, so sparse history cannot stall recovery. Each source
 * wraps independently; a crash can delay a page until the next lap, never lose it.
 */
export async function getSlackProcessingThreads(
  delegationEnabled: boolean,
  treesEnabled: boolean,
  window: SlackOutcomeWindow,
): Promise<SlackRenderThread[]> {
  const storage = getStorage();
  const repo = storage.repos.slack;
  return storage.transaction(async () => {
    const stored = await repo.getReconcileCursors();
    if (stored === null) return [];
    const cursors = JSON.parse(stored) as Record<string, string>;
    const threads = new Map<string, SlackRenderThread>();
    async function page(source: SlackReconcileSource) {
      const rows = await repo.pageReconcileCandidates(
        source,
        cursors[source] ?? "",
        SLACK_RECONCILE_PAGE_SIZE,
        delegationEnabled,
        window,
      );
      cursors[source] = rows.length < SLACK_RECONCILE_PAGE_SIZE ? "" : rows.at(-1)!.id;
      for (const row of rows) {
        if (row.eligible)
          threads.set(`${row.channelId}\u0000${row.threadTs}`, {
            channelId: row.channelId,
            threadTs: row.threadTs,
          });
      }
    }
    await page("active");
    await page("terminal");
    await page("outcome");
    if (treesEnabled) await page("tree");
    const next = JSON.stringify(cursors);
    if (next !== stored) await repo.setReconcileCursors(next);
    return [...threads.values()];
  });
}
