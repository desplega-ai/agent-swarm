import { getLastSuccessfulRun } from "../be/db";
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
 * Returns true if the last successful run completed within the cooldown window.
 */
export function shouldSkipCooldown(workflowId: string, cooldown: CooldownConfig): boolean {
  const lastRun = getLastSuccessfulRun(workflowId);
  if (!lastRun?.finishedAt) return false;

  const cooldownMs = cooldownToMs(cooldown);
  const lastFinished = new Date(lastRun.finishedAt).getTime();
  const now = Date.now();

  return now - lastFinished < cooldownMs;
}
