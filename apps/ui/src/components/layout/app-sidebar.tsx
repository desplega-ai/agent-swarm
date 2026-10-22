import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { ForwardRefExoticComponent, MouseEvent, ReactNode, RefAttributes } from "react";
import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useDashboardCosts } from "@/api/hooks/use-costs";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useMetrics } from "@/api/hooks/use-metrics";
import { useUsers } from "@/api/hooks/use-users";
import type { UserRole } from "@/api/types";
import { useStatusContext } from "@/app/status-context";
import { BookOpenIcon } from "@/components/icons/book-open";
import { BrainIcon } from "@/components/icons/brain";
import { CableIcon } from "@/components/icons/cable";
import { ChartColumnIcon } from "@/components/icons/chart-column";
import { ClipboardCheckIcon } from "@/components/icons/clipboard-check";
import { ClockIcon } from "@/components/icons/clock";
import { ContactIcon } from "@/components/icons/contact";
import { FileClockIcon } from "@/components/icons/file-clock";
import { FileTextIcon } from "@/components/icons/file-text";
import { FolderOpenIcon } from "@/components/icons/folder-open";
import { GlobeIcon } from "@/components/icons/globe";
import { HomeIcon } from "@/components/icons/home";
import { LayoutGridIcon } from "@/components/icons/layout-grid";
import { Link2Icon } from "@/components/icons/link-2";
import { ListTodoIcon } from "@/components/icons/list-todo";
import { MessageSquareIcon } from "@/components/icons/message-square";
import { SettingsIcon } from "@/components/icons/settings";
import { UsersIcon } from "@/components/icons/users";
import { WorkflowIcon } from "@/components/icons/workflow";
import { UserSwitcher } from "@/components/identity/user-switcher";
import { BetaTag, NewTag } from "@/components/shared/beta-tag";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import {
  SIDEBAR_KEYBOARD_SHORTCUT,
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
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { navRequirementMet } from "@/lib/agent-fs/state";
import { modKeyLabel } from "@/lib/approval-shortcuts";
import { formatCost } from "@/lib/cost-format";
import { isDemoMode } from "@/lib/deployment-config";
import { SESSIONS_V2_MIN_VERSION } from "@/lib/sessions-v2";
import { cn, formatCompactNumber } from "@/lib/utils";
import { CombSidebarPins } from "./comb-sidebar-pins";
import { SwarmSwitcher } from "./swarm-switcher";

/** The imperative surface every vendored animated icon exposes. */
interface AnimatedIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

/** A vendored animated icon from `components/icons/` (see CLAUDE.md § Motion). */
type AnimatedIconComponent = ForwardRefExoticComponent<
  { size?: number; className?: string } & RefAttributes<AnimatedIconHandle>
>;

interface NavItem {
  title: string;
  path: string;
  icon: AnimatedIconComponent;
  /** When set, item is shown as disabled with this tooltip when condition fails. */
  gate?: { minVersion: string };
  /**
   * Experimental surface: renders a "BETA" tag chip next to the label (with
   * an explanatory tooltip). Expanded sidebar only; the icon-collapsed mirror
   * keeps its plain icon + tooltip.
   */
  beta?: { tooltip: string };
  /**
   * New or rebuilt surface: renders a "NEW" tag chip next to the label once
   * the API reaches `minVersion`. Expanded sidebar only, like `beta`.
   */
  newTag?: { tooltip: string; minVersion: string };
  /**
   * Runtime switch: the item renders only when the named feature is on.
   * `comb` reads `/status` `agent_fs.comb.enabled` (COMB_ENABLED + agent-fs).
   */
  requires?: "comb";
  /**
   * Declarative minimum role required to see this item. Purely a type-level
   * annotation for future RBAC: render logic does NOT consult it today, so
   * every item stays visible to everyone. See plan Phase 1 / Appendix.
   */
  minRole?: UserRole;
}

interface NavGroup {
  /** Stable identifier: used to build the localStorage collapse-state key. */
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

/** Footer destination: optionally carrying a hover flyout of sub-routes. */
interface FooterItem extends NavItem {
  flyout?: FlyoutEntry[];
}

const navGroups: NavGroup[] = [
  {
    id: "work",
    label: "WORK",
    items: [
      { title: "Home", path: "/", icon: HomeIcon },
      { title: "Tasks", path: "/tasks", icon: ListTodoIcon },
      {
        title: "Sessions",
        path: "/sessions",
        icon: MessageSquareIcon,
        gate: { minVersion: "1.76.0" },
        newTag: {
          tooltip: "The new sessions view: groups, triage, tabs, and a split",
          minVersion: SESSIONS_V2_MIN_VERSION,
        },
      },
      {
        title: "Pages",
        path: "/pages",
        icon: GlobeIcon,
        gate: { minVersion: "1.79.0" },
      },
      { title: "Apps", path: "/apps", icon: LayoutGridIcon },
      {
        title: "Comb",
        path: "/file",
        icon: FolderOpenIcon,
        beta: { tooltip: "Review agent-fs files with the swarm" },
        requires: "comb",
      },
      { title: "Approvals", path: "/approval-requests", icon: ClipboardCheckIcon },
    ],
  },
  {
    id: "swarm",
    label: "SWARM",
    items: [
      { title: "Agents", path: "/agents", icon: UsersIcon },
      { title: "People", path: "/people", icon: ContactIcon, gate: { minVersion: "1.80.0" } },
      { title: "Workflows", path: "/workflows", icon: WorkflowIcon },
      { title: "Scripts", path: "/scripts", icon: FileClockIcon },
      { title: "Schedules", path: "/schedules", icon: ClockIcon },
    ],
  },
  {
    id: "resources",
    label: "RESOURCES",
    items: [
      { title: "Skills", path: "/skills", icon: BookOpenIcon },
      { title: "MCP Servers", path: "/mcp-servers", icon: CableIcon },
      { title: "Connections", path: "/connections", icon: Link2Icon },
      { title: "Memory", path: "/memory", icon: BrainIcon },
      { title: "Templates", path: "/templates", icon: FileTextIcon },
    ],
  },
];

/**
 * Account-area destinations pinned to the sidebar footer (bottom-aligned).
 * Settings and Usage carry a hover flyout listing their sub-routes; clicking
 * the item itself still navigates to its default route. The collapse and
 * expand buttons live in the header (`SidebarBrandRow`); the SidebarRail
 * divider and the keyboard shortcut toggle the sidebar too.
 */
const footerNav: FooterItem[] = [
  {
    title: "Settings",
    path: "/settings",
    icon: SettingsIcon,
    flyout: [
      { title: "Connections", path: "/settings/connections" },
      { title: "Appearance", path: "/settings/appearance" },
      { title: "Secrets", path: "/settings/secrets" },
      { title: "API Keys", path: "/settings/api-keys" },
      { title: "Integrations", path: "/settings/integrations" },
      { title: "Configuration", path: "/settings/configuration" },
      { title: "Extensions", path: "/settings/extensions" },
      { title: "Repos", path: "/settings/repos" },
      { title: "Debug", path: "/settings/debug" },
    ],
  },
  {
    title: "Usage",
    path: "/usage",
    icon: ChartColumnIcon,
    flyout: [
      { title: "Usage", path: "/usage", end: true },
      { title: "Budgets", path: "/usage/budgets" },
      { title: "Metrics", path: "/usage/metrics" },
    ],
  },
];

/**
 * One nav row: SidebarMenuButton + NavLink + animated icon + label. The ROW
 * drives the icon: hovering anywhere on the button plays the icon's
 * animation through its imperative handle (attaching the ref disables the
 * icon's own 16px-wide hover zone), so the affordance matches the actual
 * click target.
 */
function NavIconLink({
  item,
  isActive,
  end,
  tooltip,
  showBeta,
  showNew,
}: {
  item: NavItem;
  isActive: boolean;
  end?: boolean;
  tooltip?: string;
  showBeta?: boolean;
  /** The item's `newTag`: its API version gate passed. */
  showNew?: boolean;
}) {
  const iconRef = useRef<AnimatedIconHandle>(null);
  return (
    <SidebarMenuButton asChild isActive={isActive} tooltip={tooltip}>
      <NavLink
        to={item.path}
        end={end}
        onMouseEnter={() => iconRef.current?.startAnimation()}
        onMouseLeave={() => iconRef.current?.stopAnimation()}
      >
        <item.icon ref={iconRef} size={16} className="shrink-0" />
        <span>{item.title}</span>
        {showBeta && item.beta && <BetaTag tooltip={item.beta.tooltip} className="ml-auto" />}
        {showNew && item.newTag && <NewTag tooltip={item.newTag.tooltip} className="ml-auto" />}
      </NavLink>
    </SidebarMenuButton>
  );
}

/** Delay (ms) before a flyout closes on mouse-leave: lets the cursor cross
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
  badge?: ReactNode;
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

  const link = <NavIconLink item={item} isActive={isActive} tooltip={item.title} />;

  // Right-aligned live count: auto-hidden in icon-collapsed mode by the
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
          // Hover-driven: don't steal focus from the page on open.
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
                    "rounded-sm px-2 py-1.5 text-sm transition-colors hover-linger",
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

const TOGGLE_KEY = SIDEBAR_KEYBOARD_SHORTCUT.toUpperCase();
/** The provider binds Cmd and Ctrl on every platform, so both are listed. */
const TOGGLE_ARIA_KEYS = `Meta+${TOGGLE_KEY} Control+${TOGGLE_KEY}`;
const TOGGLE_HINT = modKeyLabel() === "⌘" ? `⌘${TOGGLE_KEY}` : `Ctrl+${TOGGLE_KEY}`;

function SidebarLogo({ src, alt, className }: { src: string; alt: string; className?: string }) {
  return (
    <img
      src={src}
      alt={alt}
      className={cn("h-8 w-8 min-h-[32px] min-w-[32px] shrink-0 rounded object-contain", className)}
      onError={(e) => {
        // Fall back to bundled logo if the configured logo URL fails.
        const img = e.currentTarget;
        if (img.src !== `${window.location.origin}/logo.png`) {
          img.src = "/logo.png";
        }
      }}
    />
  );
}

/**
 * The header's logo row. Expanded: the logo and name link home, and a ghost
 * button at the right end collapses the sidebar. Collapsed: the logo slot is
 * the expand button, and its icon replaces the logo on hover or keyboard
 * focus (the Claude.ai pattern). Both buttons stay mounted and CSS picks one
 * from the sidebar's `data-collapsible`, so the logo never reloads. The
 * mobile sheet has no collapsed state and no collapse button.
 */
function SidebarBrandRow({
  name,
  logo,
  brandColor,
}: {
  name: string;
  logo: string;
  brandColor: string | null;
}) {
  const { isMobile, state, toggleSidebar } = useSidebar();
  const collapseRef = useRef<HTMLButtonElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const refocusAfterToggle = useRef(false);

  // A keyboard toggle hides the focused button, so focus goes to the button
  // that takes its place. A pointer click leaves focus alone: a programmatic
  // focus would open the other button's tooltip under nobody's cursor.
  useEffect(() => {
    if (!refocusAfterToggle.current) return;
    refocusAfterToggle.current = false;
    (state === "collapsed" ? expandRef : collapseRef).current?.focus();
  }, [state]);

  function toggle(event: MouseEvent<HTMLButtonElement>) {
    // `detail` is 0 when Enter or Space fired the click.
    refocusAfterToggle.current = event.detail === 0;
    toggleSidebar();
  }

  return (
    // Collapsed, the row is as wide as the logo slot (w-8). The slot then
    // holds still through the rail's width transition, like the nav icons.
    // Centered in the full header width, it slid with the shrinking center.
    <div
      className={cn(
        "flex h-10 items-center gap-2 group-data-[collapsible=icon]:w-8 group-data-[collapsible=icon]:justify-center",
        isDemoMode && "pl-20 group-data-[collapsible=icon]:pl-0",
      )}
    >
      <NavLink
        to="/"
        className="flex min-w-0 flex-1 items-center gap-2 group-data-[collapsible=icon]:hidden"
      >
        <SidebarLogo src={logo} alt={`${name} logo`} />
        <span
          className="text-lg font-semibold tracking-tight text-sidebar-foreground truncate"
          style={brandColor ? { color: brandColor } : undefined}
        >
          {name}
        </span>
      </NavLink>
      {isMobile ? null : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              ref={collapseRef}
              variant="ghost"
              size="icon-sm"
              onClick={toggle}
              aria-label="Collapse sidebar"
              aria-keyshortcuts={TOGGLE_ARIA_KEYS}
              className="size-7 text-muted-foreground group-data-[collapsible=icon]:hidden"
            >
              <PanelLeftClose />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Collapse sidebar ({TOGGLE_HINT})</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            ref={expandRef}
            type="button"
            onClick={toggle}
            aria-label="Expand sidebar"
            aria-keyshortcuts={TOGGLE_ARIA_KEYS}
            className="group/expand relative hidden size-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground outline-hidden ring-sidebar-ring transition-colors hover-linger hover:bg-sidebar-accent focus-visible:ring-2 group-data-[collapsible=icon]:flex"
          >
            <SidebarLogo
              src={logo}
              alt=""
              className="group-hover/expand:opacity-0 group-focus-visible/expand:opacity-0"
            />
            <PanelLeftOpen
              aria-hidden
              className="absolute size-4 opacity-0 group-hover/expand:opacity-100 group-focus-visible/expand:opacity-100"
            />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Expand sidebar ({TOGGLE_HINT})</TooltipContent>
      </Tooltip>
    </div>
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
    [SESSIONS_V2_MIN_VERSION]: useFeatureGate(SESSIONS_V2_MIN_VERSION), // Sessions "NEW" tag
  };
  const isGated = (item: NavItem) =>
    !!item.gate && gates[item.gate.minVersion]?.supported === false;
  const isHidden = (item: NavItem) =>
    isGated(item) || !navRequirementMet(item.requires, status?.agent_fs?.comb);

  // Live counts surfaced as right-aligned badges on existing nav items.
  // Gated entirely on API ≥1.82: the backing queries don't even fire on
  // older servers, and `badges` stays empty so nav items render unchanged.
  const countsEnabled = gates["1.82.0"].supported;
  const { data: metrics } = useMetrics({ enabled: countsEnabled });
  const { data: dashboardCosts } = useDashboardCosts({ enabled: countsEnabled });
  const { data: users } = useUsers();

  // Map of `nav path -> resolved badge string`. An entry is present only when
  // the value is loaded and worth showing; absence means "no badge".
  const badges: Record<string, ReactNode> = {};
  if (countsEnabled) {
    const runningTasks = metrics?.tasks?.by_status?.in_progress;
    // Show running tasks only when there's at least one: skip a "0" chip.
    if (typeof runningTasks === "number" && runningTasks > 0) {
      badges["/tasks"] = formatCompactNumber(runningTasks);
    }
    if (Array.isArray(users)) {
      badges["/people"] = formatCompactNumber(users.length);
    }
    const costToday = dashboardCosts?.costToday;
    if (typeof costToday === "number") {
      // Today's spend, labelled: next to a 30-day page total, a bare "$448"
      // read as the same number.
      badges["/usage"] = (
        <>
          {formatCost(costToday, { precision: "compact" })}
          <span className="ml-1 font-normal text-muted-foreground">today</span>
        </>
      );
    }
  }

  const identityName = status?.identity.name ?? "Agent Swarm";
  const identityLogo = status?.identity.logo_url ?? "/logo.png";
  const brandColor = status?.identity.brand_color ?? null;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <SidebarBrandRow name={identityName} logo={identityLogo} brandColor={brandColor} />
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
              {/* Section title is hidden in icon-collapsed mode: the items
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
                            : location.pathname.startsWith(item.path);
                        if (isHidden(item)) return null;
                        const badge = badges[item.path];
                        return (
                          <SidebarMenuItem key={item.path}>
                            <NavIconLink
                              item={item}
                              isActive={isActive}
                              end={item.path === "/"}
                              showBeta
                              showNew={
                                !!item.newTag && gates[item.newTag.minVersion]?.supported === true
                              }
                            />
                            {/* Live count: auto-hidden when icon-collapsed. */}
                            {badge != null && <SidebarMenuBadge>{badge}</SidebarMenuBadge>}
                            {item.requires === "comb" && (
                              <CombSidebarPins comb={status?.agent_fs?.comb} />
                            )}
                          </SidebarMenuItem>
                        );
                      })}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </CollapsibleSection>
              </div>
              {/* Icon-only mirror: rendered only when sidebar is collapsed.
                  Same items, no section header chrome. */}
              <div className="hidden group-data-[collapsible=icon]:block">
                <SidebarGroupContent>
                  <SidebarMenu>
                    {items.map((item) => {
                      const isActive =
                        item.path === "/"
                          ? location.pathname === "/"
                          : location.pathname.startsWith(item.path);
                      if (isHidden(item)) return null;
                      return (
                        <SidebarMenuItem key={item.path}>
                          <NavIconLink
                            item={item}
                            isActive={isActive}
                            end={item.path === "/"}
                            tooltip={item.title}
                          />
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
        {/* Identity switcher: current user + change/create. Pinned to the
            very bottom of the sidebar, below the account footer items. */}
        <UserSwitcher />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
