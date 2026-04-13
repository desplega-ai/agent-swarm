import { getLastRunStart, getLastSuccessfulRun } from "../be/db";
import type { CooldownConfig } from "../types";

/**
 * Convert a CooldownConfig to total milliseconds.
 */
function cooldownToMs(cooldown: CooldownConfig): number {
  let ms = 0;
  if (cooldown.hours) ms += cooldown.hours * 60 * 60 * 1000;
  if (cooldown.minutes) ms += cooldown.minutes * 60 * 1000;
  if (cooldown.seconds) ms += cooldown.seconds * 1000;
  return ms;
}

/**
 * Check if a workflow should be skipped due to cooldown.
 * Returns true if:
 * - the last successful run finished within the cooldown window, OR
 * - any run (including failed ones) started within the cooldown window.
 *
 * The second condition prevents runaway re-triggering when all runs fail
 * (e.g. due to rate limits): without it, a failed run would never satisfy
 * the "last completed run" check, so the cooldown would never engage.
 */
export function shouldSkipCooldown(workflowId: string, cooldown: CooldownConfig): boolean {
  const cooldownMs = cooldownToMs(cooldown);
  const now = Date.now();

  // Skip if last successful run finished within the cooldown window
  const lastSuccess = getLastSuccessfulRun(workflowId);
  if (lastSuccess?.finishedAt) {
    const lastFinished = new Date(lastSuccess.finishedAt).getTime();
    if (now - lastFinished < cooldownMs) return true;
  }

  // Skip if any run (failed or running) started within the cooldown window.
  // Prevents unlimited re-triggering when every run fails before completing.
  const lastAttempt = getLastRunStart(workflowId);
  if (lastAttempt?.startedAt) {
    const lastStarted = new Date(lastAttempt.startedAt).getTime();
    if (now - lastStarted < cooldownMs) return true;
  }

  return false;
}
