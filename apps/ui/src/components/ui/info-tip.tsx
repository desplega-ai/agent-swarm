import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// InfoTip — a small muted Info icon that reveals a short plain-language
// explanation on hover/focus. Use next to stat labels and chart titles where a
// metric's meaning isn't self-evident. Keep copy to one sentence.
export function InfoTip({ content, className }: { content: ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        // Non-focusable so dialogs don't autofocus the trigger and pop the
        // tooltip open on mount (Radix Tooltip opens on focus). Hover still works.
        tabIndex={-1}
        aria-label="What is this?"
        className={cn(
          "inline-flex shrink-0 cursor-help items-center text-muted-foreground/70 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm",
          className,
        )}
      >
        <Info className="h-3 w-3" />
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{content}</TooltipContent>
    </Tooltip>
  );
}
