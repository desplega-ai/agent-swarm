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
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";

const navItems = [
  { title: "Dashboard", path: "/", icon: LayoutDashboard },
  { title: "Agents", path: "/agents", icon: Users },
  { title: "Tasks", path: "/tasks", icon: ListTodo },
  { title: "Epics", path: "/epics", icon: Milestone },
  { title: "Chat", path: "/chat", icon: MessageSquare },
  { title: "Services", path: "/services", icon: Server },
  { title: "Schedules", path: "/schedules", icon: Clock },
  { title: "Usage", path: "/usage", icon: BarChart3 },
  { title: "Config", path: "/config", icon: Settings },
  { title: "Repos", path: "/repos", icon: GitBranch },
];

export function AppSidebar() {
  const location = useLocation();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <NavLink to="/" className="flex items-center gap-2 px-2 py-2">
          <img
            src="/logo.png"
            alt="Agent Swarm"
            className="h-8 w-8 rounded"
          />
          <span className="font-display text-lg tracking-wider text-hive-amber group-data-[collapsible=icon]:hidden">
            Agent Swarm
          </span>
        </NavLink>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => {
                const isActive =
                  item.path === "/"
                    ? location.pathname === "/"
                    : location.pathname.startsWith(item.path);
                return (
                  <SidebarMenuItem key={item.path}>
                    <SidebarMenuButton asChild isActive={isActive}>
                      <NavLink
                        to={item.path}
                        end={item.path === "/"}
                        className={
                          isActive
                            ? "text-hive-amber border-l-2 border-hive-amber"
                            : "text-sidebar-foreground hover:text-hive-amber"
                        }
                      >
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
