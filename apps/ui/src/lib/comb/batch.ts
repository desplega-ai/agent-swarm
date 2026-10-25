// Which comments "Send to swarm" offers. Relative imports only: `bun:test`
// runs this from the repo root.

import type { CombReviewBatchResult } from "../../api/types";
import type { CommentListEntry } from "../agent-fs/types";
import { commentCombPath } from "./comments";
import { isSentToSwarm } from "./markers";

/**
 * Most comments one send carries (the server's `REVIEW_BATCH_MAX`,
 * `src/tests/comb-review-batch.test.ts` checks that they match).
 */
export const COMB_BATCH_MAX = 50;

/**
 * Longest note for the lead (the server's `REVIEW_NOTE_MAX`,
 * `src/tests/comb-review-batch.test.ts` checks that they match).
 */
export const COMB_NOTE_MAX = 4000;

/** The note to send: trimmed, and left out when empty. */
export function batchNote(text: string): string | undefined {
  const note = text.trim();
  return note ? note : undefined;
}

/**
 * A thread that "Send to swarm" offers: an open root comment that was not
 * sent yet. `@swarm` is not needed (it only flags a comment). The one-thread
 * button and the "N not sent" count use the same rule. The server applies
 * the same skips (`src/comb/review-batch.ts`).
 */
export function canSendThread(
  thread: CommentListEntry,
  serviceUserId: string | null = null,
): boolean {
  return !thread.resolved && !thread.parentId && !isSentToSwarm(thread, serviceUserId);
}

/** The threads "Send N to swarm" (a file or a folder) offers (`canSendThread`). */
export function eligibleForBatch(
  threads: ReadonlyArray<CommentListEntry>,
  serviceUserId: string | null = null,
): CommentListEntry[] {
  return threads.filter((thread) => canSendThread(thread, serviceUserId));
}

/**
 * The send tray's comments: the open root comments of `me` (the connected
 * agent-fs user) that were not sent yet, by file path, oldest first in a
 * file. Null `me` (not connected): none.
 */
export function myUnsent(
  threads: ReadonlyArray<CommentListEntry>,
  me: string | null,
  serviceUserId: string | null = null,
): CommentListEntry[] {
  if (!me) return [];
  return eligibleForBatch(threads, serviceUserId)
    .filter((thread) => thread.author === me)
    .sort(
      (a, b) =>
        commentCombPath(a.path).localeCompare(commentCombPath(b.path)) ||
        a.createdAt.localeCompare(b.createdAt),
    );
}

/** Threads by file (`/docs/a.md`), in the order the files first appear. */
export function groupByFile(
  threads: ReadonlyArray<CommentListEntry>,
): Array<{ path: string; threads: CommentListEntry[] }> {
  const groups = new Map<string, CommentListEntry[]>();
  for (const thread of threads) {
    const path = commentCombPath(thread.path);
    groups.set(path, [...(groups.get(path) ?? []), thread]);
  }
  return [...groups].map(([path, list]) => ({ path, threads: list }));
}

/** Who got the task of a send (`lead` in the result). */
export type SendLead = NonNullable<CombReviewBatchResult["lead"]>;

/**
 * The toast line about the lead. Null when a lead got the task, and for an
 * older server that does not say.
 */
export function leadNote(lead: SendLead | undefined): string | null {
  if (lead === "none") return "No lead yet. The task waits in the pool until an agent takes it.";
  if (lead === "offline") return "The lead is offline. It starts on the task when it is back.";
  return null;
}

/**
 * A failed send as a toast: a title that says what happened (`status` 0 is
 * no answer at all), and the server's words where they add detail. A 409
 * gets its description from the skipped comments.
 */
export function sendFailure(
  status: number,
  message: string,
): { title: string; description?: string } {
  switch (status) {
    case 0:
      return {
        title: "Cannot reach the swarm API",
        description: "Nothing was sent. Check the connection and try again.",
      };
    case 400:
      return { title: "The swarm refused this send", description: message };
    case 401:
      return {
        title: "The swarm rejected the API key",
        description: "Nothing was sent. Connect the dashboard again.",
      };
    case 403:
      return {
        title: "You cannot send comments to the swarm",
        description: "Sending creates a task. Ask a swarm admin for permission to create tasks.",
      };
    case 404:
      return { title: "Comb is off on this swarm", description: "Nothing was sent." };
    case 409:
      return { title: "Nothing new to send" };
    case 422:
      return { title: "An extension blocked the task", description: message };
    case 502:
      return {
        title: "agent-fs could not read a comment",
        description: `Nothing was sent. Try again. ${message}`,
      };
    case 503:
      return { title: message || "agent-fs is not set up", description: "Nothing was sent." };
    default:
      return {
        title: "Could not send to the swarm",
        description: message || `The swarm answered ${status}.`,
      };
  }
}
