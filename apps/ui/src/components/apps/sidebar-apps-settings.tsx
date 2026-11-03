import { useId, useRef } from "react";
import { useApps } from "@/api/hooks/use-apps";
import { SettingsIcon, type SettingsIconHandle } from "@/components/icons/settings";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsRow } from "@/components/ui/settings-row";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useAppSidebarPreferences } from "@/hooks/use-app-sidebar-preferences";
import { type AppSidebarMode, visibleSidebarApps } from "@/lib/app-sidebar-preferences";
import { useIsAdmin } from "@/lib/use-can";

export function SidebarAppsSettings() {
  const isAdmin = useIsAdmin();
  const { preferences, setPreferences } = useAppSidebarPreferences();
  const { data, isPending, isError } = useApps({ enabled: isAdmin });
  const labelId = useId();
  const iconRef = useRef<SettingsIconHandle>(null);
  if (!isAdmin) return null;
  const apps = visibleSidebarApps(data?.apps ?? [], { mode: "all", selectedIds: [] });
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          aria-label="Configure apps in sidebar"
          title="Configure apps in sidebar"
          onMouseEnter={() => iconRef.current?.startAnimation()}
          onMouseLeave={() => iconRef.current?.stopAnimation()}
        >
          <SettingsIcon ref={iconRef} size={16} aria-hidden />
        </Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Apps in sidebar</SheetTitle>
          <SheetDescription>
            Your menu preferences for this Swarm, saved in this browser. Other users are not
            affected.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
          <p className="text-sm text-muted-foreground">
            Changes apply immediately. Hiding the APPS section keeps the Apps catalog under WORK.
          </p>
          <SettingsRow label="Show apps" htmlFor={labelId}>
            <Select
              value={preferences.mode}
              onValueChange={(mode) =>
                setPreferences({ ...preferences, mode: mode as AppSidebarMode })
              }
            >
              <SelectTrigger id={labelId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All apps</SelectItem>
                <SelectItem value="selected">Selected apps</SelectItem>
                <SelectItem value="hidden">Hide section</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
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
                  <Label key={app.id} className="flex items-center gap-3 text-sm">
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
                  </Label>
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
        </div>
      </SheetContent>
    </Sheet>
  );
}
