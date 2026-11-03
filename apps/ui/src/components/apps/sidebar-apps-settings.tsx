import { useId } from "react";
import { useApps } from "@/api/hooks/use-apps";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { useAppSidebarPreferences } from "@/hooks/use-app-sidebar-preferences";
import { type AppSidebarMode, visibleSidebarApps } from "@/lib/app-sidebar-preferences";
import { useIsAdmin } from "@/lib/use-can";

export function SidebarAppsSettings() {
  const isAdmin = useIsAdmin();
  const { preferences, setPreferences } = useAppSidebarPreferences();
  const { data, isPending, isError } = useApps({ enabled: isAdmin });
  const labelId = useId();
  if (!isAdmin) return null;
  const apps = visibleSidebarApps(data?.apps ?? [], { mode: "all", selectedIds: [] });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Apps in sidebar</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Choose which apps appear in the APPS section. Saved in this browser for your current user
          and Swarm. Hiding the section keeps the Apps catalog under WORK.
        </p>
        <div className="space-y-2">
          <label htmlFor={labelId} className="text-sm font-medium">
            Show apps
          </label>
          <select
            id={labelId}
            value={preferences.mode}
            className="flex h-9 w-full max-w-sm rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) =>
              setPreferences({ ...preferences, mode: event.target.value as AppSidebarMode })
            }
          >
            <option value="all">All apps</option>
            <option value="selected">Selected apps</option>
            <option value="hidden">Hide section</option>
          </select>
        </div>
        {preferences.mode === "selected" && (
          <div className="space-y-3">
            {isPending ? (
              <p className="text-sm text-muted-foreground">Loading apps…</p>
            ) : isError ? (
              <p role="alert" className="text-sm text-destructive">
                Could not load apps. Your selection has been kept.
              </p>
            ) : apps.length === 0 ? (
              <p className="text-sm text-muted-foreground">No apps available.</p>
            ) : (
              apps.map((app) => (
                <label key={app.id} className="flex items-center gap-3 text-sm">
                  <Checkbox
                    checked={preferences.selectedIds.includes(app.id)}
                    onCheckedChange={(checked) =>
                      setPreferences({
                        ...preferences,
                        selectedIds:
                          checked === true
                            ? [...new Set([...preferences.selectedIds, app.id])]
                            : preferences.selectedIds.filter((id) => id !== app.id),
                      })
                    }
                  />
                  <span>{app.name}</span>
                </label>
              ))
            )}
            {!isPending &&
              !isError &&
              apps.length > 0 &&
              preferences.selectedIds.every((id) => !apps.some((app) => app.id === id)) && (
                <p className="text-sm text-muted-foreground">
                  No apps selected. All apps remains available in the sidebar.
                </p>
              )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
