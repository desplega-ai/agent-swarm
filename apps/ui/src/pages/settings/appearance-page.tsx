import { THEME_MODES, ThemePresetPicker } from "@/components/shared/theme-picker";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Switch } from "@/components/ui/switch";
import { useLocalToggle } from "@/hooks/use-local-toggle";
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
  const [autoReload, setAutoReload] = useLocalToggle("entity-auto-reload", false);

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4 sm:gap-6">
      <PageHeader
        title="Appearance"
        description="Stored in this browser only. Every operator picks their own."
      />

      {/* Card py-6 gap-6 cost ~30% of the first phone screen, tighter below sm */}
      <Card className="max-sm:gap-3 max-sm:py-4">
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

      <Card className="max-sm:gap-3 max-sm:py-4">
        <CardHeader>
          <CardTitle>Entity updates</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <div>
            <label htmlFor="entity-auto-reload" className="text-sm font-medium">
              Reload new versions automatically
            </label>
            <p className="text-sm text-muted-foreground">
              After you interact, choose when to load a new version.
            </p>
          </div>
          <Switch id="entity-auto-reload" checked={autoReload} onCheckedChange={setAutoReload} />
        </CardContent>
      </Card>

      <Card className="max-sm:gap-3 max-sm:py-4">
        <CardHeader>
          <CardTitle>Theme</CardTitle>
        </CardHeader>
        {/* 17 presets one per row on a phone (~1,700px); 2 columns, description hidden below sm.
            Page-local override of the shared picker's grid; the real fix is a `cols` prop on ThemePresetPicker. */}
        <CardContent className="max-sm:[&>div]:grid-cols-2 max-sm:[&>div]:gap-2 max-sm:[&>div>button]:p-2 max-sm:[&>div>button>span:last-child]:hidden">
          <ThemePresetPicker />
        </CardContent>
      </Card>
    </div>
  );
}
