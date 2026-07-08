import {
  BarChart3,
  BookOpen,
  Brain,
  Cable,
  ClipboardCheck,
  Clock,
  Contact,
  FileClock,
  FileText,
  Globe,
  Home,
  Link2,
  ListTodo,
  MessageSquare,
  Settings,
  Users,
  Workflow,
} from "lucide-react";
import { useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useDashboardCosts } from "@/api/hooks/use-costs";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useMetrics } from "@/api/hooks/use-metrics";
import { useUsers } from "@/api/hooks/use-users";
import type { UserRole } from "@/api/types";
import { useStatusContext } from "@/app/status-context";
import { UserSwitcher } from "@/components/identity/user-switcher";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { formatCost } from "@/lib/cost-format";
import { cn, formatCompactNumber } from "@/lib/utils";
import { SwarmSwitcher } from "./swarm-switcher";

interface NavItem {
  title: string;
  path: string;
  icon: typeof Home;
  children?: Array<{
    title: string;
    path: string;
  }>;
  /** When set, item is shown as disabled with this tooltip when condition fails. */
  gate?: { minVersion: string };
  /**
   * Declarative minimum role required to see this item. Purely a type-level
   * annotation for future RBAC — render logic does NOT consult it today, so
   * every item stays visible to everyone. See plan Phase 1 / Appendix.
   */
  minRole?: UserRole;
}

interface NavGroup {
  /** Stable identifier — used to build the localStorage collapse-state key. */
  id: string;
  label: string;
  items: NavItem[];
}

/** A sub-route entry surfaced in a footer item's hover flyout. */
interface FlyoutEntry {
  title: string;
  path: string;
  /** Match the path exactly (index routes) rather than by prefix. */
  end?: boolean;
}

/** Footer destination — optionally carrying a hover flyout of sub-routes. */
interface FooterItem extends NavItem {
  flyout?: FlyoutEntry[];
}

const navGroups: NavGroup[] = [
  {
    id: "work",
    label: "WORK",
    items: [
      { title: "Home", path: "/", icon: Home },
      { title: "Tasks", path: "/tasks", icon: ListTodo },
      { title: "Sessions", path: "/sessions", icon: MessageSquare, gate: { minVersion: "1.76.0" } },
      { title: "Approvals", path: "/approval-requests", icon: ClipboardCheck },
    ],
  },
  {
    id: "swarm",
    label: "SWARM",
    items: [
      { title: "Agents", path: "/agents", icon: Users },
      { title: "People", path: "/people", icon: Contact, gate: { minVersion: "1.80.0" } },
      { title: "Workflows", path: "/workflows", icon: Workflow },
      { title: "Scripts", path: "/scripts", icon: FileClock },
      { title: "Schedules", path: "/schedules", icon: Clock },
    ],
  },
  {
    id: "resources",
    label: "RESOURCES",
    items: [
      { title: "Skills", path: "/skills", icon: BookOpen },
      { title: "MCP Servers", path: "/mcp-servers", icon: Cable },
      { title: "Connections", path: "/connections", icon: Link2 },
      { title: "Memory", path: "/memory", icon: Brain },
      {
        title: "Pages",
        path: "/pages",
        icon: Globe,
        gate: { minVersion: "1.79.0" },
      },
      { title: "Templates", path: "/templates", icon: FileText },
    ],
  },
];

/**
 * Account-area destinations pinned to the sidebar footer (bottom-aligned).
 * Settings and Usage carry a hover flyout listing their sub-routes; clicking
 * the item itself still navigates to its default route. Collapsing the
 * sidebar is handled by clicking the SidebarRail divider — there is no
 * dedicated trigger button.
 */
const footerNav: FooterItem[] = [
  {
    title: "Settings",
    path: "/settings",
    icon: Settings,
    flyout: [
      { title: "Connections", path: "/settings/connections" },
      { title: "Secrets", path: "/settings/secrets" },
      { title: "API Keys", path: "/settings/api-keys" },
      { title: "Integrations", path: "/settings/integrations" },
      { title: "Repos", path: "/settings/repos" },
      { title: "Debug", path: "/settings/debug" },
    ],
  },
  {
    title: "Usage",
    path: "/usage",
    icon: BarChart3,
    flyout: [
      { title: "Usage", path: "/usage", end: true },
      { title: "Budgets", path: "/usage/budgets" },
      { title: "Metrics", path: "/usage/metrics" },
    ],
  },
];

/** Delay (ms) before a flyout closes on mouse-leave — lets the cursor cross
 * the gap between trigger and flyout content without it snapping shut. */
const FLYOUT_CLOSE_DELAY = 120;

interface FooterNavItemProps {
  item: FooterItem;
  isActive: boolean;
  /**
   * Optional right-aligned count rendered as a `SidebarMenuBadge`. Only set
   * when the live-counts feature (API ≥1.82) is enabled and the value is
   * resolved; `undefined` means render no badge.
   */
  badge?: string;
}

/**
 * A single footer destination. Items with a `flyout` render a hover-driven
 * Popover (open on enter, close after a short delay on leave) anchored to the
 * right of the sidebar; the trigger itself remains a NavLink so a click still
 * navigates. Items without a flyout render a plain link.
 */
function FooterNavItem({ item, isActive, badge }: FooterNavItemProps) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function cancelClose() {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }

  function scheduleClose() {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), FLYOUT_CLOSE_DELAY);
  }

  const link = (
    <SidebarMenuButton asChild isActive={isActive} tooltip={item.title}>
      <NavLink to={item.path}>
        <item.icon className="size-4" />
        <span>{item.title}</span>
      </NavLink>
    </SidebarMenuButton>
  );

  // Right-aligned live count — auto-hidden in icon-collapsed mode by the
  // primitive's own `group-data-[collapsible=icon]:hidden`.
  const badgeEl = badge != null ? <SidebarMenuBadge>{badge}</SidebarMenuBadge> : null;

  if (!item.flyout) {
    return (
      <SidebarMenuItem>
        {link}
        {badgeEl}
      </SidebarMenuItem>
    );
  }

  return (
    <SidebarMenuItem>
      {badgeEl}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <div
            onMouseEnter={() => {
              cancelClose();
              setOpen(true);
            }}
            onMouseLeave={scheduleClose}
          >
            {link}
          </div>
        </PopoverAnchor>
        <PopoverContent
          side="right"
          align="start"
          sideOffset={8}
          className="w-48 p-1"
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          // Hover-driven — don't steal focus from the page on open.
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="flex flex-col gap-0.5">
            {item.flyout.map((entry) => (
              <NavLink
                key={entry.path}
                to={entry.path}
                end={entry.end}
                onClick={() => setOpen(false)}
                className={({ isActive: entryActive }) =>
                  cn(
                    "rounded-sm px-2 py-1.5 text-sm transition-colors",
                    entryActive
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )
                }
              >
                {entry.title}
              </NavLink>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </SidebarMenuItem>
  );
}

export function AppSidebar() {
  const location = useLocation();
  const { data: status } = useStatusContext();
  // Feature-gate lookups for nav items whose backing routes need a min API
  // version. Add a new entry here when introducing another gated surface.
  const gates: Record<string, ReturnType<typeof useFeatureGate>> = {
    "1.76.0": useFeatureGate("1.76.0"), // Sessions
    "1.79.0": useFeatureGate("1.79.0"), // Pages
    "1.80.0": useFeatureGate("1.80.0"), // People
    "1.82.0": useFeatureGate("1.82.0"), // Live nav-item counts
  };
  const isGated = (item: NavItem) =>
    !!item.gate && gates[item.gate.minVersion]?.supported === false;

  // Live counts surfaced as right-aligned badges on existing nav items.
  // Gated entirely on API ≥1.82 — the backing queries don't even fire on
  // older servers, and `badges` stays empty so nav items render unchanged.
  const countsEnabled = gates["1.82.0"].supported;
  const { data: metrics } = useMetrics({ enabled: countsEnabled });
  const { data: dashboardCosts } = useDashboardCosts({ enabled: countsEnabled });
  const { data: users } = useUsers();

  // Map of `nav path -> resolved badge string`. An entry is present only when
  // the value is loaded and worth showing; absence means "no badge".
  const badges: Record<string, string> = {};
  if (countsEnabled) {
    const runningTasks = metrics?.tasks?.by_status?.in_progress;
    // Show running tasks only when there's at least one — skip a "0" chip.
    if (typeof runningTasks === "number" && runningTasks > 0) {
      badges["/tasks"] = formatCompactNumber(runningTasks);
    }
    if (Array.isArray(users)) {
      badges["/people"] = formatCompactNumber(users.length);
    }
    const costToday = dashboardCosts?.costToday;
    if (typeof costToday === "number") {
      badges["/usage"] = formatCost(costToday, { precision: "compact" });
    }
  }

  const identityName = status?.identity.name ?? "Agent Swarm";
  const identityLogo = status?.identity.logo_url ?? "/logo.png";
  const brandColor = status?.identity.brand_color ?? null;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <NavLink
          to="/"
          className="flex h-10 items-center gap-2 group-data-[collapsible=icon]:justify-center"
        >
          <img
            src={identityLogo}
            alt={`${identityName} logo`}
            className="h-8 w-8 min-h-[32px] min-w-[32px] shrink-0 rounded object-contain"
            onError={(e) => {
              // Fall back to bundled logo if the configured logo URL fails.
              const img = e.currentTarget;
              if (img.src !== `${window.location.origin}/logo.png`) {
                img.src = "/logo.png";
              }
            }}
          />
          <span
            className="text-lg font-semibold tracking-tight text-sidebar-foreground group-data-[collapsible=icon]:hidden truncate"
            style={brandColor ? { color: brandColor } : undefined}
          >
            {identityName}
          </span>
        </NavLink>
        <div className="group-data-[collapsible=icon]:hidden">
          <SwarmSwitcher />
        </div>
      </SidebarHeader>

      <SidebarContent>
        {navGroups.map((group) => {
          const items = group.items;
          if (items.length === 0) return null;
          return (
            <SidebarGroup key={group.id}>
              {/* Section title is hidden in icon-collapsed mode — the items
                  themselves stay so you still get the navigation, just
                  without the truncated "WOR / SWA / RES…" labels. */}
              <div className="group-data-[collapsible=icon]:hidden">
                <CollapsibleSection
                  title={group.label}
                  defaultOpen
                  persistKey={`agent-swarm:sidebar-group:${group.id}`}
                >
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {items.map((item) => {
                        const isActive =
                          item.path === "/"
                            ? location.pathname === "/"
                            : location.pathname.startsWith(item.path) ||
                              !!item.children?.some((child) =>
                                location.pathname.startsWith(child.path),
                              );
                        const gated = isGated(item);
                        if (gated) return null;
                        const badge = badges[item.path];
                        return (
                          <SidebarMenuItem key={item.path}>
                            <SidebarMenuButton asChild isActive={isActive}>
                              <NavLink to={item.path} end={item.path === "/"}>
                                <item.icon className="size-4" />
                                <span>{item.title}</span>
                              </NavLink>
                            </SidebarMenuButton>
                            {/* Live count — auto-hidden when icon-collapsed. */}
                            {badge != null && <SidebarMenuBadge>{badge}</SidebarMenuBadge>}
                            {item.children && (
                              <div className="ml-6 mt-1 flex flex-col gap-0.5 border-l border-sidebar-border pl-2">
                                {item.children.map((child) => (
                                  <NavLink
                                    key={child.path}
                                    to={child.path}
                                    className={({ isActive: childActive }) =>
                                      cn(
                                        "rounded-sm px-2 py-1 text-sm transition-colors",
                                        childActive
                                          ? "bg-sidebar-accent text-sidebar-accent-foreground"
                                          : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                                      )
                                    }
                                  >
                                    {child.title}
                                  </NavLink>
                                ))}
                              </div>
                            )}
                          </SidebarMenuItem>
                        );
                      })}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </CollapsibleSection>
              </div>
              {/* Icon-only mirror — rendered only when sidebar is collapsed.
                  Same items, no section header chrome. */}
              <div className="hidden group-data-[collapsible=icon]:block">
                <SidebarGroupContent>
                  <SidebarMenu>
                    {items.map((item) => {
                      const isActive =
                        item.path === "/"
                          ? location.pathname === "/"
                          : location.pathname.startsWith(item.path);
                      const gated = isGated(item);
                      if (gated) return null;
                      return (
                        <SidebarMenuItem key={item.path}>
                          <SidebarMenuButton asChild isActive={isActive} tooltip={item.title}>
                            <NavLink to={item.path} end={item.path === "/"}>
                              <item.icon className="size-4" />
                              <span>{item.title}</span>
                            </NavLink>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </div>
            </SidebarGroup>
          );
        })}
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu>
          {footerNav.map((item) => {
            if (isGated(item)) return null;
            return (
              <FooterNavItem
                key={item.path}
                item={item}
                isActive={location.pathname.startsWith(item.path)}
                badge={badges[item.path]}
              />
            );
          })}
        </SidebarMenu>
        {/* Identity switcher — current user + change/create. Pinned to the
            very bottom of the sidebar, below the account footer items. */}
        <UserSwitcher />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
