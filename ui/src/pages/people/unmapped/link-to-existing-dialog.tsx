import { LinkIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useResolveUnmapped, useUsers } from "@/api/hooks/use-users";
import type { UnmappedIdentity } from "@/api/types";
import { Combobox } from "@/components/shared/combobox";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { getIntegrationLabel, IntegrationIcon } from "../integration-icons";

/**
 * Link an unmapped platform identity to an existing user. Symmetric to
 * ResolveCreateDialog (which creates a new user from the identity); both
 * dialogs share the same locked-identity header so the operator sees the same
 * "what's being linked" affordance regardless of which branch they pick.
 */
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
          <DialogTitle className="flex items-center gap-2">
            <LinkIcon className="h-4 w-4" />
            Link to existing user
          </DialogTitle>
          <DialogDescription>
            Attach this platform identity to an existing user. Future events from the identity will
            land on their timeline.
          </DialogDescription>
        </DialogHeader>
        {target && (
          <div className="space-y-3 py-2">
            <div className="flex items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2">
              <IntegrationIcon kind={target.kind} className="h-5 w-5 text-foreground/80" />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium">{getIntegrationLabel(target.kind)}</div>
                <div className="font-mono text-xs text-muted-foreground truncate">
                  {target.externalId}
                </div>
              </div>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0">
                Identity
              </span>
            </div>
            <div className="space-y-1.5">
              <Label>Target user</Label>
              <Combobox
                options={options}
                value={userId}
                onChange={setUserId}
                placeholder="Pick a user…"
                searchPlaceholder="Search by name or email…"
                triggerClassName="w-full"
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
