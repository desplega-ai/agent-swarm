/**
 * Sidebar-footer user switcher — surfaces the current identity at the bottom
 * of the app sidebar (always visible, single click to change). Replaces the
 * "you must pick one" modal as a discovery point: users see who they're
 * acting as, and switch / create a new identity from a dropdown.
 *
 * The non-dismissible <IdentityModal> is still mounted at app root so
 * brand-new connections still get forced through identity selection
 * before they can act. This switcher is for switching afterwards.
 */

import { Check, ChevronsUpDown, Plus, UserPlus } from "lucide-react";
import { useState } from "react";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useCreateUser, useUsers } from "@/api/hooks/use-users";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { useCurrentUser } from "@/contexts/current-user-context";
import { cn } from "@/lib/utils";

function userInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (name.slice(0, 2) || "?").toUpperCase();
}

export function UserSwitcher() {
  const gate = useFeatureGate("1.76.0");
  const { user, userId, setUserId, clearUser } = useCurrentUser();
  const { data: users } = useUsers();
  const createUser = useCreateUser();
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");

  // Older API servers (no /api/users) — hide entirely.
  if (!gate.supported) return null;

  const handleCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const created = await createUser.mutateAsync({
      name: trimmed,
      email: newEmail.trim() || undefined,
    });
    setUserId(created.id);
    setCreateOpen(false);
    setNewName("");
    setNewEmail("");
  };

  const initials = user ? userInitials(user.name) : "?";

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                tooltip={user ? `Acting as ${user.name}` : "Pick identity"}
                aria-label={user ? `Acting as ${user.name} — click to switch` : "Pick identity"}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "inline-flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-semibold shadow-sm",
                    user ? "bg-primary text-primary-foreground" : "bg-primary/20 text-primary",
                  )}
                >
                  {user ? initials : <UserPlus className="size-3.5" />}
                </span>
                <span
                  className={cn(
                    "grid flex-1 text-left text-sm leading-tight",
                    user ? "text-foreground" : "text-primary",
                  )}
                >
                  <span className="truncate font-medium">{user ? user.name : "Pick identity"}</span>
                </span>
                <ChevronsUpDown className="ml-auto size-4 shrink-0 opacity-60" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="w-60">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
                Acting as
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {users && users.length > 0 ? (
                users.map((u) => (
                  <DropdownMenuItem
                    key={u.id}
                    onClick={() => setUserId(u.id)}
                    className="flex items-center gap-2"
                  >
                    <span
                      aria-hidden="true"
                      className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted font-mono text-[9px] font-semibold text-muted-foreground shrink-0"
                    >
                      {userInitials(u.name)}
                    </span>
                    <span className="flex-1 truncate">{u.name}</span>
                    {u.id === userId ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
                  </DropdownMenuItem>
                ))
              ) : (
                <div className="px-2 py-3 text-xs text-muted-foreground italic">
                  No users yet — create the first one below.
                </div>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setCreateOpen(true)}
                className="flex items-center gap-2"
              >
                <Plus className="h-3.5 w-3.5" />
                Create new user…
              </DropdownMenuItem>
              {userId ? (
                <DropdownMenuItem
                  onClick={() => clearUser()}
                  className="text-muted-foreground text-xs"
                >
                  Clear identity
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Create user</DialogTitle>
            <DialogDescription>
              Tasks you send will be attributed to this user across all sessions.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleCreate();
            }}
            className="flex flex-col gap-3 py-2"
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-user-name" className="text-xs">
                Name
              </Label>
              <Input
                id="new-user-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Taras"
                autoFocus
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-user-email" className="text-xs">
                Email (optional)
              </Label>
              <Input
                id="new-user-email"
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="taras@example.com"
              />
            </div>
            {createUser.isError ? (
              <p className="text-xs text-status-error-strong">
                {createUser.error instanceof Error
                  ? createUser.error.message
                  : "Failed to create user"}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setCreateOpen(false)}
                disabled={createUser.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createUser.isPending || newName.trim().length === 0}>
                {createUser.isPending ? "Creating…" : "Create & switch"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
