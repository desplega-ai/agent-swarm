import { getDueWaitStates } from "../be/db";
import type { ExecutorRegistry } from "./executors/registry";
import { resumeWaitState } from "./resume";

let pollerTimeout: ReturnType<typeof setTimeout> | null = null;
/** Bumped by every stop, so a tick in flight can tell that its poller was stopped. */
let pollerGeneration = 0;

/**
 * Start the wait-state poller.
 *
 * Mirrors `startRetryPoller`: chains `setTimeout` (NOT `setInterval`) so the
 * next tick is only scheduled after the current one finishes. Default tick is
 * 5s — same cadence as the retry poller.
 *
 * Each tick:
 *   1. `getDueWaitStates()` — pending rows with `wakeUpAt <= now`
 *      (time mode) OR `expiresAt <= now` (event-mode timeout).
 *   2. For each row, call `resumeWaitState(id, kind, undefined, registry)`.
 *      Time-mode rows resume as `fired`; event-mode overdue rows resume as
 *      `timeout`. `resumeWaitState` is race-safe (atomic UPDATE) — concurrent
 *      callers no-op.
 *
 * Errors per row are logged and the loop continues; one bad wait must not
 * starve the rest.
 */
export function startWaitPoller(registry: ExecutorRegistry, intervalMs = 5000): void {
  if (pollerTimeout !== null) return; // Already running
  const generation = pollerGeneration;

  async function poll(): Promise<void> {
    try {
      const dueWaits = await getDueWaitStates();

      for (const wait of dueWaits) {
        try {
          // Decide resume kind from wait shape:
          //   - time mode → fired
          //   - event mode + expired → timeout
          // (Event-mode "fired by signal" goes through the bus listener in
          // Phase 3, not the poller. The poller only handles overdue rows.)
          const kind: "fired" | "timeout" = wait.mode === "time" ? "fired" : "timeout";
          await resumeWaitState(wait.id, kind, undefined, registry);
        } catch (err) {
          console.error(`[workflows] Wait poller failed for wait ${wait.id}:`, err);
        }
      }
    } catch (err) {
      console.error("[workflows] Wait poller tick error:", err);
    }

    // Schedule the next tick after this one completes, unless the poller was stopped mid-tick.
    if (generation === pollerGeneration) pollerTimeout = setTimeout(poll, intervalMs);
  }

  // Start the first tick.
  pollerTimeout = setTimeout(poll, intervalMs);
}

/** Stop the wait poller (clean shutdown). */
export function stopWaitPoller(): void {
  pollerGeneration++;
  if (pollerTimeout !== null) {
    clearTimeout(pollerTimeout);
    pollerTimeout = null;
  }
}
