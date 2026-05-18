/**
 * Phase 12a — single cost-formatting utility for every cost-rendering site.
 *
 * Pre-Phase-12 the codebase had 9 distinct formatters + 7 inline `toFixed`
 * calls, each making slightly different rounding choices for the same USD
 * value. Consolidate everything here so $0.0125 renders the same way in
 * every column. Pages that genuinely need a different precision (pricing
 * cells need 6dp; the dashboard wants compact K/M buckets) pick the right
 * preset via `precision`.
 *
 * Precision semantics:
 *   * `'auto'`   (default) — `<$0.01` placeholder for sub-cent; 4dp under
 *                            $1; 2dp at or above $1. Good general purpose.
 *   * `'compact'`           — K/M bucketed at 1dp ($1.2K, $3.4M). Used in
 *                            dashboards / stat panels.
 *   * `'precise'`           — 6dp. Used in the pricing-rate cell where the
 *                            number IS the rate (e.g. $0.0000025 per token).
 *   * number                — explicit `toFixed(n)`.
 *
 * Null / undefined / NaN render as `placeholder` (default `'—'`). Zero
 * renders as `'$0'` so it's visually distinct from "no data".
 */

export type CostFormatPrecision = "auto" | "compact" | "precise" | number;

export interface FormatCostOptions {
  precision?: CostFormatPrecision;
  placeholder?: string;
}

const DEFAULT_PLACEHOLDER = "—";

function formatAuto(amount: number): string {
  // Sub-cent values: don't trust toFixed to render meaningfully — show a
  // qualitative bucket so the column doesn't read as "$0.00" everywhere.
  if (amount > 0 && amount < 0.01) return "<$0.01";
  if (amount < 1) return `$${amount.toFixed(4)}`;
  if (amount < 100) return `$${amount.toFixed(2)}`;
  return `$${amount.toFixed(2)}`;
}

function formatCompact(amount: number): string {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(1)}K`;
  if (amount >= 100) return `$${Math.round(amount)}`;
  if (amount >= 10) return `$${amount.toFixed(1)}`;
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount > 0) return `$${amount.toFixed(3)}`;
  return "$0";
}

/**
 * Format a USD amount according to the requested precision preset.
 *
 * @example
 * formatCost(0.0125)                                  // "$0.0125"
 * formatCost(0.0125, { precision: 'compact' })        // "$0.013"
 * formatCost(0.0125, { precision: 'precise' })        // "$0.012500"
 * formatCost(1500.5, { precision: 'compact' })        // "$1.5K"
 * formatCost(null)                                    // "—"
 * formatCost(0)                                       // "$0"
 */
export function formatCost(
  amount: number | null | undefined,
  opts: FormatCostOptions = {},
): string {
  const placeholder = opts.placeholder ?? DEFAULT_PLACEHOLDER;
  if (amount == null || Number.isNaN(amount)) return placeholder;
  if (amount === 0) return "$0";
  if (amount < 0) {
    // Treat negative numbers as a data error rather than fabricating a sign.
    return placeholder;
  }
  const precision = opts.precision ?? "auto";
  if (precision === "compact") return formatCompact(amount);
  if (precision === "precise") return `$${amount.toFixed(6)}`;
  if (typeof precision === "number") return `$${amount.toFixed(precision)}`;
  return formatAuto(amount);
}
