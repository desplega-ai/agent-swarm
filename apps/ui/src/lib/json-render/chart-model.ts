/**
 * Pure data shaping for the catalog `Chart` and the `Metric` sparkline, kept
 * out of the React file so it is unit-testable without a DOM.
 */

import { format as formatDate } from "date-fns";
import type { ChartColor } from "./catalog";
import { type NumberFormat, numberFormatter } from "./format-number";

export type ChartValueFormat = NumberFormat;

/** One plotted point: `__x` is the axis value (a label, or epoch ms on a time axis). */
export type ChartPoint = { __x: string | number } & Record<string, number | null | string>;

// The brand color leads (chart-1 is off-brand blue in the dark theme), then the chart tokens.
const PALETTE: ChartColor[] = ["primary", "chart-2", "chart-3", "chart-4", "chart-5"];
/**
 * Pie and donut slices sit side by side, so they need more distinct colors
 * than series do: chart-3 (amber) is last because it is closest to primary.
 */
const PIE_PALETTE: ChartColor[] = [
  "primary",
  "chart-2",
  "chart-4",
  "chart-5",
  "chart-1",
  "muted",
  "chart-3",
];

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

/**
 * CSS color for series `index` when series sit side by side and carry no
 * `color` of their own. The series palette repeats the brand color as
 * chart-3 in the dark theme, so the 3rd series would match the 1st.
 */
export function distinctSeriesColor(index: number): string {
  return COLOR_VARS[PIE_PALETTE[index % PIE_PALETTE.length] as ChartColor];
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

/** Axis-tick (`compact`) and tooltip formatter; see `numberFormatter`. */
export const chartValueFormatter = numberFormatter;

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

/** One pie or donut slice: the row's `x` label, its value and its share of the total. */
export type PieSlice = { label: string; value: number; percent: number; color: string };

/**
 * Rows → pie slices, in row order. `x` is the slice label and `key` the one
 * series value. A slice needs a positive number: zero, negative and missing
 * values draw nothing, so they are dropped before the shares are computed.
 */
export function toPieSlices(
  rows: readonly Record<string, unknown>[],
  x: string,
  key: string,
): PieSlice[] {
  const kept: { label: string; value: number }[] = [];
  for (const row of rows) {
    const value = toNumber(row[key]);
    if (value === null || value <= 0) continue;
    const raw = row[x];
    kept.push({ label: raw === null || raw === undefined ? "" : String(raw), value });
  }
  const total = kept.reduce((sum, slice) => sum + slice.value, 0);
  const colors = kept.map((_, index) => PIE_PALETTE[index % PIE_PALETTE.length] as ChartColor);
  // The last slice touches the first: when the palette wraps onto the first
  // color, take one that neither neighbour uses.
  const last = colors.length - 1;
  if (last > 1 && colors[last] === colors[0]) {
    colors[last] = PIE_PALETTE.find((c) => c !== colors[0] && c !== colors[last - 1]) as ChartColor;
  }
  return kept.map((slice, index) => ({
    ...slice,
    percent: slice.value / total,
    color: seriesColor(colors[index], index),
  }));
}

/** Slice label text: the share as a whole percent, `<1%` for a sliver. */
export function pieShareLabel(percent: number): string {
  if (percent > 0 && percent < 0.005) return "<1%";
  return `${Math.round(percent * 100)}%`;
}
