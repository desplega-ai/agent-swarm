import { Github, Search } from "lucide-react";
import { useState } from "react";
import { useHealth, useStats } from "@/api/hooks/use-stats";
import { useStatusContext } from "@/app/status-context";
import { ContextPanelToggle } from "@/components/context-panel/context-session-panel";
import { MoonIcon } from "@/components/icons/moon";
import { SunIcon } from "@/components/icons/sun";
import { ImprovementHeaderButton } from "@/components/improvements/improvement-header-button";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { SetupPill } from "@/components/onboarding/setup-pill";
import { useOpenCommandMenu } from "@/components/shared/command-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useConfig } from "@/hooks/use-config";
import { useIsPhone } from "@/hooks/use-mobile";
import { useTheme } from "@/hooks/use-theme";
import { modKeyLabel } from "@/lib/approval-shortcuts";
import { isDemoMode } from "@/lib/deployment-config";
import { cn } from "@/lib/utils";
import { Breadcrumbs } from "./breadcrumbs";
import { HealthBadge } from "./health-badge";
import { PhoneHeaderMenu } from "./phone-header-menu";

/** Phones (below `md`) get their own three-zone bar; `md` and up the full one. */
export function AppHeader() {
  return useIsPhone() ? <PhoneHeader /> : <DesktopHeader />;
}

/**
 * The phone bar, laid out like a native navigation bar: the menu leads, the
 * page name owns the middle, search, the bell and one "more" sheet trail.
 * Every control is a 44 px ghost icon button. Health shows here only when it
 * needs a person (unhealthy, or the API unreachable); the rest of the desktop
 * cluster, healthy details included, lives in the sheet
 * (`PhoneHeaderMenu`). The safe-area padding keeps it clear of the notch
 * when the page runs edge to edge (an installed web app).
 */
function PhoneHeader() {
  const { data: status, error: statusError } = useStatusContext();
  const { isError: healthFailed, error: healthError } = useHealth();
  const openCommandMenu = useOpenCommandMenu();
  // A failed probe means the API is unreachable. Say so in the bar, as the
  // desktop red dot does, instead of waiting for someone to open the menu. It
  // wins over a `/status` snapshot, which may be stale from before the outage.
  const disconnected = healthFailed || (!status && Boolean(statusError));
  const connectionErrorMessage = statusError?.message || healthError?.message || null;

  return (
    <header className="flex h-[calc(3.5rem+env(safe-area-inset-top))] shrink-0 items-center gap-0.5 bg-background pt-[env(safe-area-inset-top)] pr-[max(0.25rem,env(safe-area-inset-right))] pl-[max(0.25rem,env(safe-area-inset-left))]">
      <SidebarTrigger className="size-11 [&_svg]:size-5" />
      {isDemoMode ? (
        <span className="rounded-sm bg-status-info px-1.5 py-0.5 text-[10px] font-medium text-status-info-foreground">
          Demo
        </span>
      ) : null}
      <div className="flex min-w-0 flex-1 items-center">
        <Breadcrumbs />
      </div>
      {disconnected ? (
        <PhoneDisconnected message={connectionErrorMessage} />
      ) : status && status.health !== "ok" ? (
        <HealthBadge status={status} className="h-11 min-w-11 justify-center" />
      ) : null}
      <Button
        variant="ghost"
        size="icon"
        onClick={openCommandMenu}
        aria-label="Search"
        aria-keyshortcuts="Meta+K Control+K"
        className="size-11"
      >
        <Search className="size-5" />
      </Button>
      <NotificationBell className="size-11 [&_svg]:size-5 [&_[data-slot=badge]]:top-1.5 [&_[data-slot=badge]]:right-1" />
      <PhoneHeaderMenu />
    </header>
  );
}

/** The phone bar's red dot while the API is unreachable; a tap says why. */
function PhoneDisconnected({ message }: { message: string | null }) {
  const { activeConnection } = useConfig();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label="Swarm health: Disconnected"
        >
          <span aria-hidden="true" className="size-2.5 rounded-full bg-status-error" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Connection" className="w-72 space-y-1 text-sm">
        <p className="font-medium">Disconnected</p>
        <p className="text-xs text-muted-foreground text-balance">
          {message
            ? `Connection failed: ${message}${activeConnection ? ` (${activeConnection.apiUrl})` : ""}`
            : "Connecting…"}
        </p>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Header layouts under review on PR #2866. Pick one with
 * `localStorage["agent-swarm:header-variant"] = "a" | "b" | "c"`. The switch
 * goes away once one is chosen.
 * - a: health pill and search, then the icons in one bordered toolbar.
 * - b: a wide search in the centre; health as a dot with the icons on the right.
 * - c: compact: health as a dot, search as an icon, ghost icons only.
 */
type HeaderVariant = "a" | "b" | "c";
const HEADER_VARIANT_KEY = "agent-swarm:header-variant";

function readHeaderVariant(): HeaderVariant {
  try {
    const value = window.localStorage.getItem(HEADER_VARIANT_KEY);
    return value === "b" || value === "c" ? value : "a";
  } catch {
    return "a";
  }
}

function DesktopHeader() {
  const { data: health, isError, error: healthError } = useHealth();
  const stats = useStats();
  const { data: status, error: statusError } = useStatusContext();
  const { activeConnection } = useConfig();
  const openCommandMenu = useOpenCommandMenu();
  const [variant] = useState(readHeaderVariant);

  const isHealthy = health && !isError;
  const devMode = Boolean(isHealthy && !stats.isError && stats.data?.devMode === true);
  // Both `/status` and `/health` share the same failure (unreachable host, bad
  // key, CORS, ...) — prefer the `/status` error since it's the richer probe,
  // fall back to `/health`'s. `null` here means "still loading", not "ok".
  const connectionErrorMessage = statusError?.message || healthError?.message || null;
  const compactHealth = variant !== "a";

  // Aggregate health (components/layout/health-badge.tsx), with dev mode
  // folded in. `/status` 404 (older API) → the binary /health probe.
  const healthEl = status ? (
    <HealthBadge status={status} devMode={devMode} compact={compactHealth} />
  ) : (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex cursor-default items-center gap-2 text-xs text-muted-foreground">
          <div
            className={cn(
              "size-2 rounded-full",
              isHealthy ? "bg-status-success" : "bg-status-error",
            )}
          />
          {compactHealth ? null : (
            <span className="hidden sm:inline">{isHealthy ? "Connected" : "Disconnected"}</span>
          )}
          {devMode ? (
            <Badge variant="outline" size="tag" title="Dev mode: UI version checks are bypassed">
              Dev
            </Badge>
          ) : null}
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
  );

  const icons = (
    <>
      <ImprovementHeaderButton />
      <NotificationBell />
      <ContextPanelToggle />
      <GitHubLink />
      <ThemeToggle />
    </>
  );

  const searchLabel = variant === "b" ? "Search tasks, sessions, pages…" : "Search";
  const search =
    variant === "c" ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={openCommandMenu}
            aria-label="Search"
            aria-keyshortcuts="Meta+K Control+K"
            className="size-8"
          >
            <Search className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Search {modKeyLabel()}K</TooltipContent>
      </Tooltip>
    ) : (
      // Cmd+K's visible door.
      <Button
        variant="outline"
        size="sm"
        onClick={openCommandMenu}
        aria-label="Search"
        aria-keyshortcuts="Meta+K Control+K"
        className={cn(
          "h-8 gap-2 px-2 text-muted-foreground max-sm:size-8 sm:justify-start",
          variant === "b" ? "w-full max-w-md" : "sm:w-44",
        )}
      >
        <Search className="size-4" />
        <span className="truncate max-sm:hidden">{searchLabel}</span>
        <Kbd aria-hidden className="ml-auto max-sm:hidden">
          {modKeyLabel()}K
        </Kbd>
      </Button>
    );

  const lead = (
    <>
      <SidebarTrigger className="md:hidden" />
      <Separator orientation="vertical" className="mr-2 h-4 md:hidden" />
      {isDemoMode ? (
        <span className="rounded-sm bg-status-info px-1.5 py-0.5 text-[10px] font-medium text-status-info-foreground md:hidden">
          Demo
        </span>
      ) : null}
      {/* The trail owns the free space, so long names truncate only when the
          width runs out. */}
      <div className="flex min-w-0 flex-1 items-center">
        <Breadcrumbs />
      </div>
    </>
  );

  if (variant === "b") {
    return (
      <header className="grid h-14 grid-cols-[minmax(0,1fr)_minmax(0,28rem)_minmax(0,1fr)] items-center gap-3 px-4">
        <div className="flex min-w-0 items-center gap-2">{lead}</div>
        <div className="flex justify-center">{search}</div>
        <div className="flex items-center justify-end gap-0.5">
          <SetupPill />
          <div className="mr-1">{healthEl}</div>
          {icons}
        </div>
      </header>
    );
  }

  return (
    <header className="flex h-14 items-center gap-2 px-4">
      {lead}
      <div className="flex items-center gap-1 sm:gap-2">
        {healthEl}
        <SetupPill />
        {search}
      </div>
      {variant === "a" ? (
        <div className="flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5 shadow-xs">
          {icons}
        </div>
      ) : (
        <div className="flex items-center gap-0.5">{icons}</div>
      )}
    </header>
  );
}

/** The GitHub repo link. Hidden below sm: a phone needs the room for the trail. */
function GitHubLink() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="size-8 max-sm:hidden"
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
  );
}

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleTheme}
          className="size-8"
          aria-label={label}
        >
          {/* Animated icons (lucide-animated): rays fade in / moon tilts on hover. */}
          {theme === "dark" ? <SunIcon size={16} /> : <MoonIcon size={16} />}
          <span className="sr-only">Toggle theme</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
