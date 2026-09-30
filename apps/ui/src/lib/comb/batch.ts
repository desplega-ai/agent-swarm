// Which comments "Send to swarm" offers. Relative imports only: `bun:test`
// runs this from the repo root.

import type { CommentListEntry } from "../agent-fs/types";
import { hasSwarmMarker, isSentToSwarm } from "./markers";

/**
 * Most comments one send carries (the server's `REVIEW_BATCH_MAX`,
 * `src/tests/comb-review-batch.test.ts` checks that they match).
 */
export const COMB_BATCH_MAX = 50;

/**
 * A thread that "Send to swarm" offers: an open root comment that carries
 * `@swarm` and was not sent yet. The one-thread button and the "Send N"
 * count use the same rule.
 */
export function canSendThread(
  thread: CommentListEntry,
  serviceUserId: string | null = null,
): boolean {
  return (
    !thread.resolved &&
    !thread.parentId &&
    hasSwarmMarker(thread.body) &&
    !isSentToSwarm(thread, serviceUserId)
  );
}

/** The threads "Send N to swarm" (a file or a folder) offers (`canSendThread`). */
export function eligibleForBatch(
  threads: ReadonlyArray<CommentListEntry>,
  serviceUserId: string | null = null,
): CommentListEntry[] {
  return threads.filter((thread) => canSendThread(thread, serviceUserId));
}
