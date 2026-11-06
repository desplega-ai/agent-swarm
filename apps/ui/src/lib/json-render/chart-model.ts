/**
 * Pure data shaping for the catalog `Chart` and the `Metric` sparkline, kept
 * out of the React file so it is unit-testable without a DOM.
 */

import { format as formatDate } from "date-fns";
import type { ChartColor } from "./catalog";

export type ChartValueFormat = "number" | "currency" | "percent";

/** One plotted point: `__x` is the axis value (a label, or epoch ms on a time axis). */
export type ChartPoint = { __x: string | number } & Record<string, number | null | string>;

// The brand color leads (chart-1 is off-brand blue in the dark theme), then the chart tokens.
const PALETTE: ChartColor[] = ["primary", "chart-2", "chart-3", "chart-4", "chart-5"];

const COLOR_VARS: Record<ChartColor, string> = {
  "chart-1": "var(--color-chart-1)",
  "chart-2": "var(--color-chart-2)",
  "chart-3": "var(--color-chart-3)",
  "chart-4": "var(--color-chart-4)",
  "chart-5": "var(--color-chart-5)",
  primary: "var(--color-primary)",
  success: "var(--color-status-success)",
  warning: "var(--color-status-warning)",
  error: "var(--color-status-error)",
  info: "var(--color-status-info)",
  muted: "var(--color-muted-foreground)",
};

/** CSS color for series `index`: its own `color`, else the palette in order. */
export function seriesColor(color: ChartColor | undefined, index: number): string {
  return COLOR_VARS[color ?? (PALETTE[index % PALETTE.length] as ChartColor)];
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") {
    return null;
  }
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** ISO date/datetime string or epoch ms → epoch ms; anything else → null. */
export function toTimestamp(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Rows → plot points. A category axis keeps row order and stringifies `x`; a
 * time axis drops rows whose `x` does not parse and sorts by time. Series
 * values that are not finite numbers become `null` (a gap, not a zero).
 */
export function toChartPoints(
  rows: readonly Record<string, unknown>[],
  x: string,
  xType: "category" | "time",
  seriesKeys: readonly string[],
): ChartPoint[] {
  const points: ChartPoint[] = [];
  for (const row of rows) {
    const raw = row[x];
    let axis: string | number;
    if (xType === "time") {
      const ms = toTimestamp(raw);
      if (ms === null) continue;
      axis = ms;
    } else {
      axis = raw === null || raw === undefined ? "" : String(raw);
    }
    const point: ChartPoint = { __x: axis };
    for (const key of seriesKeys) point[key] = toNumber(row[key]);
    points.push(point);
  }
  if (xType === "time") points.sort((a, b) => (a.__x as number) - (b.__x as number));
  return points;
}

/** Number formatter for axis ticks (`compact`) and the tooltip. */
export function chartValueFormatter(
  format: ChartValueFormat = "number",
  currency = "USD",
  compact = false,
): (value: number) => string {
  const options: Intl.NumberFormatOptions =
    format === "currency"
      ? { style: "currency", currency, maximumFractionDigits: compact ? 0 : 2 }
      : format === "percent"
        ? { style: "percent", maximumFractionDigits: compact ? 0 : 1 }
        : { maximumFractionDigits: 2 };
  if (compact && format !== "percent") options.notation = "compact";
  const formatter = new Intl.NumberFormat(undefined, options);
  return (value) => formatter.format(value);
}

function isLocalMidnight(ms: number): boolean {
  const date = new Date(ms);
  return date.getHours() === 0 && date.getMinutes() === 0;
}

function localDayKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * Date label for a time axis. Points within one local day show the clock
 * only. Once they cross a day, every tick carries its date (a midnight tick
 * shows just the date), so two consecutive days never share a label.
 */
export function timeTickFormatter(points: readonly ChartPoint[]): (ms: number) => string {
  const first = points[0]?.__x;
  const last = points[points.length - 1]?.__x;
  const crossesDays =
    typeof first === "number" &&
    typeof last === "number" &&
    localDayKey(first) !== localDayKey(last);
  if (!crossesDays) return (ms) => formatDate(ms, "HH:mm");
  return (ms) => formatDate(ms, isLocalMidnight(ms) ? "MMM d" : "MMM d HH:mm");
}

/** Tooltip date: drops the clock when every point sits on local midnight. */
export function timeLabelFormatter(points: readonly ChartPoint[]): (ms: number) => string {
  const allMidnight = points.every((point) => isLocalMidnight(point.__x as number));
  return (ms) => formatDate(ms, allMidnight ? "MMM d, yyyy" : "MMM d, yyyy HH:mm");
}

/**
 * `Metric.sparkline` → plot values: numbers pass through (`null` stays a gap),
 * rows are read through `key` (no key → no line). Fewer than two numbers → [].
 */
export function sparklineValues(raw: unknown, key: string | undefined): (number | null)[] {
  if (!Array.isArray(raw)) return [];
  const values = raw.map((entry) =>
    entry !== null && typeof entry === "object"
      ? key
        ? toNumber((entry as Record<string, unknown>)[key])
        : null
      : toNumber(entry),
  );
  return values.filter((value) => value !== null).length >= 2 ? values : [];
}
