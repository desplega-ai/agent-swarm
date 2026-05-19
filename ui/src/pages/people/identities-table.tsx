import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useAddUserIdentity, useRemoveUserIdentity, useUpdateUser } from "@/api/hooks/use-users";
import type { User, UserIdentity } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRelative } from "@/lib/relative-time";
import { getIntegrationLabel, IntegrationIcon } from "./integration-icons";

const KIND_OPTIONS = ["slack", "linear", "github", "gitlab", "jira", "agentmail", "custom"];

type RowKind = "identity" | "alias";

interface IdentityRow {
  /** Stable row id for AG Grid (`<rowKind>:<kind>:<externalId>`). */
  id: string;
  rowKind: RowKind;
  kind: string;
  externalId: string;
  /** Optional display name (alias has none; identity may have one in metadata). */
  displayName?: string;
  /** Backing identity reference (only present for `rowKind === "identity"`). */
  identity?: UserIdentity;
  /** ISO timestamp used for "Linked at". */
  linkedAt: string;
}

/**
 * Compose rows for the identities table:
 *   - One row per linked identity (kind / externalId / linkedAt)
 *   - One row per email alias (kind = "email-alias")
 *
 * Pre-sorted: identities first (alphabetised by provider label), then aliases.
 * AG Grid's column sort overrides this when the user clicks a header — see
 * the Provider column's custom comparator below for the "aliases sort to the
 * bottom regardless of direction" behaviour.
 *
 * The wire shape for `UserIdentity` doesn't carry a per-identity timestamp or
 * displayName yet, so we honestly surface the user's `lastUpdatedAt` for both
 * (matches the same compromise documented in the redesign plan).
 */
function composeRows(user: User): IdentityRow[] {
  const linkedAt = user.lastUpdatedAt;
  const idRows: IdentityRow[] = (user.identities ?? []).map((i) => ({
    id: `identity:${i.kind}:${i.externalId}`,
    rowKind: "identity" as const,
    kind: i.kind,
    externalId: i.externalId,
    identity: i,
    linkedAt,
  }));
  idRows.sort((a, b) => {
    const la = getIntegrationLabel(a.kind);
    const lb = getIntegrationLabel(b.kind);
    if (la !== lb) return la.localeCompare(lb);
    return a.externalId.localeCompare(b.externalId);
  });
  const aliasRows: IdentityRow[] = (user.emailAliases ?? [])
    .map((alias) => ({
      id: `alias:email-alias:${alias}`,
      rowKind: "alias" as const,
      kind: "email-alias",
      externalId: alias,
      linkedAt,
    }))
    .sort((a, b) => a.externalId.localeCompare(b.externalId));
  return [...idRows, ...aliasRows];
}

function copyText(text: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast.success("Copied"),
    () => toast.error("Copy failed"),
  );
}

/* ── Cell renderers ─────────────────────────────────────────────────────── */

function ProviderCell({ row }: { row: IdentityRow }) {
  return (
    <span className="inline-flex items-center gap-2">
      <IntegrationIcon kind={row.kind} className="h-5 w-5 text-foreground/80" />
      <span className="font-medium text-sm">{getIntegrationLabel(row.kind)}</span>
      {row.rowKind === "alias" && (
        <Badge variant="outline" size="tag" className="ml-1 normal-case">
          Alias
        </Badge>
      )}
    </span>
  );
}

function ExternalIdCell({ value }: { value: string }) {
  return (
    <button
      type="button"
      className="group inline-flex items-center gap-1.5 font-mono text-xs hover:text-foreground text-foreground/80"
      onClick={() => copyText(value)}
      title="Click to copy"
    >
      <span className="truncate max-w-[28ch]">{value}</span>
      <Copy className="h-3 w-3 opacity-0 group-hover:opacity-60 shrink-0" />
    </button>
  );
}

function DisplayNameCell({ value }: { value: string | undefined }) {
  return (
    <span className="text-xs text-muted-foreground">
      {value ?? <span className="text-muted-foreground/50">—</span>}
    </span>
  );
}

function LinkedAtCell({ value }: { value: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="text-xs text-muted-foreground">{formatRelative(value)}</span>
      </TooltipTrigger>
      <TooltipContent className="font-mono text-[10px]">{value}</TooltipContent>
    </Tooltip>
  );
}

/* ── Edit popover ───────────────────────────────────────────────────────── */

/**
 * Inline edit form rendered inside the row's actions popover. UI-only
 * composite — there's no PATCH for a specific (kind, externalId) tuple, so
 * `Save` boils down to POST-new then DELETE-old (for identities) or PATCH
 * the user with the updated `emailAliases` array (for aliases). The user
 * sees a single Save click.
 */
function IdentityEditPopover({
  user,
  row,
  open,
  onOpenChange,
  trigger,
}: {
  user: User;
  row: IdentityRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: React.ReactNode;
}) {
  const addIdent = useAddUserIdentity();
  const removeIdent = useRemoveUserIdentity();
  const updateUser = useUpdateUser();

  const [draftId, setDraftId] = useState(row.externalId);

  // Re-seed when a different row's popover opens.
  useEffect(() => {
    if (open) setDraftId(row.externalId);
  }, [open, row.externalId]);

  const trimmed = draftId.trim();
  const dirty = trimmed !== row.externalId;
  const valid = trimmed.length > 0;
  const pending = addIdent.isPending || removeIdent.isPending || updateUser.isPending;

  async function save() {
    if (!dirty || !valid) return;
    try {
      if (row.rowKind === "alias") {
        // Replace the old alias with the new value, preserve every other
        // alias (case-insensitive de-dupe so we don't introduce a clash).
        const others = (user.emailAliases ?? []).filter((a) => a !== row.externalId);
        if (others.some((a) => a.toLowerCase() === trimmed.toLowerCase())) {
          toast.error("That alias already exists on this user");
          return;
        }
        await updateUser.mutateAsync({
          id: user.id,
          data: { emailAliases: [...others, trimmed] },
        });
        toast.success("Alias updated");
      } else {
        // Same-kind external-id change: link the new one first so the user
        // never ends up identity-less in case of failure, then remove the
        // old. The server enforces uniqueness — if (kind, new) clashes,
        // the POST throws and we abort before deleting.
        await addIdent.mutateAsync({
          id: user.id,
          identity: { kind: row.kind, externalId: trimmed },
        });
        try {
          await removeIdent.mutateAsync({
            id: user.id,
            kind: row.kind,
            externalId: row.externalId,
          });
        } catch (innerErr) {
          // Best-effort recovery — roll back the just-added identity.
          await removeIdent
            .mutateAsync({ id: user.id, kind: row.kind, externalId: trimmed })
            .catch(() => {});
          throw innerErr;
        }
        toast.success("Identity updated");
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    }
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" className="w-[320px] p-3 space-y-3">
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {row.rowKind === "alias" ? "Edit alias" : "Edit identity"}
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            <IntegrationIcon kind={row.kind} className="h-3.5 w-3.5 text-foreground/70" />
            <span className="font-medium">{getIntegrationLabel(row.kind)}</span>
            <span className="text-muted-foreground/60">·</span>
            <span className="font-mono text-[10px] text-muted-foreground truncate">
              {row.externalId}
            </span>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label
            htmlFor={`edit-ident-${row.id}`}
            className="text-[10px] uppercase tracking-wider text-muted-foreground"
          >
            {row.rowKind === "alias" ? "New email" : "New external ID"}
          </Label>
          <Input
            id={`edit-ident-${row.id}`}
            autoFocus
            value={draftId}
            onChange={(e) => setDraftId(e.target.value)}
            className="h-9 font-mono text-xs"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void save();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                onOpenChange(false);
              }
            }}
          />
          <p className="text-[10px] text-muted-foreground/80">
            Saved as a single change. {row.rowKind === "alias" ? "Alias" : "Identity"} routing
            switches once this completes.
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={!dirty || !valid || pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ── Table ──────────────────────────────────────────────────────────────── */

export function IdentitiesTable({ user }: { user: User }) {
  const addIdent = useAddUserIdentity();
  const removeIdent = useRemoveUserIdentity();
  const updateUser = useUpdateUser();

  const [addOpen, setAddOpen] = useState(false);
  const [draftKind, setDraftKind] = useState("slack");
  const [draftId, setDraftId] = useState("");

  const [pendingDelete, setPendingDelete] = useState<IdentityRow | null>(null);
  const [editingRowId, setEditingRowId] = useState<string | null>(null);

  const rows = useMemo(() => composeRows(user), [user]);

  async function add() {
    const id = draftId.trim();
    if (!id) return;
    try {
      await addIdent.mutateAsync({ id: user.id, identity: { kind: draftKind, externalId: id } });
      toast.success(`Linked ${getIntegrationLabel(draftKind)}: ${id}`);
      setDraftId("");
      setAddOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to link identity");
    }
  }

  async function confirmDelete() {
    const row = pendingDelete;
    if (!row) return;
    try {
      if (row.rowKind === "alias") {
        const next = (user.emailAliases ?? []).filter((a) => a !== row.externalId);
        await updateUser.mutateAsync({ id: user.id, data: { emailAliases: next } });
        toast.success("Alias removed");
      } else {
        await removeIdent.mutateAsync({
          id: user.id,
          kind: row.kind,
          externalId: row.externalId,
        });
        toast.success("Identity removed");
      }
      setPendingDelete(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove");
    }
  }

  const columnDefs = useMemo<ColDef<IdentityRow>[]>(() => {
    const fixed = { suppressSizeToFit: true } as const;
    return [
      {
        headerName: "Provider",
        field: "kind",
        width: 200,
        ...fixed,
        // Custom comparator: sort by integration label (not raw kind) so
        // "Slack" < "Linear" follows the visible label, and aliases sort to
        // the bottom regardless of direction.
        comparator: (_a, _b, nodeA, nodeB) => {
          const a = nodeA.data;
          const b = nodeB.data;
          if (!a || !b) return 0;
          if (a.rowKind !== b.rowKind) return a.rowKind === "alias" ? 1 : -1;
          return getIntegrationLabel(a.kind).localeCompare(getIntegrationLabel(b.kind));
        },
        cellRenderer: (p: ICellRendererParams<IdentityRow>) =>
          p.data ? <ProviderCell row={p.data} /> : null,
      },
      {
        headerName: "External ID",
        field: "externalId",
        flex: 1,
        minWidth: 200,
        cellRenderer: (p: ICellRendererParams<IdentityRow>) =>
          p.data ? <ExternalIdCell value={p.data.externalId} /> : null,
      },
      {
        headerName: "Display name",
        field: "displayName",
        width: 160,
        ...fixed,
        sortable: false,
        cellRenderer: (p: ICellRendererParams<IdentityRow>) => (
          <DisplayNameCell value={p.data?.displayName} />
        ),
      },
      {
        headerName: "Linked at",
        field: "linkedAt",
        width: 140,
        ...fixed,
        cellRenderer: (p: ICellRendererParams<IdentityRow>) =>
          p.data ? <LinkedAtCell value={p.data.linkedAt} /> : null,
      },
      {
        headerName: "",
        colId: "actions",
        width: 88,
        ...fixed,
        sortable: false,
        cellClass: "ag-right-aligned-cell",
        headerClass: "ag-right-aligned-header",
        cellRenderer: (p: ICellRendererParams<IdentityRow>) => {
          if (!p.data) return null;
          const row = p.data;
          return (
            <div className="inline-flex items-center gap-1 justify-end w-full">
              <IdentityEditPopover
                user={user}
                row={row}
                open={editingRowId === row.id}
                onOpenChange={(o) => setEditingRowId(o ? row.id : null)}
                trigger={
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={(e) => e.stopPropagation()}
                    aria-label={row.rowKind === "alias" ? "Edit alias" : "Edit identity"}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                }
              />
              <Button
                size="icon"
                variant="destructive-outline"
                className="h-7 w-7"
                onClick={(e) => {
                  e.stopPropagation();
                  setPendingDelete(row);
                }}
                aria-label={row.rowKind === "alias" ? "Remove alias" : "Remove identity"}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          );
        },
      },
    ];
  }, [user, editingRowId]);

  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-6 text-center space-y-3">
        <p className="text-sm text-muted-foreground">No identities or email aliases linked yet.</p>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add identity
        </Button>
        <AddIdentityDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          draftKind={draftKind}
          setDraftKind={setDraftKind}
          draftId={draftId}
          setDraftId={setDraftId}
          onSubmit={add}
          pending={addIdent.isPending}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {rows.length} {rows.length === 1 ? "entry" : "entries"} — {user.identities?.length ?? 0}{" "}
          platform {(user.identities?.length ?? 0) === 1 ? "identity" : "identities"},{" "}
          {user.emailAliases?.length ?? 0} email{" "}
          {(user.emailAliases?.length ?? 0) === 1 ? "alias" : "aliases"}.
        </div>
        <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add identity
        </Button>
      </div>

      <DataGrid
        rowData={rows}
        columnDefs={columnDefs}
        domLayout="autoHeight"
        pagination={false}
        emptyMessage="No identities or aliases linked."
        getRowId={(p) => p.data.id}
      />

      <AddIdentityDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        draftKind={draftKind}
        setDraftKind={setDraftKind}
        draftId={draftId}
        setDraftId={setDraftId}
        onSubmit={add}
        pending={addIdent.isPending}
      />

      <AlertDialog open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {pendingDelete?.rowKind === "alias" ? "email alias" : "identity"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.rowKind === "alias" ? (
                <>
                  Remove <span className="font-mono">{pendingDelete.externalId}</span> from this
                  user's email aliases? They'll no longer auto-resolve to this account.
                </>
              ) : (
                <>
                  Unlink <span className="font-mono">{pendingDelete?.externalId}</span> from{" "}
                  <span className="font-medium">
                    {getIntegrationLabel(pendingDelete?.kind ?? "")}
                  </span>
                  ? Future events from this identity will land in the Unmapped queue.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AddIdentityDialog({
  open,
  onOpenChange,
  draftKind,
  setDraftKind,
  draftId,
  setDraftId,
  onSubmit,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draftKind: string;
  setDraftKind: (kind: string) => void;
  draftId: string;
  setDraftId: (id: string) => void;
  onSubmit: () => void;
  pending: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add identity</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label>Provider</Label>
            <Select value={draftKind} onValueChange={setDraftKind}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KIND_OPTIONS.map((k) => (
                  <SelectItem key={k} value={k}>
                    <div className="flex items-center gap-2">
                      <IntegrationIcon kind={k} className="h-4 w-4 text-foreground/80" />
                      <span>{getIntegrationLabel(k)}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ident-external-id">External ID</Label>
            <Input
              id="ident-external-id"
              value={draftId}
              onChange={(e) => setDraftId(e.target.value)}
              placeholder="U12345…"
              className="font-mono"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onSubmit();
                }
              }}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={!draftId.trim() || pending}>
            {pending ? "Linking…" : "Link identity"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
