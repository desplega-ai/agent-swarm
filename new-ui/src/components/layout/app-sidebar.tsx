import { NavLink, useLocation } from "react-router-dom";
import {
  BarChart3,
  Clock,
  GitBranch,
  LayoutDashboard,
  ListTodo,
  MessageSquare,
  Milestone,
  Server,
  Settings,
  Users,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";

const navGroups = [
  {
    label: "Core",
    items: [
      { title: "Dashboard", path: "/", icon: LayoutDashboard },
      { title: "Agents", path: "/agents", icon: Users },
      { title: "Tasks", path: "/tasks", icon: ListTodo },
      { title: "Epics", path: "/epics", icon: Milestone },
    ],
  },
  {
    label: "Communication",
    items: [{ title: "Chat", path: "/chat", icon: MessageSquare }],
  },
  {
    label: "Operations",
    items: [
      { title: "Services", path: "/services", icon: Server },
      { title: "Schedules", path: "/schedules", icon: Clock },
      { title: "Usage", path: "/usage", icon: BarChart3 },
    ],
  },
  {
    label: "System",
    items: [
      { title: "Config", path: "/config", icon: Settings },
      { title: "Repos", path: "/repos", icon: GitBranch },
    ],
  },
];

export function AppSidebar() {
  const location = useLocation();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-14 justify-center border-b border-sidebar-border">
        <NavLink to="/" className="flex items-center gap-2 group-data-[collapsible=icon]:justify-center">
          <img
            src="/logo.png"
            alt="Agent Swarm"
            className="h-8 w-8 min-h-[32px] min-w-[32px] shrink-0 rounded"
          />
          <span className="text-lg font-semibold tracking-tight text-sidebar-foreground group-data-[collapsible=icon]:hidden">
            Agent Swarm
          </span>
        </NavLink>
      </SidebarHeader>

      <SidebarContent>
        {navGroups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
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
