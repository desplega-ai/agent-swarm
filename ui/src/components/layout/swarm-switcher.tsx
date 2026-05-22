import {
  BookOpen,
  Check,
  ChevronsUpDown,
  CreditCard,
  ExternalLink,
  LifeBuoy,
  Settings,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useHealth } from "@/api/hooks/use-stats";
import { useStatusContext } from "@/app/status-context";
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

// Phase 2: cloud-mode menu link defaults. These are placeholders configurable
// via marketing — the brainstorm calls them out as "Docs / Support / Billing".
const CLOUD_DOCS_URL = "https://docs.agent-swarm.dev";
const CLOUD_SUPPORT_URL = "mailto:t@desplega.sh";
const CLOUD_BILLING_URL = "https://cloud.agent-swarm.dev/dashboard/settings/billing";

export function SwarmSwitcher() {
  const { connections, activeConnection, switchConnection } = useConfig();
  const { data: health, isError } = useHealth();
  const { data: status } = useStatusContext();
  const navigate = useNavigate();
  const isCloud = status?.identity.is_cloud === true;

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
                    isHealthy ? "bg-status-success" : "bg-status-error",
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
                          ? "bg-status-success"
                          : "bg-status-error"
                        : "bg-status-neutral",
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
              onClick={() => navigate("/settings/connections")}
              className="flex items-center gap-2 text-xs"
            >
              <Settings className="size-3.5 shrink-0" />
              <span>Manage connections</span>
            </DropdownMenuItem>
            {isCloud ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <a
                    href={CLOUD_DOCS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-xs"
                  >
                    <BookOpen className="size-3.5 shrink-0" />
                    <span>Documentation</span>
                    <ExternalLink className="ml-auto size-3 shrink-0 opacity-60" />
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a
                    href={CLOUD_SUPPORT_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-xs"
                  >
                    <LifeBuoy className="size-3.5 shrink-0" />
                    <span>Support</span>
                    <ExternalLink className="ml-auto size-3 shrink-0 opacity-60" />
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a
                    href={CLOUD_BILLING_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-xs"
                  >
                    <CreditCard className="size-3.5 shrink-0" />
                    <span>Billing</span>
                    <ExternalLink className="ml-auto size-3 shrink-0 opacity-60" />
                  </a>
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
