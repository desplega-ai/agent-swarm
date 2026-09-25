import { Minimize2 } from "lucide-react";
import type { ReactNode } from "react";
import { useStatus } from "@/api/hooks/use-status";
import { MoonIcon } from "@/components/icons/moon";
import { SunIcon } from "@/components/icons/sun";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";
import { SETUP_COLUMN } from "./setup-layout";
import { DEFAULT_SWARM_NAME, swarmDisplayName } from "./swarm-name";

interface SetupTopBarProps {
  /** False before a connection exists: no `/status` read, no Minimize. */
  configured: boolean;
  /** The header stepper, centered on the page column. */
  stepper: ReactNode;
  /** Omit to hide Minimize (no connection, or no onboarding payload yet). */
  onMinimize?: () => void;
  minimizing?: boolean;
}

/**
 * Fixed header: the swarm mark and name on the left, the stepper centered on
 * the page column, theme and Minimize on the right. The side columns share
 * the leftover width equally, so the stepper never shifts when the name changes.
 */
export function SetupTopBar({ configured, stepper, onMinimize, minimizing }: SetupTopBarProps) {
  const { theme, toggleTheme } = useTheme();
  return (
    <header className="shrink-0 border-b border-border bg-background">
      <div
        className={cn(
          SETUP_COLUMN,
          "grid h-14 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 sm:gap-4",
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <img src="/logo.png" alt="" className="size-[22px] shrink-0 object-contain" />
          <span className="hidden min-w-0 truncate text-sm font-semibold tracking-tight sm:inline">
            {configured ? <SwarmName /> : DEFAULT_SWARM_NAME}
          </span>
        </div>

        {stepper}

        <div className="flex items-center justify-end gap-1.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? <SunIcon size={16} /> : <MoonIcon size={16} />}
          </Button>
          {onMinimize ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onMinimize}
                  disabled={minimizing}
                  aria-label="Minimize setup"
                  className="max-md:size-8 max-md:px-0"
                >
                  <Minimize2 />
                  <span className="hidden md:inline">Minimize</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6} className="max-w-60">
                Progress is saved. Resume from the Setup pill.
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </div>
    </header>
  );
}

/** `StatusProvider` is not mounted on `/setup`, so read `/status` directly. */
function SwarmName() {
  const { data } = useStatus({ pollIntervalMs: 30_000 });
  return <>{swarmDisplayName(data?.identity.name)}</>;
}
