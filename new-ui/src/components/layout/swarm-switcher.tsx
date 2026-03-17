import { Check, ChevronsUpDown, Settings } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useHealth } from "@/api/hooks/use-stats";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { useConfig } from "@/hooks/use-config";
import { cn } from "@/lib/utils";

export function SwarmSwitcher() {
  const { connections, activeConnection, switchConnection } = useConfig();
  const { data: health, isError } = useHealth();
  const navigate = useNavigate();

  const isHealthy = !!health && !isError;
  const displayName = activeConnection?.name ?? "No connection";

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton className="w-full justify-between text-xs">
              <div className="flex items-center gap-2 truncate">
                <div
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    isHealthy ? "bg-emerald-500" : "bg-red-500",
                  )}
                />
                <span className="truncate font-medium">{displayName}</span>
              </div>
              <ChevronsUpDown className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56" side="right" sideOffset={4}>
            {connections.map((conn) => {
              const isActive = conn.id === activeConnection?.id;
              return (
                <DropdownMenuItem
                  key={conn.id}
                  onClick={() => switchConnection(conn.id)}
                  className="flex items-center gap-2 text-xs"
                >
                  <Check
                    className={cn("size-3.5 shrink-0", isActive ? "opacity-100" : "opacity-0")}
                  />
                  <div
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      isActive
                        ? isHealthy
                          ? "bg-emerald-500"
                          : "bg-red-500"
                        : "bg-zinc-400 dark:bg-zinc-600",
                    )}
                  />
                  <span className="truncate">{conn.name}</span>
                </DropdownMenuItem>
              );
            })}
            {connections.length === 0 && (
              <DropdownMenuItem disabled className="text-xs text-muted-foreground">
                No connections
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => navigate("/config")}
              className="flex items-center gap-2 text-xs"
            >
              <Settings className="size-3.5 shrink-0" />
              <span>Manage connections</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
