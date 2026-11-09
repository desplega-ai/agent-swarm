const DEFAULT_ELIGIBILITY_SCAN_CAP = 500;

/**
 * Parse ELIGIBILITY_SCAN_CAP: a positive integer, or the 500-row default.
 *
 * `Number(value) || 500` kept a negative cap, so `getUnassignedTaskIdsForAgent`
 * stopped before its first page and no worker could auto-claim queued work
 * (#2833). Read per call, like the heartbeat thresholds, so a value hydrated
 * from `swarm_config` into `process.env` after module load still applies.
 */
export function getEligibilityScanCap(raw = process.env.ELIGIBILITY_SCAN_CAP): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_ELIGIBILITY_SCAN_CAP;
}
