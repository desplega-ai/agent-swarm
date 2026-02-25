import { Moon, Sun } from "lucide-react";
import { useHealth } from "@/api/hooks/use-stats";
import { useTheme } from "@/hooks/use-theme";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Breadcrumbs } from "./breadcrumbs";
import { cn } from "@/lib/utils";

export function AppHeader() {
  const { theme, toggleTheme } = useTheme();
  const { data: health, isError } = useHealth();

  const isHealthy = health && !isError;

  return (
    <header className="flex h-14 items-center gap-2 border-b border-border px-4">
      <SidebarTrigger className="md:hidden" />
      <Separator orientation="vertical" className="mr-2 h-4 md:hidden" />

      <Breadcrumbs />

      <div className="flex-1" />

      <div className="flex items-center gap-3">
        {/* Health indicator */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <div
            className={cn(
              "size-2 rounded-full",
              isHealthy
                ? "bg-terminal-green animate-heartbeat"
                : "bg-terminal-red",
            )}
          />
          <span className="hidden sm:inline">
            {isHealthy ? "Connected" : "Disconnected"}
          </span>
        </div>

        {/* Theme toggle */}
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleTheme}
          className="size-8"
        >
          {theme === "dark" ? (
            <Sun className="size-4" />
          ) : (
            <Moon className="size-4" />
          )}
          <span className="sr-only">Toggle theme</span>
        </Button>
      </div>
    </header>
  );
}
