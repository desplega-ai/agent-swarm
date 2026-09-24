import type { AgentTaskStatus } from "@/api/types";

export const TERMINAL_STATUSES: ReadonlySet<AgentTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "superseded",
]);

/** `true` only when every task in the list has reached a terminal status. */
export function allTasksTerminal(tasks: { status: AgentTaskStatus }[]): boolean {
  return tasks.every((t) => TERMINAL_STATUSES.has(t.status));
}

/** Session poll cadence while any task in the chain is active; matches `ChainOfThought`. */
export const SESSION_ACTIVE_POLL_MS = 4000;
/** Session poll cadence once the chain settles; matches the QueryClient default in `app/providers.tsx`. */
export const SESSION_SETTLED_POLL_MS = 10_000;

/**
 * `refetchInterval` for `useSession`. Never returns `false`: tasks can join a
 * chain after it settles (defer wake-ups, the Lead review follow-up, promoted
 * steering), so a settled session keeps polling at the slower default.
 */
export function sessionRefetchInterval(
  data: { root: { status: AgentTaskStatus }; chain: { status: AgentTaskStatus }[] } | undefined,
): number {
  if (!data || !allTasksTerminal([data.root, ...data.chain])) return SESSION_ACTIVE_POLL_MS;
  return SESSION_SETTLED_POLL_MS;
}

/**
 * Tri-state liveness for a task, used by the session-log viewer footer.
 *
 * - `true`      → actively working (`in_progress`) → "Agent is working…"
 * - `false`     → finished (`completed` / `failed` / `cancelled` / `superseded`)
 *                 → "Session complete"
 * - `undefined` → indeterminate (queued, paused, reviewing, …) → neutral footer,
 *                 so we never falsely claim a paused/pending task is "complete".
 */
export function taskIsRunning(status: AgentTaskStatus | undefined): boolean | undefined {
  if (!status) return undefined;
  if (status === "in_progress") return true;
  if (TERMINAL_STATUSES.has(status)) return false;
  return undefined;
}
