/**
 * Lowest-usage-first key ranking. Pure: shared by `GET /api/keys/available`
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
 * Picks the index with the lowest usage. Ties break at random, so equal keys
 * still spread the load. An index with no usage entry ranks as 0.
 */
export function pickLowestUsage(
  indices: readonly number[],
  usageByIndex: readonly (number | null | undefined)[] | undefined,
  random: () => number = Math.random,
): number | undefined {
  if (indices.length === 0) return undefined;
  const usageOf = (i: number) => {
    const usage = usageByIndex?.[i];
    return typeof usage === "number" && Number.isFinite(usage) ? usage : 0;
  };
  const lowest = Math.min(...indices.map(usageOf));
  const best = indices.filter((i) => usageOf(i) === lowest);
  return best[Math.floor(random() * best.length)];
}
