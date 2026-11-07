/**
 * Number formats shared by `Chart` (axis ticks and tooltip), `Metric`, and the
 * `currency` / `percent` kinds of Table columns and DetailList fields. Kept
 * free of React so it stays unit-testable under `bun test`.
 */

export type NumberFormat = "number" | "currency" | "percent";

/** ISO 4217 shape. The hand page validator skips zod `regex`, so it reuses this. */
export const CURRENCY_CODE = /^[A-Z]{3}$/;

/**
 * Number → text. `percent` reads values as ratios (0.42 = 42%); `currency`
 * takes an ISO 4217 code (default USD). `compact` is the axis-tick variant
 * (12K, whole currency units).
 */
export function numberFormatter(
  format: NumberFormat = "number",
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

/** A number, or a numeric string, as a finite number; null otherwise. */
export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
