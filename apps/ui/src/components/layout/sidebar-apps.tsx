import { useRef } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useApps } from "@/api/hooks/use-apps";
import { LayoutGridIcon, type LayoutGridIconHandle } from "@/components/icons/layout-grid";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useAppSidebarPreferences } from "@/hooks/use-app-sidebar-preferences";
import { visibleSidebarApps } from "@/lib/app-sidebar-preferences";
import { useIsAdmin } from "@/lib/use-can";

function SidebarAppLink({ label, path, active }: { label: string; path: string; active: boolean }) {
  const iconRef = useRef<LayoutGridIconHandle>(null);
  return (
    <SidebarMenuButton asChild isActive={active} tooltip={label}>
      <NavLink
        to={path}
        end={path === "/apps"}
        aria-label={label}
        onMouseEnter={() => iconRef.current?.startAnimation()}
        onMouseLeave={() => iconRef.current?.stopAnimation()}
      >
        <LayoutGridIcon ref={iconRef} aria-hidden size={16} className="shrink-0" />
        <span className="truncate">{label}</span>
      </NavLink>
    </SidebarMenuButton>
  );
}

export function SidebarApps() {
  const isAdmin = useIsAdmin();
  const { preferences } = useAppSidebarPreferences();
  const enabled = isAdmin && preferences.mode !== "hidden";
  const { data, isError } = useApps({ enabled });
  const { pathname } = useLocation();
  if (!enabled) return null;
  const apps = isError ? [] : visibleSidebarApps(data?.apps ?? [], preferences);
  const items = [
    ...apps.map((app) => ({
      label: app.name,
      path: `/apps/${encodeURIComponent(app.id)}`,
      active:
        pathname === `/apps/${encodeURIComponent(app.id)}` ||
        pathname.startsWith(`/apps/${encodeURIComponent(app.id)}/`),
    })),
    { label: "All apps", path: "/apps", active: pathname === "/apps" },
  ];
  const menu = (
    <SidebarGroupContent>
      <SidebarMenu>
        {items.map((item) => (
          <SidebarMenuItem key={item.path}>
            <SidebarAppLink {...item} />
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroupContent>
  );
  return (
    <SidebarGroup>
      <div className="group-data-[collapsible=icon]:hidden">
        <CollapsibleSection title="APPS" defaultOpen persistKey="agent-swarm:sidebar-group:apps">
          {menu}
        </CollapsibleSection>
      </div>
      <div className="hidden group-data-[collapsible=icon]:block">{menu}</div>
    </SidebarGroup>
  );
}
