import {
  Blocks,
  Boxes,
  Bug,
  ChevronLeft,
  ChevronRight,
  Contact,
  FileText,
  FlaskConical,
  Key,
  KeyRound,
  ListChecks,
  type LucideIcon,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Server,
  Settings as SettingsIcon,
  SlidersHorizontal,
} from "lucide-react";
import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Navigate, NavLink, Outlet, useLocation } from "react-router-dom";
import { useOnboarding } from "@/api/hooks/use-onboarding";
import { AnimatedReveal } from "@/components/shared/animated-reveal";
import { BetaTag } from "@/components/shared/beta-tag";
import { SectionTabs } from "@/components/shared/section-tabs";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { useRuntimePoolsGate } from "@/lib/runtime-pools";
import { useIsAdmin } from "@/lib/use-can";
import { cn } from "@/lib/utils";

interface SettingsNavItem {
  title: string;
  path: string;
  icon: LucideIcon;
  /** Experimental surface: renders a BETA chip after the label. */
  beta?: { tooltip: string };
  /** Shown to everyone: browser-local or per-person. The rest is admin-only. */
  everyone?: boolean;
  /** Listed under the rail's "Advanced" label, after the other entries. */
  advanced?: boolean;
  /** Another path prefix that marks this entry active (a detail page outside `path`). */
  alsoActiveOn?: string;
}

// The first-run stepper lives outside the settings shell; the rail links to
// it only when the API serves `/api/onboarding`.
const SETUP_PATH = "/setup";
// Shown only while `useRuntimePoolsGate()` is open.
const RUNTIME_POOLS_NAV_PATH = "/settings/runtime-pools";

// Keep in step with the Settings flyout in `components/layout/app-sidebar.tsx`.
// People, Templates and a repo's detail page keep their own URLs, but the
// router renders them inside this shell too (`app/routes.tsx`).
const SETTINGS_NAV: SettingsNavItem[] = [
  { title: "Servers", path: "/settings/connections", icon: Server, everyone: true },
  { title: "Setup", path: SETUP_PATH, icon: ListChecks },
  { title: "People", path: "/people", icon: Contact },
  { title: "Appearance", path: "/settings/appearance", icon: Palette, everyone: true },
  { title: "Configuration", path: "/settings/configuration", icon: SlidersHorizontal },
  { title: "Extensions", path: "/settings/extensions", icon: Blocks },
  {
    title: "Runtime pools",
    path: RUNTIME_POOLS_NAV_PATH,
    icon: Boxes,
    beta: { tooltip: "Run agents on Docker or E2B runtimes" },
  },
  { title: "Repos", path: "/settings/repos", icon: SettingsIcon, alsoActiveOn: "/repos/" },
  { title: "Debug", path: "/settings/debug", icon: Bug },
  { title: "Secrets", path: "/settings/secrets", icon: KeyRound, advanced: true },
  { title: "Templates", path: "/templates", icon: FileText, advanced: true },
  {
    title: "Playground",
    path: "/settings/connection-playground",
    icon: FlaskConical,
    advanced: true,
  },
  {
    title: "Fetch credentials",
    path: "/settings/fetch-credentials",
    icon: Key,
    advanced: true,
  },
];

const RAIL_COLLAPSED_KEY = "agent-swarm:settings-rail-collapsed";

function readCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(RAIL_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Wraps an admin-only Settings route: a non-admin lands on Appearance. */
export function AdminRoute({ children }: { children: ReactNode }) {
  const isAdmin = useIsAdmin();
  if (!isAdmin) return <Navigate to="/settings/appearance" replace />;
  return children;
}

/**
 * Two-column shell for the admin section. A left rail of NavLinks (a tab strip
 * below `md`) drives nested routes that render into the `<Outlet/>`.
 * The desktop rail itself is collapsible — state persists in localStorage,
 * mirroring the Sessions panel pattern. The shell renders no PageHeader of its
 * own — each embedded page keeps its own header as the section title.
 */
export function SettingsLayout() {
  const location = useLocation();
  const { searchParams, setParam } = useUrlSearchState();
  const railParam = readStringParam(searchParams, "rail");
  const collapsed =
    railParam === "expanded" ? false : railParam === "collapsed" ? true : readCollapsed();
  const setCollapsed = useCallback(
    (value: boolean) => setParam("rail", value ? "collapsed" : "expanded"),
    [setParam],
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      /* best-effort */
    }
  }, [collapsed]);

  const onboarding = useOnboarding();
  const runtimePools = useRuntimePoolsGate();
  // A Requester or Viewer keeps only the browser-local pages; `AdminRoute`
  // sends a deep link to the rest back to Appearance.
  const isAdmin = useIsAdmin();
  const navItems = SETTINGS_NAV.filter(
    (item) =>
      (isAdmin || item.everyone) &&
      (item.path !== SETUP_PATH || onboarding.data) &&
      (item.path !== RUNTIME_POOLS_NAV_PATH || runtimePools.open),
  );

  // Match the active rail item by path prefix so deep links (e.g.
  // /settings/extensions/<id>) keep their entry highlighted.
  const matchedItem = navItems.find(
    (item) =>
      location.pathname.startsWith(item.path) ||
      (item.alsoActiveOn !== undefined && location.pathname.startsWith(item.alsoActiveOn)),
  );
  const activeItem = matchedItem ?? navItems[0];

  return (
    <div className="flex flex-col flex-1 min-h-0 lg:flex-row lg:gap-6">
      {/* Mobile: a tab strip above the content (no select repeating the page name). */}
      {/* mockup(ui-audit): settings tab strip hid 7 of 10 sections, add edge fade + chevrons */}
      <OverflowCue className="lg:hidden shrink-0 mb-4">
        <SectionTabs label="Settings" tabs={navItems} activePath={activeItem.path} />
      </OverflowCue>

      {/* Desktop: left rail. Width + fade on collapse/expand (DESIGN.md
          § Motion collapse pattern). */}
      <AnimatedReveal open={!collapsed} axis="x" className="hidden lg:block shrink-0">
        <nav aria-label="Settings" className="flex flex-col gap-0.5 w-48">
          <div className="flex items-center justify-between px-3 pb-1">
            <span className="text-[11px] font-mono uppercase tracking-[0.12em] text-muted-foreground">
              Settings
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setCollapsed(true)}
                  className="h-6 w-6"
                  aria-label="Collapse settings rail"
                >
                  <PanelLeftClose className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Collapse rail</TooltipContent>
            </Tooltip>
          </div>
          {navItems.map((item, index) => (
            <Fragment key={item.path}>
              {item.advanced && !navItems[index - 1]?.advanced ? (
                <span className="mt-3 px-3 pb-1 text-[11px] font-mono uppercase tracking-[0.12em] text-muted-foreground">
                  Advanced
                </span>
              ) : null}
              <NavLink
                to={item.path}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    isActive || item === matchedItem
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )
                }
              >
                <item.icon className="size-4 shrink-0" />
                <span className="min-w-0 truncate">{item.title}</span>
                {item.beta ? <BetaTag tooltip={item.beta.tooltip} className="ml-auto" /> : null}
              </NavLink>
            </Fragment>
          ))}
        </nav>
      </AnimatedReveal>

      {/* Content area owns the scroll container. */}
      <div
        className={cn(
          "flex flex-col flex-1 min-h-0 overflow-y-auto relative",
          collapsed && "lg:pl-10",
        )}
      >
        {collapsed ? (
          <div className="hidden lg:flex absolute top-0 left-0 z-10">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setCollapsed(false)}
                  className="h-7 w-7"
                  aria-label="Expand settings rail"
                >
                  <PanelLeftOpen className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Expand rail</TooltipContent>
            </Tooltip>
          </div>
        ) : null}
        <Outlet />
      </div>
    </div>
  );
}

// mockup(ui-audit): settings tab strip hid 7 of 10 sections, add edge fade + chevrons
/**
 * Wraps the shared `SectionTabs` strip (whose scrollbar is hidden) with an
 * edge fade and a chevron on each side that still has hidden tabs, so a phone
 * shows that more sections exist past the screen edge. Page-local: it finds
 * the strip's scroller in the DOM instead of changing the shared component.
 */
function OverflowCue({ children, className }: { children: ReactNode; className?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  useEffect(() => {
    const scroller = rootRef.current?.querySelector<HTMLElement>("nav > div");
    if (!scroller) return;
    const update = () => {
      const max = scroller.scrollWidth - scroller.clientWidth;
      setEdges({ left: scroller.scrollLeft > 4, right: scroller.scrollLeft < max - 4 });
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);

  const scrollBy = (direction: 1 | -1) => {
    const scroller = rootRef.current?.querySelector<HTMLElement>("nav > div");
    scroller?.scrollBy({ left: direction * scroller.clientWidth * 0.7, behavior: "smooth" });
  };

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      {children}
      {edges.left ? (
        <button
          type="button"
          onClick={() => scrollBy(-1)}
          aria-label="Show earlier settings sections"
          className="absolute top-0 bottom-[3px] left-0 flex w-10 items-center justify-start bg-gradient-to-r from-background from-40% to-transparent pl-0.5 text-foreground"
        >
          <ChevronLeft className="size-4" />
        </button>
      ) : null}
      {edges.right ? (
        <button
          type="button"
          onClick={() => scrollBy(1)}
          aria-label="Show more settings sections"
          className="absolute top-0 bottom-[3px] right-0 flex w-10 items-center justify-end bg-gradient-to-l from-background from-40% to-transparent pr-0.5 text-foreground"
        >
          <ChevronRight className="size-4" />
        </button>
      ) : null}
    </div>
  );
}
