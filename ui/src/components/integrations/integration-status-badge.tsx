import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { IntegrationStatus } from "@/lib/integrations-status";
import { cn } from "@/lib/utils";

interface IntegrationStatusBadgeProps {
  status: IntegrationStatus;
  className?: string;
}

// Labels and colors are text-first (accessible to screen readers and users
// with color-vision deficits); color is additive, not load-bearing.
const STATUS_META: Record<
  IntegrationStatus,
  { label: string; className: string; ariaLabel: string; tooltip: string }
> = {
  configured: {
    label: "Configured",
    className: "border-status-success/30 text-status-success",
    ariaLabel: "Status: Configured",
    tooltip:
      "Every required value is present (either in the DB or set via the deployment env). The integration should be live after a reload.",
  },
  partial: {
    label: "Partial",
    className: "border-status-active/30 text-status-active",
    ariaLabel: "Status: Partially configured",
    tooltip:
      "At least one required field is set, but not all. The integration won't fully initialise until the remaining values are provided.",
  },
  disabled: {
    label: "Disabled",
    className: "border-status-neutral/30 text-status-neutral",
    ariaLabel: "Status: Disabled",
    tooltip:
      "The integration's <PREFIX>_DISABLE flag is set to a truthy value. Clear or flip it to re-enable.",
  },
  none: {
    label: "Not configured",
    className: "border-border text-muted-foreground",
    ariaLabel: "Status: Not configured",
    tooltip: "No required value is set in the DB or deployment env. Click through to configure.",
  },
};

export function IntegrationStatusBadge({ status, className }: IntegrationStatusBadgeProps) {
  const meta = STATUS_META[status];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          aria-label={meta.ariaLabel}
          size="tag"
          className={cn("cursor-help", meta.className, className)}
        >
          {meta.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{meta.tooltip}</TooltipContent>
    </Tooltip>
  );
}
