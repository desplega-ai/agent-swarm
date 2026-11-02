import { type ReactNode, useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isClipped } from "./link-cell-model";
import { useJsonRenderThemeAttr } from "./theme-scope";

/** Tooltip body: long text wraps and keeps its line breaks. */
const TIP_CONTENT_CLASS = "max-w-xs break-words whitespace-pre-wrap";

/**
 * The one tooltip apps use: the dashboard's styled `Tooltip`, never a native
 * `title` attribute. Wraps `children` in a span (`className` styles it) that
 * opens the tip on hover or focus. Empty `content` renders `children` alone.
 */
export function Tip({
  content,
  children,
  className,
  side,
}: {
  content: ReactNode;
  children: ReactNode;
  className?: string;
  side?: "top" | "right" | "bottom" | "left";
}) {
  const themeAttr = useJsonRenderThemeAttr();
  // The tree keeps its shape when the content comes and goes (a tip that waits for a
  // measurement), so a child inside is never remounted: closed instead of unwrapped.
  const empty = content === null || content === undefined || content === "" || content === false;
  return (
    <Tooltip open={empty ? false : undefined}>
      <TooltipTrigger asChild>
        <span className={className}>{children}</span>
      </TooltipTrigger>
      <TooltipContent side={side} className={TIP_CONTENT_CLASS} {...themeAttr}>
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

/** True when the element, or a descendant that clips its own text, is cut off. */
function clippedWithin(el: HTMLElement): boolean {
  if (isClipped(el)) return true;
  for (const child of el.querySelectorAll<HTMLElement>("*")) {
    if (isClipped(child)) return true;
  }
  return false;
}

/**
 * A tip for text that may be cut: truncated by an ellipsis or a line clamp. It
 * opens only when the content is clipped at the moment the pointer arrives, so
 * a short label never shows a tip that repeats it. `always` skips the check,
 * for a tip that adds information (a header's `hint`).
 */
export function OverflowTip({
  content,
  children,
  className,
  always = false,
  side,
}: {
  content: ReactNode;
  children: ReactNode;
  className?: string;
  always?: boolean;
  side?: "top" | "right" | "bottom" | "left";
}) {
  const themeAttr = useJsonRenderThemeAttr();
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const empty = content === null || content === undefined || content === "" || content === false;
  return (
    <Tooltip
      open={open && !empty}
      onOpenChange={(next) =>
        setOpen(next && (always || (!!ref.current && clippedWithin(ref.current))))
      }
    >
      <TooltipTrigger asChild>
        <span ref={ref} className={className}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side={side} className={TIP_CONTENT_CLASS} {...themeAttr}>
        {content}
      </TooltipContent>
    </Tooltip>
  );
}
