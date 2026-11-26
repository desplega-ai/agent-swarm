/**
 * Lowest-score-first key ranking, with a 10-point band. Pure: shared by `GET /api/keys/available`
 * (which computes the scores from stored windows) and the worker picker
 * (`selectCredential`). It only orders admissible keys; it never excludes one.
 */

import { type ModelFamily, windowForModelFamily } from "./model-rate-limit-windows";

/** Key-wide windows that count as a key's usage. Model-scoped weekly windows do not. */
export const KEY_USAGE_WINDOWS = ["five_hour", "seven_day"] as const;

type UsageWindow = { utilization?: number; resetsAt?: number; durationMins?: number };

/**
 * How the worker ranks admissible pool keys (`CREDENTIAL_SELECTION_STRATEGY`).
 * `pace`: most under even use first (`keyPaceFromWindows`). `usage`: lowest
 * utilization first (`keyUsageFromWindows`).
 */
export const CREDENTIAL_SELECTION_STRATEGIES = ["pace", "usage"] as const;
export type CredentialSelectionStrategy = (typeof CREDENTIAL_SELECTION_STRATEGIES)[number];

/** Parses the setting. Anything but an explicit `usage` is `pace`, the default. */
export function credentialSelectionStrategy(
  value: string | undefined,
): CredentialSelectionStrategy {
  return value?.trim().toLowerCase() === "usage" ? "usage" : "pace";
}

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
 * A key's pace delta, as a fraction: used minus the share of the window that
 * has passed (the even-use point), taken as the max over the key's live
 * `five_hour` and `seven_day` windows plus the weekly window of `modelFamily`
 * (Fable, Opus, Sonnet) when given. Negative means quota that will go unused
 * by the reset; the lowest delta ranks first, so a key over pace on any of
 * those windows ranks behind one under pace on all of them. A window with no
 * utilization, no reset or a passed reset is skipped. Undefined when none
 * is left: the caller counts it as 0 (on pace), never as a reading.
 */
export function keyPaceFromWindows(
  windows: Record<string, UsageWindow> | null | undefined,
  nowMs: number,
  modelFamily?: ModelFamily,
): number | undefined {
  const modelWindow = modelFamily ? windowForModelFamily(modelFamily) : undefined;
  let pace: number | undefined;
  for (const name of [...KEY_USAGE_WINDOWS, ...(modelWindow ? [modelWindow] : [])]) {
    const window = windows?.[name];
    if (!window || typeof window.utilization !== "number" || !Number.isFinite(window.utilization))
      continue;
    if (typeof window.resetsAt !== "number" || window.resetsAt * 1000 <= nowMs) continue;
    const durationMs = (window.durationMins ?? (name === "five_hour" ? 300 : 10080)) * 60_000;
    const elapsed = Math.min(1, Math.max(0, 1 - (window.resetsAt * 1000 - nowMs) / durationMs));
    pace = Math.max(pace ?? Number.NEGATIVE_INFINITY, window.utilization - elapsed);
  }
  return pace;
}

/**
 * Width of the low-score band, as a utilization fraction. Every admissible key
 * within this distance of the lowest score (usage or pace delta) is an equal candidate.
 */
export const KEY_USAGE_BAND = 0.1;

/**
 * Picks the key for a draw among `indices`:
 * 1. the keys whose score (usage or pace delta) is within `band` of the lowest;
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
