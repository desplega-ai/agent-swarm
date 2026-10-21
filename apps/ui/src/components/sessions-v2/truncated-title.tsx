import { type MouseEvent, useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * A session title on one line with an ellipsis (SPEC R10.3). When the
 * ellipsis cuts it, hover shows the full title in a tooltip. The tooltip
 * stays mounted and opens only while the text overflows. Its parent needs
 * `min-w-0` in a flex row, so the title shrinks instead of pushing its
 * neighbors out.
 */
export function TruncatedTitle({
  title,
  className,
  onDoubleClick,
}: {
  title: string;
  className?: string;
  onDoubleClick?: (event: MouseEvent<HTMLSpanElement>) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const cut = () => {
    const el = ref.current;
    return el !== null && el.scrollWidth > el.clientWidth;
  };
  return (
    <Tooltip open={open} onOpenChange={(next) => setOpen(next && cut())}>
      <TooltipTrigger asChild>
        <span
          ref={ref}
          onDoubleClick={onDoubleClick}
          className={cn("block min-w-0 truncate", className)}
        >
          {title}
        </span>
      </TooltipTrigger>
      {/* A long unbroken word (a URL, a branch name) wraps here instead of widening the tip. */}
      <TooltipContent className="max-w-sm wrap-anywhere">{title}</TooltipContent>
    </Tooltip>
  );
}
