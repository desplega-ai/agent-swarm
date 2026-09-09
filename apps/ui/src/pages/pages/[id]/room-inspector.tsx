import { useId, useState } from "react";
import { useInspectPageRoom } from "@/api/hooks/use-rooms";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { JsonViewer } from "@/components/shared/json-viewer";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsRow } from "@/components/ui/settings-row";

export function RoomInspector({ pageId }: { pageId: string }) {
  const [name, setName] = useState("default");
  const inputId = useId();
  const inspection = useInspectPageRoom(pageId);
  return (
    <CollapsibleSection title="Saved room state">
      <form
        className="space-y-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          inspection.mutate(name);
        }}
      >
        <p className="text-xs text-muted-foreground">
          Inspect the last saved state without changing the room. Recent edits may still be waiting
          to save.
        </p>
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
    </CollapsibleSection>
  );
}
