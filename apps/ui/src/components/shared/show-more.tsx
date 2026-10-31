/**
 * Long content, clamped: past `maxHeight` it shows its top under a fade, with
 * a "Show more" toggle. Short content shows whole, with no toggle. The clamp
 * is measured, so it holds for markdown, code blocks and images alike.
 */

import { type ReactNode, useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export function ShowMore({
  children,
  maxHeight = "24rem",
  className,
}: {
  children: ReactNode;
  /** The clamped height, as a CSS length. */
  maxHeight?: string;
  className?: string;
}) {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!box) return;
    const content = box.firstElementChild;
    const measure = () =>
      setOverflows((content?.scrollHeight ?? box.scrollHeight) > box.clientHeight + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    if (content) observer.observe(content);
    measure();
    return () => observer.disconnect();
  }, [box]);
  const clamped = !expanded;
  return (
    <div data-slot="show-more" className={cn("flex min-w-0 flex-col items-start gap-1", className)}>
      <div
        ref={setBox}
        style={clamped ? { maxHeight } : undefined}
        className={cn(
          "w-full min-w-0 overflow-hidden",
          clamped && overflows && "[mask-image:linear-gradient(to_bottom,black_70%,transparent)]",
        )}
      >
        <div>{children}</div>
      </div>
      {overflows || expanded ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="hit-area text-xs text-muted-foreground hover:text-foreground"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}
