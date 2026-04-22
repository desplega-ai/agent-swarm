import { Badge } from "@/components/ui/badge";
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
  { label: string; className: string; ariaLabel: string }
> = {
  configured: {
    label: "Configured",
    className: "border-emerald-500/30 text-emerald-400",
    ariaLabel: "Status: Configured",
  },
  partial: {
    label: "Partial",
    className: "border-amber-500/30 text-amber-400",
    ariaLabel: "Status: Partially configured",
  },
  disabled: {
    label: "Disabled",
    className: "border-slate-500/30 text-slate-400",
    ariaLabel: "Status: Disabled",
  },
  none: {
    label: "Not configured",
    className: "border-border text-muted-foreground",
    ariaLabel: "Status: Not configured",
  },
};

export function IntegrationStatusBadge({ status, className }: IntegrationStatusBadgeProps) {
  const meta = STATUS_META[status];
  return (
    <Badge
      variant="outline"
      aria-label={meta.ariaLabel}
      className={cn(
        "text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase",
        meta.className,
        className,
      )}
    >
      {meta.label}
    </Badge>
  );
}
