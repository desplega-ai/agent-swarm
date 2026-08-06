import type { SessionCostSource } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Phase 12b — small badge for the `costSource` field on `session_costs` rows.
 *
 *   'pricing-table' — green; the API recomputed USD against the seeded
 *                     pricing rows. This is the trusted path.
 *   'harness'       — neutral; the worker's harness-reported value landed
 *                     as-is (no recompute attempted or no provider tag).
 *   'unpriced'      — yellow warning; we tried to recompute but the
 *                     (provider, model) pair had no pricing rows — the
 *                     stored USD is whatever the worker submitted.
 *
 * Returns `null` for legacy rows with no `costSource` so older tasks don't
 * sprout an awkward "unknown" badge.
 */
export function CostSourceBadge({
  source,
  harnessCostUsd,
  totalCostUsd,
}: {
  source?: SessionCostSource | null;
  harnessCostUsd?: number | null;
  totalCostUsd?: number | null;
}) {
  if (!source) return null;

  const driftPercent = costDriftPercent(harnessCostUsd, totalCostUsd);
  const breakdown =
    driftPercent != null
      ? `harness ${formatUsd(harnessCostUsd!)} · recomputed ${formatUsd(totalCostUsd!)} · Δ ${driftPercent.toFixed(1)}%`
      : null;

  const badge =
    source === "pricing-table" ? (
      <Badge
        variant="outline"
        size="tag"
        className="border-status-success/30 text-status-success-strong"
        title="USD recomputed from the seeded pricing table"
      >
        PRICED
      </Badge>
    ) : source === "unpriced" ? (
      <Badge
        variant="outline"
        size="tag"
        className="border-status-warning/40 text-status-warning-strong"
        title="No pricing row matched this provider/model; USD is the worker-reported value and token counts are shown below"
      >
        NO RATE
      </Badge>
    ) : (
      <Badge
        variant="outline"
        size="tag"
        title="Cost reported by the harness, no recompute applied"
      >
        HARNESS
      </Badge>
    );

  if (!breakdown) return badge;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-default">{badge}</span>
      </TooltipTrigger>
      <TooltipContent>{breakdown}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Percent drift between the harness-reported and server-recomputed cost,
 * relative to the larger magnitude. Returns null when either value is
 * missing/non-finite or the two are equal (no drift to show).
 */
export function costDriftPercent(
  harnessCostUsd: number | null | undefined,
  totalCostUsd: number | null | undefined,
): number | null {
  if (!Number.isFinite(harnessCostUsd) || !Number.isFinite(totalCostUsd)) return null;
  if (harnessCostUsd === totalCostUsd) return null;
  const base = Math.max(Math.abs(harnessCostUsd as number), Math.abs(totalCostUsd as number));
  if (base === 0) return null;
  return (Math.abs((totalCostUsd as number) - (harnessCostUsd as number)) / base) * 100;
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(value);
}
