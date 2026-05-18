import { Plus, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useCreateUser } from "@/api/hooks/use-users";
import type { UserIdentity } from "@/api/types";
import { Badge } from "@/components/ui/badge";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const KIND_OPTIONS = ["slack", "linear", "github", "gitlab", "jira", "agentmail", "custom"];

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
    if (!id) return;
    if (identities.some((i) => i.kind === draftKind && i.externalId === id)) return;
    setIdentities((prev) => [...prev, { kind: draftKind, externalId: id }]);
    setDraftId("");
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
    try {
      await createUser.mutateAsync({
        name: trimmedName,
        email: email.trim() || undefined,
        identities: identities.length > 0 ? identities : undefined,
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New user</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
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
            />
          </div>
          <div className="space-y-1.5">
            <Label>Initial identities (optional)</Label>
            <div className="flex items-center gap-2">
              <Select value={draftKind} onValueChange={setDraftKind}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KIND_OPTIONS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={draftId}
                onChange={(e) => setDraftId(e.target.value)}
                placeholder="external id"
                className="flex-1 font-mono text-xs"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addDraft();
                  }
                }}
              />
              <Button
                type="button"
                size="icon"
                variant="outline"
                onClick={addDraft}
                disabled={!draftId.trim()}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            {identities.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {identities.map((ident, idx) => (
                  <Badge
                    key={`${ident.kind}:${ident.externalId}`}
                    variant="outline"
                    className="gap-1 font-mono normal-case"
                  >
                    <span>
                      {ident.kind}:{ident.externalId}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeIdentity(idx)}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label="Remove identity"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
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
