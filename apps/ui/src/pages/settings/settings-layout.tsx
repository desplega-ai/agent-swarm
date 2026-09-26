import {
  Blocks,
  Bug,
  Cable,
  Key,
  KeyRound,
  ListChecks,
  type LucideIcon,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Settings as SettingsIcon,
  SlidersHorizontal,
} from "lucide-react";
import { useCallback, useEffect } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useOnboarding } from "@/api/hooks/use-onboarding";
import { AnimatedReveal } from "@/components/shared/animated-reveal";
import { SectionTabs } from "@/components/shared/section-tabs";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { cn } from "@/lib/utils";

interface SettingsNavItem {
  title: string;
  path: string;
  icon: LucideIcon;
}

// The first-run stepper lives outside the settings shell; the rail links to
// it only when the API serves `/api/onboarding`.
const SETUP_PATH = "/setup";

const SETTINGS_NAV: SettingsNavItem[] = [
  { title: "Connections", path: "/settings/connections", icon: Cable },
  { title: "Setup", path: SETUP_PATH, icon: ListChecks },
  { title: "Appearance", path: "/settings/appearance", icon: Palette },
  { title: "Secrets", path: "/settings/secrets", icon: KeyRound },
  { title: "API Keys", path: "/settings/api-keys", icon: Key },
  { title: "Integrations", path: "/settings/integrations", icon: Plug },
  { title: "Configuration", path: "/settings/configuration", icon: SlidersHorizontal },
  { title: "Extensions", path: "/settings/extensions", icon: Blocks },
  { title: "Repos", path: "/settings/repos", icon: SettingsIcon },
  { title: "Debug", path: "/settings/debug", icon: Bug },
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
  const navItems = onboarding.data
    ? SETTINGS_NAV
    : SETTINGS_NAV.filter((item) => item.path !== SETUP_PATH);

  // Match the active rail item by path prefix so deep links (e.g.
  // /settings/integrations/slack) keep "Integrations" highlighted.
  const activeItem =
    navItems.find((item) => location.pathname.startsWith(item.path)) ?? navItems[0];

  return (
    <div className="flex flex-col flex-1 min-h-0 md:flex-row md:gap-6">
      {/* Mobile: a tab strip above the content (no select repeating the page name). */}
      <SectionTabs
        label="Settings"
        tabs={navItems}
        activePath={activeItem.path}
        className="md:hidden shrink-0 mb-4"
      />

      {/* Desktop: left rail. Width + fade on collapse/expand (DESIGN.md
          § Motion collapse pattern). */}
      <AnimatedReveal open={!collapsed} axis="x" className="hidden md:block shrink-0">
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
          {navItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )
              }
            >
              <item.icon className="size-4 shrink-0" />
              <span>{item.title}</span>
            </NavLink>
          ))}
        </nav>
      </AnimatedReveal>

      {/* Content area owns the scroll container. */}
      <div
        className={cn(
          "flex flex-col flex-1 min-h-0 overflow-y-auto relative",
          collapsed && "md:pl-10",
        )}
      >
        {collapsed ? (
          <div className="hidden md:flex absolute top-0 left-0 z-10">
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
