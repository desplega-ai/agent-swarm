import {
  BarChart3,
  BookOpen,
  Bug,
  Cable,
  ClipboardCheck,
  Clock,
  FileText,
  GitBranch,
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
      { title: "Dashboard", path: "/", icon: LayoutDashboard },
      { title: "Agents", path: "/agents", icon: Users },
      { title: "Tasks", path: "/tasks", icon: ListTodo },
    ],
  },
  {
    label: "AI",
    items: [
      { title: "Skills", path: "/skills", icon: BookOpen },
      { title: "MCP Servers", path: "/mcp-servers", icon: Cable },
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

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <NavLink
          to="/"
          className="flex h-10 items-center gap-2 group-data-[collapsible=icon]:justify-center"
        >
          <img
            src="/logo.png"
            alt="Agent Swarm"
            className="h-8 w-8 min-h-[32px] min-w-[32px] shrink-0 rounded"
          />
          <span className="text-lg font-semibold tracking-tight text-sidebar-foreground group-data-[collapsible=icon]:hidden">
            Agent Swarm
          </span>
        </NavLink>
        <div className="group-data-[collapsible=icon]:hidden">
          <SwarmSwitcher />
        </div>
      </SidebarHeader>

      <SidebarContent>
        {navGroups.map((group) => (
          <SidebarGroup key={group.label}>
            <CollapsibleSection title={group.label} defaultOpen>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => {
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
        ))}
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
