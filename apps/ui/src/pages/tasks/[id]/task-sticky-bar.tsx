import { type ReactNode, useEffect, useState } from "react";
import { ModelLabel } from "@/components/shared/model-logo";
import { TaskStatusIcon } from "@/components/shared/task-status-icon";
import { statusLabel } from "@/lib/status-labels";
import { cn } from "@/lib/utils";

/**
 * Height of the compact bar, in rem. The page sizes the log card against it,
 * so the card fills the scroll container under the bar.
 */
const STICKY_BAR_REM = 2.75;
export const STICKY_BAR_HEIGHT = `${STICKY_BAR_REM}rem`;

function remToPx(rem: number): number {
  const root = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return rem * (Number.isFinite(root) ? root : 16);
}

/**
 * Whether the hero has scrolled out of the column, under the bar. Attach
 * `scrollerRef` to the scroll container and `sentinelRef` to an element at the
 * end of the hero. Both are callback refs, so they work across the page's
 * loading and loaded renders.
 */
export function useHeroScrolledPast() {
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null);
  const [past, setPast] = useState(false);

  useEffect(() => {
    if (!scroller || !sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        // Past means the sentinel left through the top edge. A hidden tree
        // (narrow layout) reports no root bounds and stays "not past".
        const top = entry.rootBounds?.top;
        setPast(!entry.isIntersecting && top != null && entry.boundingClientRect.top < top);
      },
      // The bar covers the top of the column, so the hero counts as gone once
      // its end slides under the bar.
      { root: scroller, rootMargin: `-${Math.round(remToPx(STICKY_BAR_REM))}px 0px 0px 0px` },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [scroller, sentinel]);

  return { past, scrollerRef: setScroller, sentinelRef: setSentinel };
}

/**
 * The compact bar at the top of the center column. It shows once the hero
 * leaves the view: status, the title on one line, the model, and an action.
 * It stays mounted and only fades, so a poll never replays its entrance. It
 * takes no layout space: the zero-height sticky wrapper keeps the column's
 * content where it is.
 */
export function TaskStickyBar({
  visible,
  title,
  status,
  model,
  action,
}: {
  visible: boolean;
  title: string;
  status: string;
  model?: string;
  /** The primary action for the task's status. */
  action?: ReactNode;
}) {
  return (
    <div className="sticky top-0 z-20 h-0">
      <div
        aria-hidden={!visible}
        inert={!visible}
        style={{ height: STICKY_BAR_HEIGHT }}
        className={cn(
          "absolute inset-x-0 top-0 flex items-center gap-3 border-b border-border bg-background pr-6",
          "transition-[opacity,transform] duration-150 ease-snappy motion-reduce:transition-none",
          visible ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-1 opacity-0",
        )}
      >
        <TaskStatusIcon status={status} label={statusLabel(status)} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        {model ? (
          <ModelLabel model={model} className="shrink-0 text-xs text-muted-foreground" />
        ) : null}
        {action ? <div className="flex shrink-0 items-center gap-1.5">{action}</div> : null}
      </div>
    </div>
  );
}
