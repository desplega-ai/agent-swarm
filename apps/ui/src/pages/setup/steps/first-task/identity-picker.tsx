import { Loader2, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useCreateUser, useUsers } from "@/api/hooks/use-users";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsRow } from "@/components/ui/settings-row";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useConfig } from "@/hooks/use-config";

/**
 * Inline version of `components/identity/identity-modal.tsx`: pick an existing
 * user or create one, then bind it to this tab. The modal is suppressed on
 * `/setup`, so step 6 asks here instead.
 */
export function IdentityPicker() {
  const { setUserId } = useCurrentUser();
  const { pendingIdentity, clearPendingIdentity } = useConfig();
  const usersQ = useUsers();
  const createUser = useCreateUser();
  const users = usersQ.data ?? [];
  const [mode, setMode] = useState<"select" | "create">(pendingIdentity ? "create" : "select");
  const [selected, setSelected] = useState("");
  const [name, setName] = useState(pendingIdentity?.name ?? "");
  const [email, setEmail] = useState(pendingIdentity?.email ?? "");
  const [error, setError] = useState<string | null>(null);
  const creating = mode === "create" || users.length === 0;

  function pick(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setUserId(selected);
    clearPendingIdentity();
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    try {
      const user = await createUser.mutateAsync({
        name: trimmed,
        ...(email.trim() ? { email: email.trim() } : {}),
      });
      setUserId(user.id);
      clearPendingIdentity();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create the user.");
    }
  }

  if (usersQ.isLoading) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Loading users
      </p>
    );
  }

  return (
    <div className="space-y-3 rounded-md border border-border-subtle bg-surface p-3">
      <p className="text-sm">Who is sending this? The swarm attributes tasks to this user.</p>
      {creating ? (
        <form className="space-y-3" onSubmit={create}>
          <div className="grid gap-3 sm:grid-cols-2">
            <SettingsRow label="Name" htmlFor="setup-identity-name" required>
              <Input
                id="setup-identity-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ada Lovelace"
              />
            </SettingsRow>
            <SettingsRow label="Email (optional)" htmlFor="setup-identity-email">
              <Input
                id="setup-identity-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ada@example.com"
              />
            </SettingsRow>
          </div>
          {error ? <p className="text-xs text-status-error-strong">{error}</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={!name.trim() || createUser.isPending}>
              {createUser.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Create user
            </Button>
            {users.length > 0 ? (
              <Button type="button" variant="ghost" onClick={() => setMode("select")}>
                Pick an existing user
              </Button>
            ) : null}
          </div>
        </form>
      ) : (
        <form className="flex flex-wrap items-end gap-2" onSubmit={pick}>
          <SettingsRow label="User" htmlFor="setup-identity-user" className="min-w-48 flex-1">
            <Select value={selected} onValueChange={setSelected}>
              <SelectTrigger id="setup-identity-user" className="w-full">
                <SelectValue placeholder="Pick a user" />
              </SelectTrigger>
              <SelectContent>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    <span className="flex items-center gap-2">
                      <span>{u.name}</span>
                      {u.email ? (
                        <span className="text-xs text-muted-foreground">{u.email}</span>
                      ) : null}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
          <Button type="submit" disabled={!selected}>
            Use this user
          </Button>
          <Button type="button" variant="ghost" onClick={() => setMode("create")}>
            <Plus className="size-4" />
            Create new
          </Button>
        </form>
      )}
    </div>
  );
}
