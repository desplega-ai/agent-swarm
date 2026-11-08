/**
 * Kind-aware value → display text, shared by `Table` cells and `DetailList`
 * fields so the two surfaces never drift on dates (relative time), booleans
 * (yes / no) or `json` previews. Kept free of React and `@/components` imports
 * so it stays unit-testable under `bun test`.
 */
import { formatDuration, formatSmartTime } from "@/lib/utils";
import type { DetailListField, TableColumn } from "./catalog";
import { numberFormatter, toFiniteNumber } from "./format-number";
import { jsonPreview } from "./json-preview";

/** Every rendering kind a `Table` column or a `DetailList` field can declare. */
export type ValueKind = NonNullable<TableColumn["kind"] | DetailListField["kind"]>;

/** Percent (0-100) of a progress value against `max`, or null when not numeric. */
export function progressPercent(value: unknown, max: number | undefined): number | null {
  const number = typeof value === "number" ? value : Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(number))
    return null;
  const ceiling = max && max > 0 ? max : 100;
  return Math.max(0, Math.min(100, Math.round((number / ceiling) * 100)));
}

/**
 * One value → its display text, by declared kind. `currency` (ISO 4217,
 * default USD) applies to `kind: "currency"`; `percent` reads ratios
 * (0.42 = 42%). A non-numeric value under either kind shows as is.
 */
export function formatValue(
  kind: ValueKind | undefined,
  value: unknown,
  currency?: string,
): string {
  if (value === null || value === undefined) return "";
  if (kind === "currency" || kind === "percent") {
    const number = toFiniteNumber(value);
    if (number === null) return String(value);
    return numberFormatter(kind, currency)(number);
  }
  if (kind === "duration") {
    const ms = typeof value === "number" ? value : Number(value);
    return Number.isFinite(ms) ? formatDuration(ms) : String(value);
  }
  if (kind === "progress") {
    const percent = progressPercent(value, undefined);
    return percent === null ? String(value) : `${percent}%`;
  }
  if (kind === "date" || kind === "relative") {
    const text = String(value);
    return Number.isNaN(Date.parse(text)) ? text : formatSmartTime(text);
  }
  if (kind === "boolean") return value ? "yes" : "no";
  if (kind === "json") return jsonPreview(value);
  if (kind === "number" && typeof value === "number") return value.toLocaleString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
