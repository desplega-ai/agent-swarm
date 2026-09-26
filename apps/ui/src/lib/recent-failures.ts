import type { AgentTask } from "../api/types";
import { parseUTCDate } from "./utils";

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface RecentFailures {
  /** Failed tasks that finished inside the window, newest first. */
  tasks: AgentTask[];
  /**
   * False when the fetched page may have cut off older failures inside the
   * window, so the count is a lower bound ("20+"), not a total.
   */
  complete: boolean;
}

/**
 * Failures that finished in the last `windowMs`, from one page of failed
 * tasks ordered by `lastUpdatedAt` DESC.
 *
 * A task's `lastUpdatedAt` is never earlier than its `finishedAt`, so every
 * failure that finished in the window sorts ahead of any row last touched
 * before it. The page is therefore complete when it was not full, or when its
 * last row was already last touched before the window opened. Otherwise
 * failures edited recently but finished earlier may have taken the page's
 * slots, and the count is only a lower bound.
 */
export function summarizeRecentFailures(
  page: AgentTask[],
  limit: number,
  now: number,
  windowMs = DAY_MS,
): RecentFailures {
  const since = now - windowMs;
  const tasks = page.filter(
    (t) => parseUTCDate(t.finishedAt ?? t.lastUpdatedAt).getTime() >= since,
  );
  const last = page.at(-1);
  const complete =
    page.length < limit || !last || parseUTCDate(last.lastUpdatedAt).getTime() < since;
  return { tasks, complete };
}
