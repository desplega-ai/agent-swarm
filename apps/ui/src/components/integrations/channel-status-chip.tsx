import { Badge } from "@/components/ui/badge";
import type { ChannelChip } from "@/lib/channel-cards";
import { cn } from "@/lib/utils";

const CHIP: Record<ChannelChip, { label: string; className: string }> = {
  connected: {
    label: "Connected",
    className: "border-status-success/30 text-status-success-strong",
  },
  configured: {
    label: "Configured",
    className: "border-status-active/30 text-status-active-strong",
  },
  none: { label: "Not connected", className: "border-border text-muted-foreground" },
};

/** A channel's state on Connect › Channels and on its detail page. Text first, color additive. */
export function ChannelStatusChip({ chip, className }: { chip: ChannelChip; className?: string }) {
  const meta = CHIP[chip];
  return (
    <Badge
      variant="outline"
      size="tag"
      data-channel-chip={chip}
      className={cn(meta.className, className)}
    >
      {meta.label}
    </Badge>
  );
}
