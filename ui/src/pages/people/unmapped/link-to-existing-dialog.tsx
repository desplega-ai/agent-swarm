import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useResolveUnmapped, useUsers } from "@/api/hooks/use-users";
import type { UnmappedIdentity } from "@/api/types";
import { Combobox } from "@/components/shared/combobox";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

export function LinkToExistingDialog({
  target,
  onOpenChange,
}: {
  target: UnmappedIdentity | null;
  onOpenChange: (open: boolean) => void;
}) {
  const open = target !== null;
  const { data: users } = useUsers({ recentEvents: 0 });
  const resolve = useResolveUnmapped();
  const [userId, setUserId] = useState<string | null>(null);

  const options = useMemo(
    () =>
      (users ?? []).map((u) => ({
        value: u.id,
        label: u.email ? `${u.name} · ${u.email}` : u.name,
      })),
    [users],
  );

  async function submit() {
    if (!target || !userId) return;
    try {
      await resolve.mutateAsync({
        kind: target.kind,
        externalId: target.externalId,
        body: { userId },
      });
      toast.success("Identity linked to user");
      setUserId(null);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to link");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setUserId(null);
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Link to existing user</DialogTitle>
        </DialogHeader>
        {target && (
          <div className="space-y-3 py-2">
            <div className="rounded-md border border-border bg-muted/30 p-2.5 text-xs">
              <div className="text-[10px] uppercase text-muted-foreground mb-1">Identity</div>
              <div className="font-mono">
                {target.kind} · {target.externalId}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Target user</Label>
              <Combobox
                options={options}
                value={userId}
                onChange={setUserId}
                placeholder="Pick a user…"
                searchPlaceholder="Search by name or email…"
              />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!userId || resolve.isPending}>
            {resolve.isPending ? "Linking…" : "Link identity"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
