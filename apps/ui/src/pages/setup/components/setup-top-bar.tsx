import { Minimize2 } from "lucide-react";
import { useStatus } from "@/api/hooks/use-status";
import { MoonIcon } from "@/components/icons/moon";
import { SunIcon } from "@/components/icons/sun";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/hooks/use-theme";
import { DEFAULT_SWARM_NAME, swarmDisplayName } from "./swarm-name";

interface SetupTopBarProps {
  /** False before a connection exists: no `/status` read, no Minimize. */
  configured: boolean;
  /** Omit to hide Minimize (no connection, or no onboarding payload yet). */
  onMinimize?: () => void;
  minimizing?: boolean;
}

export function SetupTopBar({ configured, onMinimize, minimizing }: SetupTopBarProps) {
  const { theme, toggleTheme } = useTheme();
  return (
    <header className="sticky top-0 z-40 flex h-12 items-center gap-2.5 border-b border-border bg-background px-3 sm:px-4">
      <img src="/logo.png" alt="" className="size-[22px] shrink-0 object-contain" />
      <span className="min-w-0 truncate text-sm font-semibold tracking-tight">
        {configured ? <SwarmName /> : DEFAULT_SWARM_NAME}
      </span>
      <span className="hidden shrink-0 border-l border-border pl-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground sm:inline">
        Setup
      </span>
      <span className="flex-1" />
      <Button
        variant="outline"
        size="icon-sm"
        onClick={toggleTheme}
        aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      >
        {theme === "dark" ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      </Button>
      {onMinimize ? (
        <Button variant="outline" size="sm" onClick={onMinimize} disabled={minimizing}>
          <Minimize2 />
          Minimize
        </Button>
      ) : null}
    </header>
  );
}

/** `StatusProvider` is not mounted on `/setup`, so read `/status` directly. */
function SwarmName() {
  const { data } = useStatus({ pollIntervalMs: 30_000 });
  return <>{swarmDisplayName(data?.identity.name)}</>;
}
