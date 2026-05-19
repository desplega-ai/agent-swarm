import { ArrowDown, Check, ChevronsUpDown, GitMerge, Trash2, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useMergeUsers, useUsers } from "@/api/hooks/use-users";
import type { User } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { IdentityBadgeList } from "./identity-badges";

function userInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (name.slice(0, 2) || "?").toUpperCase();
}

/**
 * Three-step vertical merge flow.
 *
 *   1. Source — the account to be permanently deleted
 *   2. Target — the surviving account
 *   3. Preview — what moves where + final shape of the target
 *
 * The merge is irreversible: source `users` row + its `user_external_ids` and
 * `user_email_aliases` are deleted; on the target a `manual_merge` event is
 * recorded. We name that explicitly in the explainer and in the destructive
 * CTA label ("Merge & delete source") so the operator can't miss it.
 */
export function MergeModal({
  open,
  onOpenChange,
  initialTargetId,
  initialSourceId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTargetId?: string;
  initialSourceId?: string;
}) {
  const navigate = useNavigate();
  const { data: users } = useUsers({ recentEvents: 0 });
  const merge = useMergeUsers();

  const [sourceId, setSourceId] = useState<string | null>(initialSourceId ?? null);
  const [targetId, setTargetId] = useState<string | null>(initialTargetId ?? null);

  const userList = useMemo(() => users ?? [], [users]);

  const source = useMemo(
    () => userList.find((u) => u.id === sourceId) ?? null,
    [userList, sourceId],
  );
  const target = useMemo(
    () => userList.find((u) => u.id === targetId) ?? null,
    [userList, targetId],
  );

  const sameUser = !!sourceId && sourceId === targetId;
  const canSubmit = !!source && !!target && !sameUser && !merge.isPending;

  function reset() {
    setSourceId(initialSourceId ?? null);
    setTargetId(initialTargetId ?? null);
  }

  async function submit() {
    if (!source || !target || sameUser) return;
    try {
      const merged = await merge.mutateAsync({
        targetId: target.id,
        sourceUserId: source.id,
      });
      toast.success("Merged. Source user deleted. manual_merge event recorded.");
      onOpenChange(false);
      reset();
      navigate(`/people/${merged.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to merge users");
    }
  }

  // Preview math — what moves from source into target.
  const movingIdentities = source?.identities ?? [];
  const targetAliasLower = new Set((target?.emailAliases ?? []).map((a) => a.toLowerCase()));
  const targetPrimaryLower = (target?.email ?? "").toLowerCase();
  const candidateAliases = [
    ...(source?.email ? [source.email] : []),
    ...(source?.emailAliases ?? []),
  ];
  const movingAliases = candidateAliases.filter((alias) => {
    const lower = alias.toLowerCase();
    if (!lower || lower === targetPrimaryLower) return false;
    return !targetAliasLower.has(lower);
  });

  // Final shape on the target after merge.
  const finalIdentities = [
    ...(target?.identities ?? []),
    ...movingIdentities.filter(
      (mi) =>
        !(target?.identities ?? []).some(
          (ti) => ti.kind === mi.kind && ti.externalId === mi.externalId,
        ),
    ),
  ];
  const finalAliases = [...(target?.emailAliases ?? []), ...movingAliases];

  const stepDone = {
    source: !!source,
    target: !!target && !sameUser,
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="h-4 w-4" />
            Merge users
          </DialogTitle>
          <DialogDescription>
            Combines two accounts. The source is{" "}
            <span className="font-medium text-foreground">permanently deleted</span>; the target
            inherits its identities and email aliases.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 pt-1">
          {/* Step 1 — Source */}
          <Step
            number={1}
            title="Pick the account to delete"
            subtitle="This user will be permanently merged into another."
            done={stepDone.source}
          >
            <UserPicker
              value={sourceId}
              onChange={setSourceId}
              users={userList}
              excludeId={targetId}
              placeholder="Search users to delete…"
              accent="destructive"
            />
            {source && <SelectedUserCard user={source} variant="source" />}
          </Step>

          <div className="flex justify-center">
            <ArrowDown className="h-4 w-4 text-muted-foreground/60" />
          </div>

          {/* Step 2 — Target */}
          <Step
            number={2}
            title="Pick the surviving account"
            subtitle="Will inherit identities and email aliases from the source."
            done={stepDone.target}
            disabled={!source}
          >
            <UserPicker
              value={targetId}
              onChange={setTargetId}
              users={userList}
              excludeId={sourceId}
              placeholder="Search users to keep…"
              disabled={!source}
              accent="success"
            />
            {sameUser && (
              <p className="text-xs text-status-error-strong">
                Source and target must be different users.
              </p>
            )}
            {target && !sameUser && <SelectedUserCard user={target} variant="target" />}
          </Step>

          {/* Step 3 — Preview */}
          {source && target && !sameUser && (
            <>
              <div className="flex justify-center">
                <ArrowDown className="h-4 w-4 text-muted-foreground/60" />
              </div>
              <Step number={3} title="Confirm" subtitle="Review what will move and what stays.">
                <div className="rounded-md border border-border bg-muted/30 p-3 space-y-3">
                  <Explainer />

                  <div className="space-y-2">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Moving from <span className="font-mono normal-case">{source.name}</span> →{" "}
                      <span className="font-mono normal-case">{target.name}</span>
                    </div>
                    {movingIdentities.length === 0 && movingAliases.length === 0 ? (
                      <p className="text-xs italic text-muted-foreground">
                        Nothing to move — source has no identities or new email aliases.
                      </p>
                    ) : (
                      <div className="space-y-1.5">
                        {movingIdentities.length > 0 && (
                          <div className="flex flex-wrap items-baseline gap-1.5">
                            <span className="text-[10px] uppercase text-muted-foreground min-w-[80px]">
                              Identities
                            </span>
                            <IdentityBadgeList identities={movingIdentities} showId />
                          </div>
                        )}
                        {movingAliases.length > 0 && (
                          <div className="flex flex-wrap items-baseline gap-1.5">
                            <span className="text-[10px] uppercase text-muted-foreground min-w-[80px]">
                              Email aliases
                            </span>
                            {movingAliases.map((a) => (
                              <Badge
                                key={a}
                                variant="outline"
                                size="tag"
                                className="font-mono normal-case"
                              >
                                {a}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="border-t border-border/70 pt-3 space-y-2">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Target after merge — {target.name}
                    </div>
                    <div className="space-y-1.5">
                      <div className="text-xs text-muted-foreground">
                        Primary email:{" "}
                        <span className="font-mono text-foreground">
                          {target.email ?? (
                            <span className="italic text-muted-foreground">none</span>
                          )}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-baseline gap-1.5">
                        <span className="text-[10px] uppercase text-muted-foreground min-w-[80px]">
                          Identities ({finalIdentities.length})
                        </span>
                        <IdentityBadgeList identities={finalIdentities} />
                      </div>
                      {finalAliases.length > 0 && (
                        <div className="flex flex-wrap items-baseline gap-1.5">
                          <span className="text-[10px] uppercase text-muted-foreground min-w-[80px]">
                            Aliases ({finalAliases.length})
                          </span>
                          {finalAliases.map((a) => (
                            <Badge
                              key={a}
                              variant="outline"
                              size="tag"
                              className="font-mono normal-case"
                            >
                              {a}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </Step>
            </>
          )}
        </div>

        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={submit} disabled={!canSubmit}>
            <Trash2 className="h-3.5 w-3.5" />
            {merge.isPending ? "Merging…" : "Merge & delete source"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----------------------------- Step shell ------------------------------ */

function Step({
  number,
  title,
  subtitle,
  done,
  disabled = false,
  children,
}: {
  number: number;
  title: string;
  subtitle?: string;
  done?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={cn("space-y-2", disabled && "opacity-50 pointer-events-none")}>
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold",
            done
              ? "border-status-success/40 bg-status-success/10 text-status-success-strong"
              : "border-border bg-muted text-muted-foreground",
          )}
        >
          {done ? <Check className="h-3 w-3" /> : number}
        </div>
        <div className="space-y-0.5 flex-1">
          <h3 className="text-sm font-semibold leading-tight">{title}</h3>
          {subtitle && <p className="text-xs text-muted-foreground leading-snug">{subtitle}</p>}
        </div>
      </div>
      <div className="pl-8 space-y-2">{children}</div>
    </section>
  );
}

/* ---------------------------- Rich user picker ------------------------- */

function UserPicker({
  value,
  onChange,
  users,
  excludeId,
  placeholder,
  disabled = false,
  accent = "default",
}: {
  value: string | null;
  onChange: (id: string) => void;
  users: User[];
  excludeId: string | null;
  placeholder: string;
  disabled?: boolean;
  accent?: "default" | "destructive" | "success";
}) {
  const [open, setOpen] = useState(false);
  const selected = users.find((u) => u.id === value) ?? null;

  const accentRing =
    accent === "destructive"
      ? "data-[state=selected]:border-status-error/40"
      : accent === "success"
        ? "data-[state=selected]:border-status-success/40"
        : "";

  return (
    <Popover open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          disabled={disabled}
          data-state={selected ? "selected" : "empty"}
          className={cn(
            "w-full justify-between h-auto py-2 px-2.5 font-normal",
            selected ? "border-foreground/20" : "border-border",
            accentRing,
            !selected &&
              (accent === "destructive"
                ? "hover:border-status-error/30"
                : accent === "success"
                  ? "hover:border-status-success/30"
                  : ""),
          )}
        >
          {selected ? (
            <UserRow user={selected} compact />
          ) : (
            <span className="text-muted-foreground text-sm">{placeholder}</span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search by name or email…" />
          <CommandList>
            <CommandEmpty>No users found.</CommandEmpty>
            <CommandGroup>
              {users
                .filter((u) => u.id !== excludeId)
                .map((u) => (
                  <CommandItem
                    key={u.id}
                    value={`${u.name} ${u.email ?? ""}`}
                    onSelect={() => {
                      onChange(u.id);
                      setOpen(false);
                    }}
                    className="py-2"
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4 shrink-0",
                        value === u.id ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <UserRow user={u} compact />
                  </CommandItem>
                ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function UserRow({ user, compact = false }: { user: User; compact?: boolean }) {
  const idCount = user.identities?.length ?? 0;
  return (
    <div className="flex items-center gap-2.5 min-w-0 flex-1 text-left">
      <div
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full bg-muted text-foreground/80 font-semibold",
          compact ? "h-7 w-7 text-[10px]" : "h-8 w-8 text-xs",
        )}
      >
        {userInitials(user.name)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium leading-tight truncate">{user.name}</div>
        <div className="flex items-center gap-1.5 text-[11px] leading-tight text-muted-foreground">
          <span className="truncate font-mono">{user.email ?? "no email"}</span>
          <span className="text-border">·</span>
          <span className="shrink-0">
            {idCount} {idCount === 1 ? "identity" : "identities"}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------ Selected-user inline card -------------------- */

function SelectedUserCard({ user, variant }: { user: User; variant: "source" | "target" }) {
  const isSource = variant === "source";
  return (
    <div
      className={cn(
        "rounded-md border-l-2 bg-muted/30 px-3 py-2",
        isSource
          ? "border-l-status-error/60 bg-status-error/5"
          : "border-l-status-success/60 bg-status-success/5",
      )}
    >
      <div className="flex items-center justify-between gap-3 mb-1.5">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide font-semibold">
          {isSource ? (
            <>
              <Trash2 className="h-3 w-3 text-status-error-strong" />
              <span className="text-status-error-strong">Will be deleted</span>
            </>
          ) : (
            <>
              <Check className="h-3 w-3 text-status-success-strong" />
              <span className="text-status-success-strong">Will survive</span>
            </>
          )}
        </div>
        <span className="text-[10px] font-mono text-muted-foreground truncate">{user.id}</span>
      </div>
      <IdentityBadgeList identities={user.identities} />
    </div>
  );
}

/* ----------------------------- Explainer ------------------------------- */

function Explainer() {
  return (
    <div className="flex items-start gap-2 rounded-md border border-status-warning/30 bg-status-warning/5 p-2.5">
      <TriangleAlert className="h-4 w-4 shrink-0 text-status-warning-strong mt-0.5" />
      <div className="space-y-1 text-xs leading-relaxed text-foreground/90">
        <div className="font-semibold text-foreground">This is irreversible.</div>
        <ul className="space-y-0.5 text-foreground/80">
          <li>
            <span className="font-medium text-foreground">Identities</span> on the source (Slack,
            GitHub, etc.) are re-pointed to the target.
          </li>
          <li>
            <span className="font-medium text-foreground">Source email + aliases</span> become
            aliases on the target.
          </li>
          <li>
            The source user row is{" "}
            <span className="font-medium text-foreground">permanently deleted</span>.
          </li>
          <li>
            A <span className="font-mono">manual_merge</span> event lands on the target's timeline.
          </li>
        </ul>
      </div>
    </div>
  );
}
