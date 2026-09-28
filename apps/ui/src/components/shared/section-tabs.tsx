import type { LucideIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";

export interface SectionTab {
  title: string;
  path: string;
  icon?: LucideIcon;
  /** Index route: match the path exactly so it isn't kept active on sub-routes. */
  end?: boolean;
}

/**
 * The section subnav below `md`: a horizontal strip of links (Usage · Budgets
 * · Metrics) instead of a select that repeats the page name under a header
 * that already shows it. Scrolls sideways when the section has more links than
 * fit, and brings the active one into view on navigation.
 */
export function SectionTabs({
  label,
  tabs,
  activePath,
  className,
}: {
  /** Accessible name for the nav landmark, e.g. "Usage". */
  label: string;
  tabs: SectionTab[];
  activePath: string;
  className?: string;
}) {
  const stripRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on every navigation
  useEffect(() => {
    const active = stripRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activePath]);

  return (
    <nav aria-label={label} className={cn("border-b border-border", className)}>
      <div
        ref={stripRef}
        className="-mb-px flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab) => (
          <NavLink
            key={tab.path}
            to={tab.path}
            end={tab.end}
            className={({ isActive }) =>
              cn(
                "flex min-h-11 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:bg-accent/50",
                isActive
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )
            }
          >
            {tab.icon ? <tab.icon className="size-4 shrink-0" aria-hidden /> : null}
            {tab.title}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
