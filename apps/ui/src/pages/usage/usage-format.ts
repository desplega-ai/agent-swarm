import { formatDuration } from "@/lib/utils";

export const DAY_MS = 86_400_000;

const USD_WHOLE = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const USD_CENTS = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Money on the usage page: thousands separators, whole dollars from $1,000,
 * cents below. The app-wide `formatCost` keeps its own presets.
 */
export function formatUsd(amount: number): string {
  return Math.abs(amount) >= 1000 ? USD_WHOLE.format(amount) : USD_CENTS.format(amount);
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** Whole hours from one hour up ("984h"), else minutes and seconds. */
export function formatRunTime(ms: number): string {
  const hours = ms / 3_600_000;
  return hours >= 1 ? `${formatCount(Math.round(hours))}h` : formatDuration(ms);
}

/** A `YYYY-MM-DD` day as "Sep 25" (or "Sep 25, 2026"). */
export function formatDay(isoDay: string, withYear = false): string {
  return new Date(`${isoDay}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(withYear && { year: "numeric" }),
    timeZone: "UTC",
  });
}

/** Today as a UTC `YYYY-MM-DD` day, the unit the daily rows use. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
