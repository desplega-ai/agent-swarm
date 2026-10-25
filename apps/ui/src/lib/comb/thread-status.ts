// Where a comment thread stands with the swarm. "Unsent": an open comment
// that was not sent yet (the rule "Send to swarm" uses). "Processing": a sent
// comment whose task has not finished and that nobody answered yet.
//
// Relative imports only: `bun:test` runs this from the repo root.

import type { CommentListEntry } from "../agent-fs/types";
import { TERMINAL_STATUSES } from "../task-activity";
import { canSendThread } from "./batch";
import { commentCombPath } from "./comments";
import { sentReplyTaskId } from "./markers";

export type SwarmThreadStatus =
  | { kind: "none" }
  | { kind: "unsent" }
  /**
   * `answered`: a reply came after the "sent" reply from someone other than
   * the thread's author (the lead, or an agent it delegated to).
   */
  | { kind: "sent"; taskId: string; answered: boolean };

/**
 * A thread's status with the swarm. The newest "sent" reply
 * (`sentReplyTaskId`) wins. A reply by the thread's own author (a follow-up
 * while it waits) does not count as an answer. Without a "sent" reply, the
 * thread is unsent when "Send to swarm" offers it (`canSendThread`).
 */
export function swarmThreadStatus(
  thread: CommentListEntry,
  serviceUserId: string | null = null,
): SwarmThreadStatus {
  let taskId: string | null = null;
  let answered = false;
  for (const reply of thread.replies) {
    const sent = sentReplyTaskId(thread, reply, serviceUserId);
    if (sent) {
      taskId = sent;
      answered = false;
    } else if (taskId && reply.author !== thread.author) {
      answered = true;
    }
  }
  if (taskId) return { kind: "sent", taskId, answered };
  return canSendThread(thread, serviceUserId) ? { kind: "unsent" } : { kind: "none" };
}

/** The task to watch for "Processing": an open thread that was sent and not answered yet. */
export function watchedTaskId(
  thread: CommentListEntry,
  serviceUserId: string | null = null,
): string | null {
  if (thread.resolved) return null;
  const status = swarmThreadStatus(thread, serviceUserId);
  return status.kind === "sent" && !status.answered ? status.taskId : null;
}

/**
 * The threads that wait on each task (`watchedTaskId`: open, sent, not
 * answered), by task id. Each group is in file order, then oldest first.
 * The Comb home's "In progress" card lists the groups whose task runs.
 */
export function threadsByTask(
  threads: ReadonlyArray<CommentListEntry>,
  serviceUserId: string | null,
): Map<string, CommentListEntry[]> {
  const groups = new Map<string, CommentListEntry[]>();
  for (const thread of threads) {
    const taskId = watchedTaskId(thread, serviceUserId);
    if (taskId) groups.set(taskId, [...(groups.get(taskId) ?? []), thread]);
  }
  for (const group of groups.values()) {
    group.sort(
      (a, b) =>
        commentCombPath(a.path).localeCompare(commentCombPath(b.path)) ||
        a.createdAt.localeCompare(b.createdAt),
    );
  }
  return groups;
}

/** A known task status that has not finished. Unknown (loading, unreadable) is false. */
export function isTaskUnfinished(status: string | null | undefined): boolean {
  return status != null && !(TERMINAL_STATUSES as ReadonlySet<string>).has(status);
}

export type ThreadSwarmState = { kind: "unsent" } | { kind: "processing"; taskId: string };

/**
 * The unsent and processing threads of a list, by thread id. `taskStatus`
 * answers the status of a watched task (undefined while unknown). Threads
 * with neither state are absent.
 */
export function threadSwarmStates(
  threads: ReadonlyArray<CommentListEntry>,
  serviceUserId: string | null,
  taskStatus: (taskId: string) => string | undefined,
): Map<string, ThreadSwarmState> {
  const states = new Map<string, ThreadSwarmState>();
  for (const thread of threads) {
    if (thread.resolved) continue;
    const status = swarmThreadStatus(thread, serviceUserId);
    if (status.kind === "unsent") {
      states.set(thread.id, { kind: "unsent" });
    } else if (
      status.kind === "sent" &&
      !status.answered &&
      isTaskUnfinished(taskStatus(status.taskId))
    ) {
      states.set(thread.id, { kind: "processing", taskId: status.taskId });
    }
  }
  return states;
}
