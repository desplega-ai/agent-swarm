import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * "BETA" chip for an experimental surface. Hover or focus explains what the
 * surface is. Nav rows pass `className="ml-auto"` to pin it to the row's end.
 */
export function BetaTag({
  tooltip,
  side = "right",
  className,
}: {
  tooltip: string;
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          size="tag"
          className={cn("border-status-info/30 text-status-info-strong", className)}
        >
          BETA
        </Badge>
      </TooltipTrigger>
      <TooltipContent side={side}>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
