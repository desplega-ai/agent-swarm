// Which comments "Send N to swarm" counts. Relative imports only: `bun:test`
// runs this from the repo root.

import type { CommentListEntry } from "../agent-fs/types";
import { hasSwarmMarker, isSentToSwarm } from "./markers";

/**
 * A thread that "Send to swarm" (one thread) accepts: an open root comment
 * that was not sent yet. `@swarm` is not needed for a one-thread send.
 */
export function canSendThread(
  thread: CommentListEntry,
  serviceUserId: string | null = null,
): boolean {
  return !thread.resolved && !thread.parentId && !isSentToSwarm(thread, serviceUserId);
}

/**
 * The threads "Send N to swarm" (a file or a folder) offers: open root
 * comments that carry `@swarm` and were not sent yet.
 */
export function eligibleForBatch(
  threads: ReadonlyArray<CommentListEntry>,
  serviceUserId: string | null = null,
): CommentListEntry[] {
  return threads.filter(
    (thread) => canSendThread(thread, serviceUserId) && hasSwarmMarker(thread.body),
  );
}
