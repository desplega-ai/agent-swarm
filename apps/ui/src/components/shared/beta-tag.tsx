import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type TagProps = {
  tooltip: string;
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
};

function TagChip({ label, tooltip, side = "right", className }: TagProps & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" size="tag" className={className}>
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side={side}>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * "BETA" chip for an experimental surface. Hover or focus explains what the
 * surface is. Nav rows pass `className="ml-auto"` to pin it to the row's end.
 */
export function BetaTag({ className, ...props }: TagProps) {
  return (
    <TagChip
      label="BETA"
      className={cn("border-status-info/30 text-status-info-strong", className)}
      {...props}
    />
  );
}

/** "NEW" chip for a surface that is new or rebuilt. Same shape as `BetaTag`. */
export function NewTag({ className, ...props }: TagProps) {
  return (
    <TagChip
      label="NEW"
      className={cn("border-status-success/30 text-status-success-strong", className)}
      {...props}
    />
  );
}
