import { Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function FavoriteButton({
  favorite,
  disabled,
  onToggle,
  className,
  labels = { add: "Add favorite", remove: "Remove favorite" },
}: {
  favorite?: boolean;
  disabled?: boolean;
  onToggle: () => void;
  className?: string;
  /** Tooltip and accessible name (Comb says "Pin" and "Unpin"). */
  labels?: { add: string; remove: string };
}) {
  const label = favorite ? labels.remove : labels.add;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn("h-7 w-7", favorite && "text-status-warning-strong", className)}
          disabled={disabled}
          aria-label={label}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onToggle();
          }}
        >
          <Star className={cn("h-4 w-4", favorite && "fill-current")} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
