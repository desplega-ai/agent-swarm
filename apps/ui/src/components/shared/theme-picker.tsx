import { Check, Monitor, Moon, Sun } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type ThemeMode, useTheme } from "@/hooks/use-theme";
import { THEME_PRESETS } from "@/lib/themes";
import { cn } from "@/lib/utils";

/**
 * The operator's theme choices from `useTheme()` (localStorage, never swarm
 * state). Settings > Appearance and the `/setup` identity step render them.
 */

export const THEME_MODES: Array<{ id: ThemeMode; label: string; icon: typeof Sun; hint: string }> =
  [
    { id: "light", label: "Light", icon: Sun, hint: "Always light" },
    { id: "dark", label: "Dark", icon: Moon, hint: "Always dark" },
    { id: "system", label: "System", icon: Monitor, hint: "Follow the OS setting" },
  ];

/**
 * The preset grid. A pick applies at once. Each swatch shows the preset's
 * accent on its field in the mode on screen. `compact`: small chips (swatch
 * and name, the description in a tooltip) for a narrow column.
 */
export function ThemePresetPicker({ compact = false }: { compact?: boolean }) {
  const { theme, preset, setPreset } = useTheme();

  return (
    <div
      className={
        compact
          ? "grid grid-cols-2 gap-1.5 lg:grid-cols-3"
          : "grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
      }
    >
      {THEME_PRESETS.map((entry) => {
        const selected = preset === entry.id;
        const accent = entry.accent[theme];
        const field = entry.field[theme];
        if (compact) {
          return (
            <Tooltip key={entry.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setPreset(entry.id)}
                  className={cn(
                    "flex h-7 min-w-0 items-center gap-2 rounded-md border px-1.5 text-left text-xs transition-colors hover-linger",
                    "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                    selected ? "border-primary ring-1 ring-primary" : "border-border",
                  )}
                >
                  <span
                    className="flex size-4.5 shrink-0 items-center justify-center rounded-[4px] border border-border"
                    style={{ backgroundColor: field }}
                    aria-hidden="true"
                  >
                    <span className="size-2 rounded-full" style={{ backgroundColor: accent }} />
                  </span>
                  <span className="truncate">{entry.name}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-64">
                {entry.description}
              </TooltipContent>
            </Tooltip>
          );
        }
        return (
          <button
            key={entry.id}
            type="button"
            aria-pressed={selected}
            onClick={() => setPreset(entry.id)}
            className={cn(
              "flex flex-col gap-2 rounded-lg border p-3 text-left transition-colors",
              "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
              selected ? "border-ring" : "border-border",
            )}
          >
            <span
              className="flex h-9 items-center gap-2 rounded-md border border-border px-2.5"
              style={{ backgroundColor: field }}
              aria-hidden="true"
            >
              <span className="size-3.5 rounded-full" style={{ backgroundColor: accent }} />
              <span className="h-1.5 flex-1 rounded-full bg-border/60" />
            </span>
            <span className="flex items-center gap-1.5 text-sm font-medium">
              {entry.name}
              {selected && <Check className="size-3.5 text-primary" />}
            </span>
            <span className="text-xs text-muted-foreground">{entry.description}</span>
          </button>
        );
      })}
    </div>
  );
}
