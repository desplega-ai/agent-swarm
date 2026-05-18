import {
  BarChart3,
  BookOpen,
  Brain,
  Bug,
  Cable,
  ClipboardCheck,
  Clock,
  FileText,
  GitBranch,
  Globe,
  Home,
  Key,
  LayoutDashboard,
  ListTodo,
  MessageSquare,
  Plug,
  Settings,
  Users,
  Wallet,
  Workflow,
} from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useStatusContext } from "@/app/status-context";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { SwarmSwitcher } from "./swarm-switcher";

interface NavItem {
  title: string;
  path: string;
  icon: typeof Home;
  /** When set, item is shown as disabled with this tooltip when condition fails. */
  gate?: { minVersion: string };
}

const navGroups: { label: string; items: NavItem[] }[] = [
  {
    label: "Core",
    items: [
      { title: "Home", path: "/", icon: Home },
      { title: "Dashboard", path: "/dashboard", icon: LayoutDashboard },
      { title: "Agents", path: "/agents", icon: Users },
      { title: "Sessions", path: "/sessions", icon: MessageSquare, gate: { minVersion: "1.76.0" } },
      { title: "Tasks", path: "/tasks", icon: ListTodo },
    ],
  },
  {
    label: "AI",
    items: [
      { title: "Skills", path: "/skills", icon: BookOpen },
      { title: "MCP Servers", path: "/mcp-servers", icon: Cable },
      { title: "Memory", path: "/memory", icon: Brain },
    ],
  },
  {
    label: "Operations",
    items: [
      { title: "Schedules", path: "/schedules", icon: Clock },
      { title: "Workflows", path: "/workflows", icon: Workflow },
      { title: "Pages", path: "/pages", icon: Globe, gate: { minVersion: "1.79.0" } },
      { title: "Usage", path: "/usage", icon: BarChart3 },
      { title: "Budgets", path: "/budgets", icon: Wallet },
    ],
  },
  {
    label: "Configuration",
    items: [
      { title: "Integrations", path: "/integrations", icon: Plug },
      { title: "Templates", path: "/templates", icon: FileText },
      { title: "Approvals", path: "/approval-requests", icon: ClipboardCheck },
      { title: "Repos", path: "/repos", icon: GitBranch },
    ],
  },
  {
    label: "System",
    items: [
      { title: "Config", path: "/config", icon: Settings },
      { title: "API Keys", path: "/keys", icon: Key },
      { title: "Debug", path: "/debug", icon: Bug },
    ],
  },
];

export function AppSidebar() {
  const location = useLocation();
  const { data: status } = useStatusContext();
  // Feature-gate lookups for nav items whose backing routes need a min API
  // version. Add a new entry here when introducing another gated surface.
  const gates: Record<string, ReturnType<typeof useFeatureGate>> = {
    "1.76.0": useFeatureGate("1.76.0"), // Sessions
    "1.79.0": useFeatureGate("1.79.0"), // Pages
  };
  const isGated = (item: NavItem) =>
    !!item.gate && gates[item.gate.minVersion]?.supported === false;
  // 404 from /status (older API) → hide the Home nav item.
  const homeAvailable = status !== null;
  const identityName = status?.identity.name ?? "Agent Swarm";
  const identityLogo = status?.identity.logo_url ?? "/logo.png";
  const brandColor = status?.identity.brand_color ?? null;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <NavLink
          to={homeAvailable ? "/" : "/dashboard"}
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
          const items = homeAvailable ? group.items : group.items.filter((i) => i.path !== "/");
          if (items.length === 0) return null;
          return (
            <SidebarGroup key={group.label}>
              {/* Section title is hidden in icon-collapsed mode — the items
                  themselves stay so you still get the navigation, just
                  without the truncated "COR / AI / OPE…" labels. */}
              <div className="group-data-[collapsible=icon]:hidden">
                <CollapsibleSection title={group.label} defaultOpen>
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
                            <SidebarMenuButton asChild isActive={isActive}>
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
          <SidebarMenuItem>
            <SidebarTrigger className="w-full justify-start" />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
