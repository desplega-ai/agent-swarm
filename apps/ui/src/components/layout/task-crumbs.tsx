import { Ellipsis } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AgentTask } from "@/api/types";
import { TaskHoverCard } from "@/components/shared/task-hover-card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { shortId } from "@/lib/short-id";
import { taskListTitle } from "@/lib/task-title";
import { MAX_ANCESTOR_CRUMBS } from "./task-trail";

/** A task crumb's accessible name: the id it shows, then the title it hides. */
export function taskCrumbLabel(task: AgentTask): string {
  return `#${shortId(task.id)}: ${taskListTitle(task)}`;
}

/**
 * A task crumb's hover card: the compact task card that the task lists show
 * in full. Radix opens it on pointer hover and on keyboard focus, so the
 * trigger must take focus. Without the lineage row yet, the crumb renders bare.
 */
export function TaskCrumbPeek({
  task,
  children,
}: {
  task: AgentTask | undefined;
  children: ReactNode;
}) {
  if (!task) return children;
  return (
    <TaskHoverCard task={task} variant="compact" side="bottom" align="start" openDelay={300}>
      {children}
    </TaskHoverCard>
  );
}

/**
 * One ancestor as a menu row: its short id and its title on one line, after
 * an optional `leading` mark (the phone menu's level arrow).
 */
export function AncestorMenuItem({
  task,
  leading,
  className,
  style,
}: {
  task: AgentTask;
  leading?: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <DropdownMenuItem asChild className={className} style={style}>
      <Link to={`/tasks/${task.id}`} className="flex min-w-0 items-center gap-2">
        {leading}
        <span className="shrink-0 font-mono text-muted-foreground">#{shortId(task.id)}</span>
        <span className="min-w-0 truncate">{taskListTitle(task)}</span>
      </Link>
    </DropdownMenuItem>
  );
}

/** The "…" crumb: a menu of the ancestors the trail folds, root first. */
export function HiddenAncestorsMenu({ tasks }: { tasks: AgentTask[] }) {
  const count = tasks.length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Show ${count} more parent task${count === 1 ? "" : "s"}`}
        className="hover-linger flex h-6 items-center rounded-sm px-1 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 data-[state=open]:bg-accent data-[state=open]:text-foreground"
      >
        <Ellipsis aria-hidden className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-96 max-w-[calc(100vw-2rem)]">
        {tasks.map((task) => (
          <AncestorMenuItem key={task.id} task={task} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** True when the trail does not fit its nav: the leaf truncates, or a fixed crumb spills. */
function trailOverflows(nav: HTMLElement): boolean {
  if (nav.scrollWidth > nav.clientWidth) return true;
  const leaf = nav.querySelector<HTMLElement>("[data-crumb-leaf]");
  return !!leaf && leaf.scrollWidth > leaf.clientWidth;
}

/**
 * How many ancestor crumbs the desktop trail shows: `MAX_ANCESTOR_CRUMBS`,
 * one less per pass while the trail overflows, down to 0 ("…" alone) and
 * then -1 (no "…" either, so the current id keeps the room). The passes run
 * in a layout effect, so only the result paints. The nav takes the header's
 * free width (`flex-1`): a fold never resizes it, so it cannot loop. A new
 * trail (`trailKey`), a new width or a font load starts from the cap again.
 */
export function useAncestorFit(
  nav: HTMLElement | null,
  trailKey: string,
  ancestors: number,
): number {
  const [fit, setFit] = useState({ key: trailKey, value: MAX_ANCESTOR_CRUMBS });
  const value = fit.key === trailKey ? fit.value : MAX_ANCESTOR_CRUMBS;

  useEffect(() => {
    if (!nav) return;
    let width = nav.clientWidth;
    const reset = () => setFit((current) => ({ ...current, value: MAX_ANCESTOR_CRUMBS }));
    const observer = new ResizeObserver(() => {
      if (nav.clientWidth === width) return;
      width = nav.clientWidth;
      reset();
    });
    observer.observe(nav);
    document.fonts?.addEventListener("loadingdone", reset);
    return () => {
      observer.disconnect();
      document.fonts?.removeEventListener("loadingdone", reset);
    };
  }, [nav]);

  // Every render: a poll can change the leaf, and the check is a few reads.
  useLayoutEffect(() => {
    if (!nav || ancestors === 0 || value < 0 || !trailOverflows(nav)) return;
    setFit({ key: trailKey, value: Math.min(value, ancestors) - 1 });
  });

  return value;
}
