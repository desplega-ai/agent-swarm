/**
 * Pure logic for the catalog `DateRange` and `Timeline`, kept out of the React
 * file so it is unit-testable without a DOM.
 */

import { addDays, format as formatDate, isSameDay, startOfMonth, subDays } from "date-fns";
import { toTimestamp } from "./chart-model";

export const DATE_RANGE_PRESETS = ["7d", "30d", "90d", "mtd", "custom"] as const;
export type DateRangePreset = (typeof DATE_RANGE_PRESETS)[number];

export const DATE_RANGE_LABELS: Record<DateRangePreset, string> = {
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  mtd: "Month to date",
  custom: "Custom",
};

/** A local calendar date as `YYYY-MM-DD`. */
export function isoDate(date: Date): string {
  return formatDate(date, "yyyy-MM-dd");
}

/**
 * The inclusive `{ from, to }` ISO dates of a fixed preset, ending today.
 * `7d` is today and the six days before it. `custom` has no fixed range.
 */
export function presetRange(
  preset: Exclude<DateRangePreset, "custom">,
  now: Date = new Date(),
): { from: string; to: string } {
  const to = isoDate(now);
  if (preset === "mtd") return { from: isoDate(startOfMonth(now)), to };
  const days = preset === "7d" ? 7 : preset === "30d" ? 30 : 90;
  return { from: isoDate(subDays(now, days - 1)), to };
}

/** True for a real `YYYY-MM-DD` calendar date. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00`);
  return !Number.isNaN(parsed.getTime()) && isoDate(parsed) === value;
}

/** A custom range is usable when both ends are dates and `from` is not after `to`. */
export function validCustomRange(from: unknown, to: unknown): boolean {
  return isIsoDate(from) && isIsoDate(to) && from <= to;
}

export type TimelineEntry = { row: Record<string, unknown>; index: number; ms: number };
export type TimelineDay = { key: string; label: string; entries: TimelineEntry[] };

/** "Today", "Yesterday", else the full date. */
export function timelineDayLabel(ms: number, now: Date = new Date()): string {
  if (isSameDay(ms, now)) return "Today";
  if (isSameDay(addDays(ms, 1), now)) return "Yesterday";
  return formatDate(ms, "EEE, MMM d, yyyy");
}

/**
 * Rows → day groups, newest first, by the local day of `timeField` (an ISO
 * date or epoch ms). Rows whose time does not parse are dropped. `index` is
 * the row's position in `rows`, published as `$rowIndex` on select.
 */
export function groupTimeline(
  rows: readonly Record<string, unknown>[],
  timeField: string,
  now: Date = new Date(),
): TimelineDay[] {
  const entries: TimelineEntry[] = [];
  rows.forEach((row, index) => {
    const ms = toTimestamp(row[timeField]);
    if (ms !== null) entries.push({ row, index, ms });
  });
  entries.sort((a, b) => b.ms - a.ms);
  const days: TimelineDay[] = [];
  for (const entry of entries) {
    const key = isoDate(new Date(entry.ms));
    const last = days[days.length - 1];
    if (last && last.key === key) last.entries.push(entry);
    else days.push({ key, label: timelineDayLabel(entry.ms, now), entries: [entry] });
  }
  return days;
}
