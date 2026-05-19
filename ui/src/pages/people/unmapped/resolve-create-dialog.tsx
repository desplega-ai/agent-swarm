import { UserPlus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useResolveUnmapped } from "@/api/hooks/use-users";
import type { UnmappedIdentity } from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getIntegrationLabel, IntegrationIcon } from "../integration-icons";

/**
 * Resolve an unmapped identity by creating a brand-new user. The identity's
 * kind + externalId are pre-bound by the row that triggered the dialog (the
 * webhook source decided them) — operators just supply name + email.
 *
 * No kind picker here on purpose: the dialog represents a one-way binding
 * from the existing unmapped row to a fresh user record.
 */
export function ResolveCreateDialog({
  target,
  onOpenChange,
}: {
  target: UnmappedIdentity | null;
  onOpenChange: (open: boolean) => void;
}) {
  const open = target !== null;
  const resolve = useResolveUnmapped();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  function reset() {
    setName("");
    setEmail("");
  }

  async function submit() {
    if (!target) return;
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName) {
      toast.error("Name is required");
      return;
    }
    if (!trimmedEmail) {
      toast.error("Email is required (server validates email format)");
      return;
    }
    try {
      await resolve.mutateAsync({
        kind: target.kind,
        externalId: target.externalId,
        body: { name: trimmedName, email: trimmedEmail },
      });
      toast.success(`User "${trimmedName}" created and linked`);
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            Create user from unmapped identity
          </DialogTitle>
          <DialogDescription>
            A new user will be created and this platform identity linked to it on save.
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
                Will link
              </span>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="resolve-name">Name</Label>
              <Input
                id="resolve-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ada Lovelace"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="resolve-email">Email</Label>
              <Input
                id="resolve-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ada@example.com"
                className="font-mono"
              />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={resolve.isPending}>
            {resolve.isPending ? "Creating…" : "Create + link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
