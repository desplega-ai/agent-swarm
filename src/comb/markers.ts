// The "sent" reply that "Send to swarm" posts on each comment. The dashboard
// keeps its own copy of the pattern and the rule in
// `apps/ui/src/lib/comb/markers.ts`. `src/tests/comb-markers.test.ts` checks
// that both copies agree.

export const SENT_MARKER_PREFIX = "[comb:sent task=";

/** The machine-readable "sent" reply. Group 1 is the task id. */
export const SENT_MARKER_RE = /^\[comb:sent task=([0-9a-f-]{36})\]/;

/** The opening of a "sent" reply for `taskId`. */
export function sentMarker(taskId: string): string {
  return `${SENT_MARKER_PREFIX}${taskId}]`;
}

interface Authored {
  body: string;
  author: string;
}

/**
 * The task id of the thread's "sent" reply, or null. The reply starts with
 * the marker, and the swarm service account wrote it. Without a known service
 * account, any author except the thread's own author counts.
 */
export function sentTaskId(
  thread: { author: string },
  replies: ReadonlyArray<Authored>,
  serviceUserId: string | null,
): string | null {
  for (const reply of replies) {
    const bySwarm = serviceUserId ? reply.author === serviceUserId : reply.author !== thread.author;
    const taskId = bySwarm ? SENT_MARKER_RE.exec(reply.body)?.[1] : undefined;
    if (taskId) return taskId;
  }
  return null;
}
