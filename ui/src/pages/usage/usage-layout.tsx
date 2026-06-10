import {
  BarChart3,
  LayoutDashboard,
  type LucideIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Wallet,
} from "lucide-react";
import { useCallback, useEffect } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { cn } from "@/lib/utils";

interface UsageNavItem {
  title: string;
  path: string;
  icon: LucideIcon;
  /** Index route — match the path exactly so it isn't kept active on sub-routes. */
  end?: boolean;
}

const USAGE_NAV: UsageNavItem[] = [
  { title: "Usage", path: "/usage", icon: BarChart3, end: true },
  { title: "Budgets", path: "/usage/budgets", icon: Wallet },
  { title: "Metrics", path: "/usage/metrics", icon: LayoutDashboard },
];

const RAIL_COLLAPSED_KEY = "agent-swarm:usage-rail-collapsed";

function readCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(RAIL_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Two-column shell for the usage section — same left-rail / mobile-Select
 * pattern as SettingsLayout. The rail drives nested routes (`/usage` index =
 * Usage, `/usage/budgets` = Budgets) rendered into the `<Outlet/>`. The
 * desktop rail is collapsible with state persisted in localStorage. Each
 * embedded page keeps its own PageHeader and owns its scroll container.
 */
export function UsageLayout() {
  const location = useLocation();
  const navigate = useNavigate();
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

  const activeItem =
    USAGE_NAV.find((item) =>
      item.end ? location.pathname === item.path : location.pathname.startsWith(item.path),
    ) ?? USAGE_NAV[0];

  return (
    <div className="flex flex-col flex-1 min-h-0 md:flex-row md:gap-6">
      {/* Mobile: Select picker above the content. */}
      <div className="md:hidden shrink-0 mb-4">
        <Select value={activeItem.path} onValueChange={(next) => navigate(next)}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {USAGE_NAV.map((item) => (
              <SelectItem key={item.path} value={item.path}>
                {item.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Desktop: left rail. */}
      {!collapsed ? (
        <nav aria-label="Usage" className="hidden md:flex md:flex-col md:gap-0.5 md:w-48 shrink-0">
          <div className="flex items-center justify-between px-3 pb-1">
            <span className="text-[11px] font-mono uppercase tracking-[0.12em] text-muted-foreground">
              Usage
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setCollapsed(true)}
                  className="h-6 w-6"
                  aria-label="Collapse usage rail"
                >
                  <PanelLeftClose className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Collapse rail</TooltipContent>
            </Tooltip>
          </div>
          {USAGE_NAV.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.end}
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
      ) : null}

      {/* Content area — embedded pages own their own scroll container. */}
      <div className={cn("flex flex-col flex-1 min-h-0 relative", collapsed && "md:pl-10")}>
        {collapsed ? (
          <div className="hidden md:flex absolute top-0 left-0 z-10">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setCollapsed(false)}
                  className="h-7 w-7"
                  aria-label="Expand usage rail"
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
