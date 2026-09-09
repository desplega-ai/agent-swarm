import type { AgentTask } from "../types";
import { isTerminalTaskStatus } from "../types";

/**
 * The ask closure: every task descended from an ask task `A` over
 * `parentTaskId` edges, skipping any node with `source === "slack"` — a
 * later human ask owns its own closure rather than joining this one.
 *
 * `threadTasks` is the full result of `getSlackTasksInThread(A.slackChannelId,
 * A.slackThreadTs)`; the walk below only follows edges within that set.
 */
export function buildAskClosure(ask: AgentTask, threadTasks: AgentTask[]): AgentTask[] {
  const childrenByParent = new Map<string, AgentTask[]>();
  for (const candidate of threadTasks) {
    if (!candidate.parentTaskId) continue;
    const children = childrenByParent.get(candidate.parentTaskId) ?? [];
    children.push(candidate);
    childrenByParent.set(candidate.parentTaskId, children);
  }
  const closure: AgentTask[] = [];
  const queue = [...(childrenByParent.get(ask.id) ?? [])];
  while (queue.length > 0) {
    const candidate = queue.shift()!;
    // A later human ask may be parented to the previous ask for context
    // continuity, but it is a sibling in the Slack tree and owns its own closure.
    if (candidate.source === "slack") continue;
    closure.push(candidate);
    queue.push(...(childrenByParent.get(candidate.id) ?? []));
  }
  return closure;
}

export type ClosureState = "open" | "settled" | "timedOut";

function mostRecentActivityMs(task: AgentTask): number {
  return new Date(task.lastUpdatedAt).getTime();
}

/**
 * Closure state per plan section 3.1:
 * - "open": at least one member of {ask} ∪ closure is not terminal, and the
 *   idle time since the last member activity has not crossed `timeoutMin`.
 * - "settled": every member is terminal, and none changed within `settleSec`
 *   seconds — the quiet window absorbs the gap between a child's terminal
 *   write and the creation of its follow-up task.
 * - "timedOut": at least one member is not terminal, and none changed for
 *   `timeoutMin` minutes — the last-resort backstop so a thread never hangs
 *   forever.
 */
export function closureState(
  ask: AgentTask,
  closure: AgentTask[],
  now: Date,
  settleSec: number,
  timeoutMin: number,
): ClosureState {
  const members = [ask, ...closure];
  const mostRecentMs = Math.max(...members.map(mostRecentActivityMs));
  const allTerminal = members.every((member) => isTerminalTaskStatus(member.status));
  if (allTerminal) {
    const quietSec = (now.getTime() - mostRecentMs) / 1_000;
    return quietSec >= settleSec ? "settled" : "open";
  }
  const idleMin = (now.getTime() - mostRecentMs) / 60_000;
  return idleMin >= timeoutMin ? "timedOut" : "open";
}
