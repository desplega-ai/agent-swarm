// Numbers for the Home metrics strip, from the Usage summary.

import type { UsageSummaryDailyRow } from "../api/types";

/** The UTC day (`YYYY-MM-DD`) the usage summary groups `ms` under. */
export function usageDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface DailySeries {
  /** Today's value, 0 when the day has no row yet. */
  today: number;
  /** One value a day, oldest first, ending with `today`. */
  series: number[];
}

/** Daily spend, ending with `today`. */
export function spendStats(daily: UsageSummaryDailyRow[], today: string): DailySeries {
  return dailySeries(daily, today, (row) => row.costUsd);
}

/** Daily cost per session, ending with `today`. A day without sessions is 0. */
export function costPerSessionSeries(daily: UsageSummaryDailyRow[], today: string): DailySeries {
  return dailySeries(daily, today, (row) => (row.sessions > 0 ? row.costUsd / row.sessions : 0));
}

function dailySeries(
  daily: UsageSummaryDailyRow[],
  today: string,
  value: (row: UsageSummaryDailyRow) => number,
): DailySeries {
  const rows = [...daily].sort((a, b) => a.date.localeCompare(b.date));
  const before = rows.filter((row) => row.date < today).map(value);
  const todayRow = rows.find((row) => row.date === today);
  const todayValue = todayRow ? value(todayRow) : 0;
  return { today: todayValue, series: [...before, todayValue] };
}

/** Share of the prompt tokens served from the cache, as a whole percent. */
export function cacheShare(input: number, cacheRead: number, cacheWrite: number): number | null {
  const prompt = input + cacheRead + cacheWrite;
  return prompt > 0 ? Math.round((cacheRead / prompt) * 100) : null;
}
