import { Check, Monitor, Moon, Sun } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { type ThemeMode, useTheme } from "@/hooks/use-theme";
import { THEME_PRESETS } from "@/lib/themes";
import { cn } from "@/lib/utils";

/**
 * Appearance settings — the operator's browser-local presentation choices:
 * mode (light / dark / follow system) and the dashboard-wide theme preset.
 * Both live in localStorage: they are per-person, per-browser preferences,
 * not swarm state. Swarm apps can carry their OWN preset (definition `theme`
 * + the viewer's per-app override), which wins inside the app canvas.
 */

const MODES: Array<{ id: ThemeMode; label: string; icon: typeof Sun; hint: string }> = [
  { id: "light", label: "Light", icon: Sun, hint: "Always light" },
  { id: "dark", label: "Dark", icon: Moon, hint: "Always dark" },
  { id: "system", label: "System", icon: Monitor, hint: "Follow the OS setting" },
];

export default function AppearancePage() {
  const { mode, theme, preset, setMode, setPreset } = useTheme();

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-6">
      <PageHeader
        title="Appearance"
        description="Stored in this browser only. Every operator picks their own."
      />

      <Card>
        <CardHeader>
          <CardTitle>Mode</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid max-w-xl grid-cols-3 gap-3">
            {MODES.map(({ id, label, icon: Icon, hint }) => (
              <button
                key={id}
                type="button"
                aria-pressed={mode === id}
                title={hint}
                onClick={() => setMode(id)}
                className={cn(
                  "flex flex-col items-center gap-2 rounded-lg border p-4 text-sm transition-colors",
                  "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                  mode === id
                    ? "border-ring bg-accent text-foreground"
                    : "border-border text-muted-foreground",
                )}
              >
                <Icon className="size-4" />
                {label}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Theme</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {THEME_PRESETS.map((entry) => {
              const selected = preset === entry.id;
              const accent = theme === "dark" ? entry.accent.dark : entry.accent.light;
              const field = theme === "dark" ? entry.field.dark : entry.field.light;
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
        </CardContent>
      </Card>
    </div>
  );
}
