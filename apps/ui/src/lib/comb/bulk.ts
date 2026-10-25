// Bulk comment actions for the folder "Open comments" panel: the age filter,
// the selection helpers, and a runner that resolves many comments a few at a
// time. agent-fs resolves one comment per `comment-resolve` call.
//
// Relative imports only: `bun:test` runs this from the repo root.

/** `comment-resolve` calls in flight at once. */
export const BULK_CONCURRENCY = 4;

const DAY_MS = 24 * 60 * 60_000;

export type AgeFilter = "any" | "week" | "month";

export const AGE_FILTERS: ReadonlyArray<{ value: AgeFilter; label: string; days: number }> = [
  { value: "any", label: "Any age", days: 0 },
  { value: "week", label: "Older than 7 days", days: 7 },
  { value: "month", label: "Older than 30 days", days: 30 },
];

/**
 * True when the comment is older than the filter's age at `now`. "any" keeps
 * every comment. A comment with an unreadable date passes only "any".
 */
export function matchesAge(
  comment: { createdAt: string },
  filter: AgeFilter,
  now: number,
): boolean {
  const days = AGE_FILTERS.find((item) => item.value === filter)?.days ?? 0;
  if (days === 0) return true;
  const created = Date.parse(comment.createdAt);
  return Number.isFinite(created) && now - created > days * DAY_MS;
}

/** The select-all box for `ids`: checked, unchecked, or "indeterminate" (some). */
export function selectionState(
  selected: ReadonlySet<string>,
  ids: ReadonlyArray<string>,
): boolean | "indeterminate" {
  const count = ids.filter((id) => selected.has(id)).length;
  if (count === 0) return false;
  return count === ids.length ? true : "indeterminate";
}

/** `selected` with every id of `ids` added (`on`) or removed. */
export function setAll(
  selected: ReadonlySet<string>,
  ids: ReadonlyArray<string>,
  on: boolean,
): Set<string> {
  const next = new Set(selected);
  for (const id of ids) {
    if (on) next.add(id);
    else next.delete(id);
  }
  return next;
}

/** `selected` without the ids that are no longer listed. The same set when nothing went. */
export function pruneSelection(selected: Set<string>, listed: ReadonlyArray<string>): Set<string> {
  const keep = new Set(listed);
  for (const id of selected) {
    if (!keep.has(id)) return new Set([...selected].filter((other) => keep.has(other)));
  }
  return selected;
}

export interface BulkOutcome<T> {
  done: T[];
  failed: Array<{ item: T; error: unknown }>;
}

/**
 * Runs `worker` on every item, at most `limit` at a time, and never rejects:
 * a failed item lands in `failed`. `onProgress` gets the count of finished
 * items after each one. `done` keeps the input order.
 */
export async function runLimited<T>(
  items: ReadonlyArray<T>,
  limit: number,
  worker: (item: T) => Promise<unknown>,
  onProgress?: (finished: number) => void,
): Promise<BulkOutcome<T>> {
  const ok = new Array<boolean>(items.length).fill(false);
  const failed: BulkOutcome<T>["failed"] = [];
  let next = 0;
  let finished = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      const item = items[index] as T;
      try {
        await worker(item);
        ok[index] = true;
      } catch (error) {
        failed.push({ item, error });
      }
      finished++;
      onProgress?.(finished);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return { done: items.filter((_, index) => ok[index]), failed };
}

/** The toast after a bulk resolve or reopen: "Resolved 12 comments", "Resolved 10. 2 failed". */
export function bulkSummary(verb: "Resolved" | "Reopened", done: number, failed: number): string {
  if (failed === 0) return `${verb} ${done} ${done === 1 ? "comment" : "comments"}`;
  return `${verb} ${done}. ${failed} failed`;
}
