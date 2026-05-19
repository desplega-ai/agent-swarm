import { useState } from "react";
import { toast } from "sonner";
import { useCreateUser } from "@/api/hooks/use-users";
import type { UserIdentity } from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PendingIdentityComposer, PendingIdentityRow } from "./identity-row";

export function NewUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createUser = useCreateUser();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [identities, setIdentities] = useState<UserIdentity[]>([]);
  const [draftKind, setDraftKind] = useState("slack");
  const [draftId, setDraftId] = useState("");

  function reset() {
    setName("");
    setEmail("");
    setIdentities([]);
    setDraftKind("slack");
    setDraftId("");
  }

  function addDraft() {
    const id = draftId.trim();
    const kind = draftKind.trim().toLowerCase();
    if (!id || !kind) return;
    if (identities.some((i) => i.kind === kind && i.externalId === id)) return;
    setIdentities((prev) => [...prev, { kind, externalId: id }]);
    setDraftId("");
  }

  function updateIdentity(idx: number, next: UserIdentity) {
    setIdentities((prev) => prev.map((i, k) => (k === idx ? next : i)));
  }

  function removeIdentity(idx: number) {
    setIdentities((prev) => prev.filter((_, i) => i !== idx));
  }

  async function submit() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error("Name is required");
      return;
    }
    // Drop blank-externalId rows silently — they're scaffolding.
    const cleanIdentities = identities.filter((i) => i.externalId.trim() && i.kind.trim());
    try {
      await createUser.mutateAsync({
        name: trimmedName,
        email: email.trim() || undefined,
        identities: cleanIdentities.length > 0 ? cleanIdentities : undefined,
      });
      toast.success(`User "${trimmedName}" created`);
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create user");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New user</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-user-name">Name</Label>
              <Input
                id="new-user-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ada Lovelace"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-user-email">Email (optional)</Label>
              <Input
                id="new-user-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ada@example.com"
                className="font-mono"
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <Label className="text-sm">Initial identities</Label>
              <span className="text-[11px] text-muted-foreground">
                {identities.length === 0
                  ? "Optional — link platform accounts to this user."
                  : `${identities.length} pending`}
              </span>
            </div>

            {identities.length > 0 && (
              <div className="space-y-1.5">
                {identities.map((ident, idx) => (
                  <PendingIdentityRow
                    key={`${ident.kind}:${ident.externalId}:${idx}`}
                    identity={ident}
                    onChange={(next) => updateIdentity(idx, next)}
                    onRemove={() => removeIdentity(idx)}
                  />
                ))}
              </div>
            )}

            <PendingIdentityComposer
              draftKind={draftKind}
              setDraftKind={setDraftKind}
              draftId={draftId}
              setDraftId={setDraftId}
              onAdd={addDraft}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={createUser.isPending}>
            {createUser.isPending ? "Creating…" : "Create user"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
