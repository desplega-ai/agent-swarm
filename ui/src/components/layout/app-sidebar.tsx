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
  Home,
  Key,
  LayoutDashboard,
  ListTodo,
  Plug,
  Settings,
  Users,
  Wallet,
  Workflow,
} from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
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

const navGroups = [
  {
    label: "Core",
    items: [
      { title: "Home", path: "/", icon: Home },
      { title: "Dashboard", path: "/dashboard", icon: LayoutDashboard },
      { title: "Agents", path: "/agents", icon: Users },
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
              if (img.src !== window.location.origin + "/logo.png") {
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
              <CollapsibleSection title={group.label} defaultOpen>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {items.map((item) => {
                      const isActive =
                        item.path === "/"
                          ? location.pathname === "/"
                          : location.pathname.startsWith(item.path);
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
