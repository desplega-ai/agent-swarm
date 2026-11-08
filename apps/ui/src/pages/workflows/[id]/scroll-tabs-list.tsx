import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { TabsList } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/**
 * `TabsList` for a phone: a row that scrolls sideways inside its own strip,
 * with a fade on each clipped edge. Two things the stock list gets wrong when
 * its tabs are wider than the screen:
 *  - the clipped tab has no scroll affordance (it is just cut off);
 *  - focusing a clipped tab scrolls the page's `overflow-x-hidden` column, so
 *    the whole page jumps left. Here the strip is the scroller, and the active
 *    tab is centred by scrolling the strip only.
 * (Proposal for the shared component: a `scrollable` prop on `TabsList`.)
 */
export function ScrollTabsList({
  activeValue,
  children,
  className,
}: {
  /** Re-centres the active tab when it changes. */
  activeValue: string;
  children: ReactNode;
  className?: string;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const el = strip.current;
    if (!el) return;
    setEdge({
      start: el.scrollLeft > 2,
      end: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
    });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-centre on every tab change
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
    if (active) {
      const left = active.offsetLeft - (el.clientWidth - active.offsetWidth) / 2;
      el.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
    }
    measure();
  }, [activeValue, measure]);

  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div
      ref={strip}
      onScroll={measure}
      className={cn(
        "-mx-4 shrink-0 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        edge.start && edge.end
          ? "[mask-image:linear-gradient(to_right,transparent,black_28px,black_calc(100%-28px),transparent)]"
          : edge.end
            ? "[mask-image:linear-gradient(to_right,black_calc(100%-28px),transparent)]"
            : edge.start
              ? "[mask-image:linear-gradient(to_right,transparent,black_28px)]"
              : "",
      )}
    >
      <TabsList className={cn("w-max", className)}>{children}</TabsList>
    </div>
  );
}
