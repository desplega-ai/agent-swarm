import { ArrowRight, GitMerge } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useMergeUsers, useUsers } from "@/api/hooks/use-users";
import type { User } from "@/api/types";
import { Combobox } from "@/components/shared/combobox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { IdentityBadgeList } from "./identity-badges";

function userLabel(u: User): string {
  if (u.email) return `${u.name} · ${u.email}`;
  return u.name;
}

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

  const [targetId, setTargetId] = useState<string | null>(initialTargetId ?? null);
  const [sourceId, setSourceId] = useState<string | null>(initialSourceId ?? null);

  const options = useMemo(
    () => (users ?? []).map((u) => ({ value: u.id, label: userLabel(u) })),
    [users],
  );

  const target = useMemo(
    () => (users ?? []).find((u) => u.id === targetId) ?? null,
    [users, targetId],
  );
  const source = useMemo(
    () => (users ?? []).find((u) => u.id === sourceId) ?? null,
    [users, sourceId],
  );

  const sameUser = !!targetId && targetId === sourceId;
  const canSubmit = !!target && !!source && !sameUser && !merge.isPending;

  function reset() {
    setTargetId(initialTargetId ?? null);
    setSourceId(initialSourceId ?? null);
  }

  async function submit() {
    if (!target || !source || sameUser) return;
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

  // Preview — what moves from source into target.
  const movingIdentities = source?.identities ?? [];
  const targetAliases = new Set((target?.emailAliases ?? []).map((a) => a.toLowerCase()));
  const targetPrimaryLower = (target?.email ?? "").toLowerCase();
  const candidateAliases = [
    ...(source?.email ? [source.email] : []),
    ...(source?.emailAliases ?? []),
  ];
  const movingAliases = candidateAliases.filter((alias) => {
    const lower = alias.toLowerCase();
    if (!lower || lower === targetPrimaryLower) return false;
    return ![...targetAliases].some((a) => a === lower);
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="h-4 w-4" />
            Merge users
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
            <div className="space-y-1.5">
              <Label>Source (will be deleted)</Label>
              <Combobox
                options={options}
                value={sourceId}
                onChange={(v) => setSourceId(v)}
                placeholder="Pick source…"
                searchPlaceholder="Search by name or email…"
              />
            </div>
            <ArrowRight className="hidden h-4 w-4 text-muted-foreground self-center sm:block" />
            <div className="space-y-1.5">
              <Label>Target (survives)</Label>
              <Combobox
                options={options}
                value={targetId}
                onChange={(v) => setTargetId(v)}
                placeholder="Pick target…"
                searchPlaceholder="Search by name or email…"
              />
            </div>
          </div>

          {sameUser && (
            <p className="text-xs text-status-error-strong">
              Source and target must be different users.
            </p>
          )}

          {target && source && !sameUser && (
            <div className="rounded-md border border-border bg-muted/30 p-3 space-y-3">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Preview
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-muted-foreground">Source — DELETED</div>
                  <div className="text-sm">{userLabel(source)}</div>
                  <IdentityBadgeList identities={source.identities} />
                </div>
                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-muted-foreground">Target — SURVIVES</div>
                  <div className="text-sm">{userLabel(target)}</div>
                  <IdentityBadgeList identities={target.identities} />
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium">Will move into target:</div>
                {movingIdentities.length === 0 && movingAliases.length === 0 ? (
                  <p className="text-xs italic text-muted-foreground">
                    Nothing — source has no identities or new email aliases.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {movingIdentities.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[10px] uppercase text-muted-foreground">
                          Identities
                        </span>
                        <IdentityBadgeList identities={movingIdentities} />
                      </div>
                    )}
                    {movingAliases.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[10px] uppercase text-muted-foreground">
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
              <p className="text-[11px] text-muted-foreground">
                A <span className="font-mono">manual_merge</span> event will be recorded on the
                target user's timeline.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {merge.isPending ? "Merging…" : "Merge users"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
