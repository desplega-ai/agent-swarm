import { useId, useState } from "react";
import { useInspectPageRoom } from "@/api/hooks/use-rooms";
import { JsonViewer } from "@/components/shared/json-viewer";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SettingsRow } from "@/components/ui/settings-row";

/**
 * "Saved room state" dialog, opened from the page header's icon button so it
 * takes no room in the page flow. Closing it keeps the room name and the
 * last result.
 */
export function RoomInspectorDialog({
  pageId,
  open,
  onOpenChange,
}: {
  pageId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState("default");
  const inputId = useId();
  const inspection = useInspectPageRoom(pageId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Saved room state</DialogTitle>
          <DialogDescription>
            Inspect the last saved state without changing the room. Recent edits may still be
            waiting to save.
          </DialogDescription>
        </DialogHeader>
        <form
          className="min-w-0 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            inspection.mutate(name);
          }}
        >
          <div className="flex flex-wrap items-end gap-2">
            <SettingsRow label="Room name" htmlFor={inputId} className="space-y-1">
              <Input
                id={inputId}
                value={name}
                pattern={"[a-zA-Z0-9_\\-]{1,64}"}
                maxLength={64}
                required
                onChange={(event) => {
                  setName(event.target.value);
                  inspection.reset();
                }}
              />
            </SettingsRow>
            <Button type="submit" variant="outline" disabled={inspection.isPending}>
              {inspection.isPending ? "Reading…" : "Inspect saved state"}
            </Button>
          </div>
          {inspection.error && <AlertCallout tone="error">{inspection.error.message}</AlertCallout>}
          {inspection.isSuccess && inspection.data === null && (
            <p className="text-sm text-muted-foreground">This room has no saved state yet.</p>
          )}
          {inspection.data && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Schema version {inspection.data.schemaVersion}
              </p>
              <JsonViewer data={inspection.data.state} />
            </div>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
