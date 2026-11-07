// Numbers for the Home metrics strip, from the Usage summary and the key pool.

import type { ApiKeyStatus, UsageSummaryDailyRow } from "../api/types";

/** The UTC day (`YYYY-MM-DD`) the usage summary groups `ms` under. */
export function usageDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface SpendStats {
  /** Spend on `today`, 0 when the day has no row yet. */
  today: number;
  /** Mean daily spend over the days before `today` in the rows, null with none. */
  average: number | null;
  /** Daily spend, oldest first, ending with `today`. */
  series: number[];
}

/** Today's spend against the average of the earlier days in `daily`. */
export function spendStats(daily: UsageSummaryDailyRow[], today: string): SpendStats {
  const rows = [...daily].sort((a, b) => a.date.localeCompare(b.date));
  const before = rows.filter((row) => row.date < today);
  const todayCost = rows.find((row) => row.date === today)?.costUsd ?? 0;
  const average =
    before.length > 0 ? before.reduce((sum, row) => sum + row.costUsd, 0) / before.length : null;
  return { today: todayCost, average, series: [...before.map((row) => row.costUsd), todayCost] };
}

/** `+23%` / `-8%` of `value` against `base`, or null when there is no base. */
export function percentDelta(value: number, base: number | null): string | null {
  if (base === null || base <= 0) return null;
  const pct = Math.round(((value - base) / base) * 100);
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

export interface PlanUsage {
  /** Highest 5-hour window use across the keys, as a whole percent. */
  fiveHour: number | null;
  /** Highest 7-day window use across the keys, as a whole percent. */
  sevenDay: number | null;
  /** When the busiest 5-hour window resets (ms since epoch). */
  fiveHourResetsAt: number | null;
}

function windowUse(
  key: ApiKeyStatus,
  name: string,
): { pct: number; resetsAt: number | null } | null {
  const window = key.rateLimitWindows?.[name];
  if (!window || typeof window.utilization !== "number") return null;
  // The API sends `resetsAt` in seconds.
  const resetsAt = typeof window.resetsAt === "number" ? window.resetsAt * 1000 : null;
  return { pct: Math.round(window.utilization * 100), resetsAt };
}

/**
 * The subscription plan use the swarm is closest to running out of: the
 * busiest key's 5-hour and 7-day windows. Null when no key reports a window.
 */
export function planUsage(keys: ApiKeyStatus[]): PlanUsage | null {
  let fiveHour: { pct: number; resetsAt: number | null } | null = null;
  let sevenDay: number | null = null;
  for (const key of keys) {
    const five = windowUse(key, "five_hour");
    if (five && (!fiveHour || five.pct > fiveHour.pct)) fiveHour = five;
    const seven = windowUse(key, "seven_day");
    if (seven && (sevenDay === null || seven.pct > sevenDay)) sevenDay = seven.pct;
  }
  if (!fiveHour && sevenDay === null) return null;
  return {
    fiveHour: fiveHour?.pct ?? null,
    sevenDay,
    fiveHourResetsAt: fiveHour?.resetsAt ?? null,
  };
}

/** Share of the prompt tokens served from the cache, as a whole percent. */
export function cacheShare(input: number, cacheRead: number, cacheWrite: number): number | null {
  const prompt = input + cacheRead + cacheWrite;
  return prompt > 0 ? Math.round((cacheRead / prompt) * 100) : null;
}
