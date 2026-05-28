import type { SessionCostSource } from "@/api/types";
import { Badge } from "@/components/ui/badge";

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
export function CostSourceBadge({ source }: { source?: SessionCostSource | null }) {
  if (!source) return null;

  if (source === "pricing-table") {
    return (
      <Badge
        variant="outline"
        size="tag"
        className="border-status-success/30 text-status-success-strong"
        title="USD recomputed from the seeded pricing table"
      >
        PRICED
      </Badge>
    );
  }
  if (source === "unpriced") {
    return (
      <Badge
        variant="outline"
        size="tag"
        className="border-status-warning/40 text-status-warning-strong"
        title="No pricing row matched this provider/model; USD is the worker-reported value and token counts are shown below"
      >
        NO RATE
      </Badge>
    );
  }
  // harness
  return (
    <Badge variant="outline" size="tag" title="Cost reported by the harness, no recompute applied">
      HARNESS
    </Badge>
  );
}
