import { THEME_MODES, ThemePresetPicker } from "@/components/shared/theme-picker";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

/**
 * Appearance settings: the operator's browser-local presentation choices,
 * mode (light / dark / follow system) and the dashboard-wide theme preset.
 * Both live in localStorage: they are per-person, per-browser preferences,
 * not swarm state. Swarm apps can carry their OWN preset (definition `theme`
 * + the viewer's per-app override), which wins inside the app canvas.
 */

export default function AppearancePage() {
  const { mode, setMode } = useTheme();

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
            {THEME_MODES.map(({ id, label, icon: Icon, hint }) => (
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
          <ThemePresetPicker />
        </CardContent>
      </Card>
    </div>
  );
}
