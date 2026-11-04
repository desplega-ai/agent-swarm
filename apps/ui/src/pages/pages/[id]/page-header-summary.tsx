import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** The full description and slug, shown by both the hover tooltip and the tap popover. */
export function PageHeaderSummaryDetails({
  description,
  slug,
}: {
  description: string | null;
  slug: string | null;
}) {
  return (
    <>
      {description ? <p className="break-words">{description}</p> : null}
      {slug ? <p className="break-all font-mono opacity-80">slug: {slug}</p> : null}
    </>
  );
}

/**
 * The page header's one-line summary: the description, then the slug in muted
 * mono. Both truncate. Hover shows the full text in a tooltip; a tap, click or
 * Enter opens it in a popover, because touch screens never open a Radix
 * tooltip and below sm the slug only lives there. The slug comes from the
 * bearer-authed `/api/pages/:id` lookup (the public `/p/:id.json` doesn't
 * expose it, it's a creator-side concept), so it appears once that loads.
 */
export function PageHeaderSummary({
  description,
  slug,
}: {
  description: string | null;
  slug: string | null;
}) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  if (!description && !slug) return null;
  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      {/* Not hoverable: the pointer leaving the wide summary for an action icon
          closes it at once, so the icon's own tooltip can open. Hidden while the
          popover shows the same text. */}
      <Tooltip
        disableHoverableContent
        open={tooltipOpen && !popoverOpen}
        onOpenChange={setTooltipOpen}
      >
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex min-w-0 max-w-full cursor-pointer items-baseline gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {description ? <span className="min-w-0 truncate">{description}</span> : null}
              {slug ? (
                <span
                  className={cn(
                    "min-w-0 truncate font-mono text-xs text-muted-foreground/70",
                    // With a description the slug yields first and hides on phones.
                    description && "max-w-[40%] shrink-[2] max-sm:hidden",
                  )}
                >
                  {slug}
                </span>
              ) : null}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent align="start" className="max-w-md text-pretty">
          <PageHeaderSummaryDetails description={description} slug={slug} />
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align="start"
        className="w-auto max-w-[min(28rem,calc(100vw-2rem))] space-y-1 p-3 text-sm"
      >
        <PageHeaderSummaryDetails description={description} slug={slug} />
      </PopoverContent>
    </Popover>
  );
}
