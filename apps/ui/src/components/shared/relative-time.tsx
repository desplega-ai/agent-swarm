import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRelative } from "@/lib/relative-time";
import { cn, parseUTCDate } from "@/lib/utils";

/** "Tue, 27 Oct 2026, 20:31:44 CET": the exact moment, in this browser's zone. */
const EXACT = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
});

/**
 * A relative time ("3d ago") whose tooltip shows the exact date and time.
 * The dashboard tooltip replaces the browser's `title`, and it opens on
 * keyboard focus too. `children` replaces the relative text when a caller
 * shows the moment in its own words ("30 Oct, 16:59").
 */
export function RelativeTime({
  at,
  label,
  focusable = true,
  children,
  className,
}: {
  at: string;
  /** False inside a button or link, which already takes focus (no nested tab stop). */
  focusable?: boolean;
  /** Prefix in the tooltip, e.g. "Started". */
  label?: string;
  children?: ReactNode;
  className?: string;
}) {
  const date = parseUTCDate(at);
  if (Number.isNaN(date.getTime())) return <>{children ?? at}</>;
  const exact = EXACT.format(date);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          dateTime={date.toISOString()}
          // An empty title hides a row's native `title` while this tooltip shows.
          title=""
          tabIndex={focusable ? 0 : undefined}
          className={cn(
            "rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
            className,
          )}
        >
          {children ?? formatRelative(date)}
        </time>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="font-mono tabular-nums">
        {label ? `${label} ${exact}` : exact}
      </TooltipContent>
    </Tooltip>
  );
}
