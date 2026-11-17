/**
 * Lowest-usage-first key ranking, with a 10-point band. Pure: shared by `GET /api/keys/available`
 * (which computes the figure from stored windows) and the worker picker
 * (`selectCredential`). It only orders admissible keys; it never excludes one.
 */

/** Key-wide windows that count as a key's usage. Model-scoped weekly windows do not. */
export const KEY_USAGE_WINDOWS = ["five_hour", "seven_day"] as const;

type UsageWindow = { utilization?: number; resetsAt?: number };

/**
 * A key's current usage, as a utilization fraction (0..1, can exceed 1): the
 * max over its non-expired `five_hour` and `seven_day` windows. A window past
 * `resetsAt` (epoch seconds) counts as 0. No observation counts as 0, so a
 * fresh key ranks first.
 */
export function keyUsageFromWindows(
  windows: Record<string, UsageWindow> | null | undefined,
  nowMs: number,
): number {
  let usage = 0;
  for (const name of KEY_USAGE_WINDOWS) {
    const window = windows?.[name];
    if (!window || typeof window.utilization !== "number" || !Number.isFinite(window.utilization))
      continue;
    if (typeof window.resetsAt === "number" && window.resetsAt * 1000 <= nowMs) continue;
    usage = Math.max(usage, window.utilization);
  }
  return usage;
}

/**
 * Width of the low-usage band, as a utilization fraction. Every admissible key
 * within this distance of the lowest usage is an equal candidate.
 */
export const KEY_USAGE_BAND = 0.1;

/**
 * Picks the key for a draw among `indices`:
 * 1. the keys whose usage is within `band` of the lowest;
 * 2. among them, the keys with the fewest running sessions (`sessionsByIndex`);
 * 3. ties at random.
 *
 * A plain minimum would send every concurrent draw to one key until the next
 * usage report lands. The session count moves at session start, so a burst
 * spreads within seconds; the band still covers draws that land before the
 * session-start report. An index with no usage or session entry counts as 0.
 */
export function pickLowestUsage(
  indices: readonly number[],
  usageByIndex: readonly (number | null | undefined)[] | undefined,
  sessionsByIndex?: readonly (number | null | undefined)[],
  random: () => number = Math.random,
  band: number = KEY_USAGE_BAND,
): number | undefined {
  if (indices.length === 0) return undefined;
  const entryAt = (values: typeof usageByIndex, i: number) => {
    const value = values?.[i];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const lowest = Math.min(...indices.map((i) => entryAt(usageByIndex, i)));
  // The epsilon keeps a key exactly `band` above the lowest inside the band.
  const inBand = indices.filter((i) => entryAt(usageByIndex, i) <= lowest + band + 1e-9);
  const fewest = Math.min(...inBand.map((i) => entryAt(sessionsByIndex, i)));
  const best = inBand.filter((i) => entryAt(sessionsByIndex, i) === fewest);
  return best[Math.floor(random() * best.length)];
}
