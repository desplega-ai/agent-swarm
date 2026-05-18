import { useState } from "react";
import { toast } from "sonner";
import { useResolveUnmapped } from "@/api/hooks/use-users";
import type { UnmappedIdentity } from "@/api/types";
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
          <DialogTitle>Create user from unmapped identity</DialogTitle>
        </DialogHeader>
        {target && (
          <div className="space-y-3 py-2">
            <div className="rounded-md border border-border bg-muted/30 p-2.5 text-xs">
              <div className="text-[10px] uppercase text-muted-foreground mb-1">Will be linked</div>
              <div className="font-mono">
                {target.kind} · {target.externalId}
              </div>
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
