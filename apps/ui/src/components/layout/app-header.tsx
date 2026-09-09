import { Github } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useHealth } from "@/api/hooks/use-stats";
import type { StatusHealth } from "@/api/types";
import { useStatusContext } from "@/app/status-context";
import { MoonIcon } from "@/components/icons/moon";
import { SunIcon } from "@/components/icons/sun";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useConfig } from "@/hooks/use-config";
import { useTheme } from "@/hooks/use-theme";
import { isDemoMode } from "@/lib/deployment-config";
import { cn } from "@/lib/utils";
import { Breadcrumbs } from "./breadcrumbs";

const HEALTH_DOT_CLASS: Record<StatusHealth, string> = {
  ok: "bg-status-success",
  degraded: "bg-status-pending",
  broken: "bg-status-error",
};

const HEALTH_LABEL: Record<StatusHealth, string> = {
  ok: "All systems go",
  degraded: "Some integrations need attention",
  broken: "Setup required",
};

export function AppHeader() {
  const { theme, toggleTheme } = useTheme();
  const { data: health, isError, error: healthError } = useHealth();
  const { data: status, error: statusError } = useStatusContext();
  const { activeConnection } = useConfig();
  const navigate = useNavigate();

  const isHealthy = health && !isError;
  // `/status` 404 (older API) → fall back to the binary /health probe.
  const aggregateHealth: StatusHealth | null = status?.health ?? null;
  // Both `/status` and `/health` share the same failure (unreachable host, bad
  // key, CORS, ...) — prefer the `/status` error since it's the richer probe,
  // fall back to `/health`'s. `null` here means "still loading", not "ok".
  const connectionErrorMessage = statusError?.message || healthError?.message || null;

  return (
    <header className="flex h-14 items-center gap-2 px-4">
      <SidebarTrigger className="md:hidden" />
      <Separator orientation="vertical" className="mr-2 h-4 md:hidden" />
      {isDemoMode ? (
        <span className="rounded-sm bg-status-info px-1.5 py-0.5 text-[10px] font-medium text-status-info-foreground md:hidden">
          Demo
        </span>
      ) : null}

      {/* The trail owns the header's free space (no fixed spacer) so long
          entity names only truncate when the width is actually exhausted. */}
      <div className="flex flex-1 items-center min-w-0">
        <Breadcrumbs />
      </div>

      <div className="flex items-center gap-3">
        {/* Phase 2: aggregate health badge — clickable, pulls from /status. */}
        {aggregateHealth ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => navigate("/#setup")}
                aria-label={`Swarm health: ${HEALTH_LABEL[aggregateHealth]}`}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1 text-xs",
                  "hover:bg-accent transition-colors",
                  "text-muted-foreground",
                )}
              >
                <span className={cn("size-2 rounded-full", HEALTH_DOT_CLASS[aggregateHealth])} />
                {activeConnection ? (
                  <span className="hidden sm:inline font-medium">{activeConnection.name}</span>
                ) : null}
                {health?.version ? (
                  <span className="hidden sm:inline">v{health.version}</span>
                ) : null}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{HEALTH_LABEL[aggregateHealth]}</TooltipContent>
          </Tooltip>
        ) : (
          // Fallback for older API servers that don't expose /status — keep
          // the binary green/red dot driven by /health alone, but surface the
          // actual fetch error on hover instead of a bare "Disconnected" —
          // a silent badge left users staring at an empty dashboard with no
          // signal of *why* (dead apiUrl, bad key, CORS, ...).
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-2 text-xs text-muted-foreground cursor-default">
                <div
                  className={cn(
                    "size-2 rounded-full",
                    isHealthy ? "bg-status-success" : "bg-status-error",
                  )}
                />
                {activeConnection && (
                  <span className="hidden sm:inline font-medium">{activeConnection.name}</span>
                )}
                {activeConnection && <span className="hidden sm:inline">&mdash;</span>}
                <span className="hidden sm:inline">{isHealthy ? "Connected" : "Disconnected"}</span>
                {health?.version && <span>v{health.version}</span>}
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs text-balance">
              {isHealthy
                ? "Connected"
                : connectionErrorMessage
                  ? `Connection failed: ${connectionErrorMessage}${activeConnection ? ` (${activeConnection.apiUrl})` : ""}`
                  : "Connecting…"}
            </TooltipContent>
          </Tooltip>
        )}

        {/* GitHub repo link */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              asChild
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label="Open agent-swarm on GitHub"
            >
              <a
                href="https://github.com/desplega-ai/agent-swarm"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Github className="size-4" />
                <span className="sr-only">GitHub repository</span>
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">View on GitHub</TooltipContent>
        </Tooltip>

        {/* Theme toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              className="size-8"
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              {/* Animated icons (lucide-animated): rays fade in / moon tilts
                  on hover — affordance feedback on an interactive control. */}
              {theme === "dark" ? <SunIcon size={16} /> : <MoonIcon size={16} />}
              <span className="sr-only">Toggle theme</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
