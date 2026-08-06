import { Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function FavoriteButton({
  favorite,
  disabled,
  onToggle,
  className,
}: {
  favorite?: boolean;
  disabled?: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn("h-7 w-7", favorite && "text-status-warning-strong", className)}
          disabled={disabled}
          aria-label={favorite ? "Remove favorite" : "Add favorite"}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onToggle();
          }}
        >
          <Star className={cn("h-4 w-4", favorite && "fill-current")} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{favorite ? "Remove favorite" : "Add favorite"}</TooltipContent>
    </Tooltip>
  );
}
