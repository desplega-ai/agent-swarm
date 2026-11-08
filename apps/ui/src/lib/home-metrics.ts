// Numbers for the Home metrics strip, from the Usage summary.

import type { UsageSummaryDailyRow } from "../api/types";

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

/** Share of the prompt tokens served from the cache, as a whole percent. */
export function cacheShare(input: number, cacheRead: number, cacheWrite: number): number | null {
  const prompt = input + cacheRead + cacheWrite;
  return prompt > 0 ? Math.round((cacheRead / prompt) * 100) : null;
}
