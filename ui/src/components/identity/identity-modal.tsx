/**
 * Phase 3: Identity boot modal.
 *
 * shadcn `Dialog` (NOT `Sheet`) listing every row from `useUsers()` with a
 * select control and an inline "Create new" form (`name` + optional `email`).
 * On submit the chosen / newly-created user's id is pushed into
 * `CurrentUserContext` via `setUserId`, then the modal closes.
 *
 * Cannot be dismissed without a selection:
 *   - `showCloseButton={false}` removes the `X` close button.
 *   - `onEscapeKeyDown` / `onPointerDownOutside` are preventDefault'd so
 *     escape and overlay clicks do nothing.
 *   - `onOpenChange` is wired to a no-op when the user has no selection.
 *
 * Auto-mounted by `<Providers>` whenever
 *   `useCurrentUser().state === "needs-pick"`
 *   AND `useFeatureGate("1.76.0").supported === true`.
 */

import { Loader2, Plus, UserCircle2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useCreateUser, useUsers } from "@/api/hooks/use-users";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { useCurrentUser } from "@/contexts/current-user-context";
import { useConfig } from "@/hooks/use-config";

export function IdentityModal() {
  const { state, setUserId } = useCurrentUser();
  const { pendingIdentity, clearPendingIdentity } = useConfig();
  const usersQuery = useUsers();
  const createUser = useCreateUser();
  const [mode, setMode] = useState<"select" | "create">(pendingIdentity ? "create" : "select");
  const [selected, setSelected] = useState<string>("");
  const [newName, setNewName] = useState(pendingIdentity?.name ?? "");
  const [newEmail, setNewEmail] = useState(pendingIdentity?.email ?? "");
  const [submitError, setSubmitError] = useState<string | null>(null);

  const open = state === "needs-pick";
  const users = usersQuery.data ?? [];
  const isLoading = usersQuery.isLoading;

  // Default to "create" when there are no users yet — but do it in an effect
  // so we don't trigger setState during render.
  useEffect(() => {
    if (!isLoading && users.length === 0) {
      setMode((prev) => (prev === "select" ? "create" : prev));
    }
  }, [isLoading, users.length]);

  function handleSelectSubmit(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setUserId(selected);
    clearPendingIdentity();
  }

  async function handleCreateSubmit(e: FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setSubmitError(null);
    try {
      const user = await createUser.mutateAsync({
        name,
        ...(newEmail.trim().length > 0 && { email: newEmail.trim() }),
      });
      setUserId(user.id);
      clearPendingIdentity();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to create user");
    }
  }

  return (
    <Dialog
      open={open}
      // Block dismissal: the modal can only close once `setUserId` is called
      // (which flips state away from "needs-pick" and unmounts this open=false).
      onOpenChange={(next) => {
        if (!next) {
          // Ignore close attempts — they can only come from the X (which we
          // hide), escape (we preventDefault below), or overlay click (we
          // preventDefault below). This is a defense-in-depth no-op.
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Who are you?</DialogTitle>
          <DialogDescription>
            Pick the user this session belongs to. We'll attribute new tasks and chat sessions to
            them.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading users…
          </div>
        ) : mode === "select" ? (
          <form className="flex flex-col gap-4" onSubmit={handleSelectSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="identity-user">User</Label>
              <Select value={selected} onValueChange={setSelected}>
                <SelectTrigger id="identity-user">
                  <SelectValue placeholder="Pick a user…" />
                </SelectTrigger>
                <SelectContent>
                  {users.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      <span className="flex items-center gap-2">
                        <UserCircle2 className="h-3.5 w-3.5 text-muted-foreground" />
                        <span>{u.name}</span>
                        {u.email ? (
                          <span className="text-xs text-muted-foreground">— {u.email}</span>
                        ) : null}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-2 pt-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setMode("create");
                  setSubmitError(null);
                }}
              >
                <Plus className="h-3.5 w-3.5 mr-1" /> Create new
              </Button>
              <Button type="submit" disabled={!selected}>
                Continue
              </Button>
            </div>
          </form>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={handleCreateSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="identity-new-name">Name</Label>
              <Input
                id="identity-new-name"
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Ada Lovelace"
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="identity-new-email">Email (optional)</Label>
              <Input
                id="identity-new-email"
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="ada@example.com"
              />
            </div>
            {submitError ? <p className="text-xs text-status-error-strong">{submitError}</p> : null}
            <div className="flex items-center justify-between gap-2 pt-2">
              {users.length > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setMode("select");
                    setSubmitError(null);
                    clearPendingIdentity();
                  }}
                >
                  Back to list
                </Button>
              ) : (
                <span />
              )}
              <Button type="submit" disabled={!newName.trim() || createUser.isPending}>
                {createUser.isPending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Creating…
                  </>
                ) : (
                  "Create & continue"
                )}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
