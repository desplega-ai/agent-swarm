import { getTaskById } from "../be/db";
import type { AgentTask } from "../types";

/** Guards each walk against a corrupt cycle or a pathological chain. */
const SLACK_ANCESTOR_WALK_LIMIT = 50;

function sameSlackThread(a: AgentTask, b: AgentTask): boolean {
  return (
    !!a.slackChannelId &&
    !!a.slackThreadTs &&
    a.slackChannelId === b.slackChannelId &&
    a.slackThreadTs === b.slackThreadTs
  );
}

/**
 * The nearest task a person started in Slack among `task`'s ancestors, or
 * undefined. The parent chain wins. When it has no Slack ask, the walk falls
 * back to the dispatch edges (`dispatchedByTaskId`, the task whose session
 * called send-task) of the chain's members, and takes a Slack ask there only
 * in `task`'s own thread. A Lead that sets parentTaskId to an older task for
 * context still dispatches from the Slack ask, so that ask is on the dispatch
 * edge only.
 */
export async function slackAskAncestorId(
  task: AgentTask,
  threadTasks: readonly AgentTask[] = [],
): Promise<string | undefined> {
  const byId = new Map(threadTasks.map((candidate) => [candidate.id, candidate]));
  const load = async (id: string) => byId.get(id) ?? (await getTaskById(id)) ?? undefined;

  const chain: AgentTask[] = [task];
  const seen = new Set<string>([task.id]);
  let parentId = task.parentTaskId;
  while (parentId && !seen.has(parentId) && seen.size <= SLACK_ANCESTOR_WALK_LIMIT) {
    seen.add(parentId);
    const parent = await load(parentId);
    if (!parent) break;
    if (parent.source === "slack") return parent.id;
    chain.push(parent);
    parentId = parent.parentTaskId;
  }

  const queue = chain.flatMap((member) => member.dispatchedByTaskId ?? []);
  let visited = 0;
  while (queue.length > 0 && visited < SLACK_ANCESTOR_WALK_LIMIT) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    visited++;
    const node = await load(id);
    if (!node) continue;
    if (node.source === "slack") {
      // A Slack ask in another thread is another conversation: do not walk past it.
      if (sameSlackThread(node, task)) return node.id;
      continue;
    }
    if (node.parentTaskId) queue.push(node.parentTaskId);
    if (node.dispatchedByTaskId) queue.push(node.dispatchedByTaskId);
  }
  return undefined;
}

/** The Slack ask a task answers: itself when a person started it in Slack, else its nearest such ancestor. */
export async function slackAskOf(
  task: AgentTask,
  threadTasks: readonly AgentTask[] = [],
): Promise<string | undefined> {
  return task.source === "slack" ? task.id : await slackAskAncestorId(task, threadTasks);
}
