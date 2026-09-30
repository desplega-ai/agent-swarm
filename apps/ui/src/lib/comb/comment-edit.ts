// Who may edit or delete a comment in Comb. Relative imports only: `bun:test`
// runs this from the repo root.

import type { CommentEntry, CommentListEntry } from "../agent-fs/types";
import { isSentToSwarm, sentReplyTaskId } from "./markers";

/**
 * Why a comment cannot be edited or deleted:
 * - `swarm`: the swarm service account wrote it (a "sent" reply).
 * - `not-author`: someone else wrote it (agent-fs allows only the author).
 * - `sent`: the root went to the swarm. The swarm works from its text, so it
 *   stays as sent. Resolve it instead.
 */
export type EditBlock = "swarm" | "not-author" | "sent";

/**
 * Why the connected user (`me`) cannot edit or delete `entry` (the root of
 * `thread` or one of its replies), or null when they can. A person's own
 * replies in a sent thread stay editable: only the root is final.
 */
export function commentEditBlock(
  entry: CommentEntry,
  thread: CommentListEntry,
  me: string | null,
  serviceUserId: string | null = null,
): EditBlock | null {
  const root = entry.id === thread.id;
  if (serviceUserId !== null && entry.author === serviceUserId) return "swarm";
  if (!root && sentReplyTaskId(thread, entry, serviceUserId) !== null) return "swarm";
  if (me === null || entry.author !== me) return "not-author";
  if (root && isSentToSwarm(thread, serviceUserId)) return "sent";
  return null;
}
