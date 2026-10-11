import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { AlertCircle, KeyRound, Plus, Server, Trash2, Undo2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  useCreateRuntimeController,
  useDeleteRuntimeController,
  useRuntimeControllers,
  useUpdateRuntimeController,
} from "@/api/hooks/use-runtime-pools";
import type { RuntimeController, RuntimeProviderKind } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { EmptyState } from "@/components/shared/empty-state";
import {
  duplicateKeys,
  KeyValueEditor,
  type KeyValueRow,
  recordFromRows,
  rowsFromRecord,
} from "@/components/shared/key-value-editor";
import { MobileList } from "@/components/shared/mobile-list";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { StatusBadge } from "@/components/shared/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCallout } from "@/components/ui/alert-callout";
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsRow } from "@/components/ui/settings-row";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { formatRelative } from "@/lib/relative-time";
import {
  COMING_SOON_KINDS,
  CONTROLLER_STATUS_BADGE,
  RUNTIME_KIND_LABEL,
  RUNTIME_PROVIDER_KINDS,
} from "@/lib/runtime-pools";
import { RuntimeControllerTokenDialog } from "./runtime-controller-token-dialog";
import { errorProps, FieldError } from "./runtime-pool-fields";
import { RuntimePoolsGuard, RuntimePoolsTabs } from "./runtime-pools-shared";

type Placement = RuntimeController["placement"];

function placementLabel(placement: Placement): string {
  return placement === "builtin" ? "Built in" : "Remote";
}

/** `StatusBadge` where a state fits; `unknown` has no equivalent and stays a neutral tag. */
function StatusChip({ controller }: { controller: RuntimeController }) {
  const status = CONTROLLER_STATUS_BADGE[controller.status];
  if (status) return <StatusBadge status={status} />;
  return (
    <Badge variant="outline" size="tag" className="text-status-neutral-strong">
      Unknown
    </Badge>
  );
}

/**
 * Secret rows to the write-only `secretConfig` patch. A blank value keeps a
 * stored key and is invalid for a new key. Only an explicit Remove sends `null`.
 */
function secretPatch(
  rows: KeyValueRow[],
  stored: string[],
  removed: string[],
): { patch: Record<string, string | null>; error: string | null } {
  const patch: Record<string, string | null> = {};
  const missingValue: string[] = [];
  let missingKey = false;
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) {
      if (row.value) missingKey = true;
      continue;
    }
    if (row.value) patch[key] = row.value;
    else if (!stored.includes(key)) missingValue.push(key);
  }
  for (const key of removed) if (!(key in patch)) patch[key] = null;
  const duplicates = duplicateKeys(rows);
  const error = missingKey
    ? "Enter a key for every secret value."
    : missingValue.length > 0
      ? `Enter a value for ${missingValue.join(", ")}, or remove the row.`
      : duplicates.length > 0
        ? `Duplicate keys: ${duplicates.join(", ")}.`
        : null;
  return { patch, error };
}

function SecretKeyChips({ controller }: { controller: RuntimeController }) {
  if (controller.secretConfigError) {
    return (
      <Badge
        variant="outline"
        size="tag"
        className="border-status-error/30 text-status-error-strong"
      >
        Unreadable
      </Badge>
    );
  }
  if (controller.secretConfigKeys.length === 0) {
    return <span className="text-xs text-muted-foreground">None</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {controller.secretConfigKeys.map((key) => (
        <Badge key={key} variant="outline" size="tag" className="font-mono normal-case">
          {key}
        </Badge>
      ))}
    </span>
  );
}

/**
 * Create or edit one controller. Secret values are write-only: stored keys
 * show by name, and a value typed here replaces the stored one.
 */
function ControllerDialog({
  controller,
  open,
  onOpenChange,
  onMintToken,
}: {
  controller: RuntimeController | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Set for a saved remote controller. Opens the token dialog. */
  onMintToken?: () => void;
}) {
  const create = useCreateRuntimeController();
  const update = useUpdateRuntimeController();
  const [name, setName] = useState(controller?.name ?? "");
  const [kind, setKind] = useState<RuntimeProviderKind>(controller?.kind ?? "docker");
  const [placement, setPlacement] = useState<Placement>(controller?.placement ?? "remote");
  const [config, setConfig] = useState<KeyValueRow[]>(() =>
    rowsFromRecord(controller?.config ?? {}),
  );
  const [secrets, setSecrets] = useState<KeyValueRow[]>([]);
  const [removedSecrets, setRemovedSecrets] = useState<string[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const nameError = !trimmedName
    ? "Enter a name."
    : trimmedName.length > 200
      ? "Use 200 characters or fewer."
      : null;
  const configDuplicates = duplicateKeys(config);
  const secretState = secretPatch(secrets, controller?.secretConfigKeys ?? [], removedSecrets);
  const valid = !nameError && configDuplicates.length === 0 && !secretState.error;
  const pending = create.isPending || update.isPending;
  const shownNameError = showErrors ? (nameError ?? undefined) : undefined;

  function submit() {
    setShowErrors(true);
    setError(null);
    if (!valid) return;
    const secretConfig = secretState.patch;
    const hasSecrets = Object.keys(secretConfig).length > 0;
    const done = {
      onSuccess: (saved: RuntimeController) => {
        toast.success(`${controller ? "Saved" : "Created"} ${saved.name}`);
        onOpenChange(false);
      },
      onError: (err: Error) => setError(err.message),
    };
    if (controller) {
      update.mutate(
        {
          id: controller.id,
          input: {
            name: trimmedName,
            // The API rejects a kind change while a pool of another kind uses
            // this controller; that error shows in the dialog.
            ...(kind !== controller.kind ? { kind } : {}),
            placement,
            config: recordFromRows(config),
            ...(hasSecrets ? { secretConfig } : {}),
          },
        },
        done,
      );
    } else {
      create.mutate(
        {
          name: trimmedName,
          kind,
          placement,
          config: recordFromRows(config),
          ...(hasSecrets ? { secretConfig } : {}),
        },
        done,
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{controller ? `Edit ${controller.name}` : "New controller"}</DialogTitle>
          <DialogDescription>
            A controller provisions runtimes for the pools that place on it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="max-h-[65vh] space-y-4 overflow-y-auto pr-1"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <SettingsRow label="Name" htmlFor="controller-name" required>
            <Input
              id="controller-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
              {...errorProps("controller-name", shownNameError)}
            />
            <FieldError fieldId="controller-name" message={shownNameError} />
          </SettingsRow>
          <div className="grid gap-4 sm:grid-cols-2">
            <SettingsRow
              label="Provider"
              htmlFor="controller-kind"
              helper={
                controller ? "Pools on this controller must use the same provider." : undefined
              }
            >
              <Select value={kind} onValueChange={(v) => setKind(v as RuntimeProviderKind)}>
                <SelectTrigger id="controller-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RUNTIME_PROVIDER_KINDS.map((option) => (
                    <SelectItem
                      key={option}
                      value={option}
                      disabled={COMING_SOON_KINDS.has(option)}
                    >
                      {RUNTIME_KIND_LABEL[option]}
                      {COMING_SOON_KINDS.has(option) ? " (coming soon)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsRow>
            <SettingsRow
              label="Placement"
              htmlFor="controller-placement"
              helper="Built in runs inside the API. Remote runs on your own host."
            >
              <Select value={placement} onValueChange={(v) => setPlacement(v as Placement)}>
                <SelectTrigger id="controller-placement" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="builtin">Built in</SelectItem>
                  <SelectItem value="remote">Remote</SelectItem>
                </SelectContent>
              </Select>
            </SettingsRow>
          </div>
          <SettingsRow label="Config" helper="Plain settings for the provider. Not secret.">
            <KeyValueEditor
              rows={config}
              onChange={setConfig}
              label="Config"
              addLabel="Add setting"
            />
            {configDuplicates.length > 0 ? (
              <p className="text-xs text-status-error-strong">
                Duplicate keys: {configDuplicates.join(", ")}.
              </p>
            ) : null}
          </SettingsRow>
          <SettingsRow
            label="Secrets"
            helper="Stored encrypted. Values are never shown again. A new value replaces the stored one."
          >
            {controller && controller.secretConfigKeys.length > 0 ? (
              <ul className="divide-y divide-border-subtle rounded-md border border-border">
                {controller.secretConfigKeys.map((key) => {
                  const removed = removedSecrets.includes(key);
                  return (
                    <li key={key} className="flex items-center gap-2 px-3 py-1.5">
                      <span
                        className={
                          removed
                            ? "flex-1 font-mono text-xs text-muted-foreground line-through"
                            : "flex-1 font-mono text-xs"
                        }
                      >
                        {key}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {removed ? "Removed on save" : "Stored"}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label={removed ? `Keep secret ${key}` : `Remove secret ${key}`}
                        onClick={() =>
                          setRemovedSecrets(
                            removed
                              ? removedSecrets.filter((candidate) => candidate !== key)
                              : [...removedSecrets, key],
                          )
                        }
                      >
                        {removed ? <Undo2 className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
                        {removed ? "Keep" : "Remove"}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <KeyValueEditor
              rows={secrets}
              onChange={setSecrets}
              label="Secret"
              addLabel="Add secret"
              valuePlaceholder="secret value"
              secret
            />
            {showErrors && secretState.error ? (
              <p className="text-xs text-status-error-strong">{secretState.error}</p>
            ) : null}
          </SettingsRow>
          {error ? (
            <AlertCallout tone="error" icon={AlertCircle}>
              {error}
            </AlertCallout>
          ) : null}
          <DialogFooter>
            {onMintToken ? (
              <Button type="button" variant="outline" className="sm:mr-auto" onClick={onMintToken}>
                <KeyRound className="h-4 w-4" />
                Mint token
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : controller ? "Save" : "Create controller"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RuntimeControllersList() {
  const isMobile = useIsMobile();
  const controllers = useRuntimeControllers();
  const remove = useDeleteRuntimeController();
  // `undefined` = closed, `null` = create, a controller = edit.
  const [editing, setEditing] = useState<RuntimeController | null | undefined>(undefined);
  // The target outlives `open`, so the title keeps its name while the dialog closes.
  const [deleting, setDeleting] = useState<RuntimeController | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // The token dialog unmounts on close, which drops the plaintext.
  const [minting, setMinting] = useState<RuntimeController | null>(null);

  const columnDefs = useMemo<ColDef<RuntimeController>[]>(
    () => [
      {
        headerName: "Name",
        field: "name",
        flex: 1,
        minWidth: 180,
        cellRenderer: (p: ICellRendererParams<RuntimeController>) =>
          p.data ? (
            <div className="leading-tight py-1">
              <div className="font-medium truncate">{p.data.name}</div>
              <div className="text-xs text-muted-foreground truncate">
                {RUNTIME_KIND_LABEL[p.data.kind]} · {placementLabel(p.data.placement)}
              </div>
            </div>
          ) : null,
      },
      {
        headerName: "Status",
        field: "status",
        width: 160,
        suppressSizeToFit: true,
        cellRenderer: (p: ICellRendererParams<RuntimeController>) =>
          p.data ? (
            <span className="flex items-center gap-2">
              <StatusChip controller={p.data} />
              {p.data.lastSeenAt ? (
                <span className="text-xs text-muted-foreground">
                  {formatRelative(p.data.lastSeenAt)}
                </span>
              ) : null}
            </span>
          ) : null,
      },
      {
        headerName: "Last error",
        field: "lastError",
        flex: 1,
        minWidth: 140,
        cellClass: "text-xs text-status-error-strong",
        tooltipField: "lastError",
      },
      {
        headerName: "Secret keys",
        colId: "secretKeys",
        width: 180,
        suppressSizeToFit: true,
        cellRenderer: (p: ICellRendererParams<RuntimeController>) =>
          p.data ? <SecretKeyChips controller={p.data} /> : null,
      },
      {
        headerName: "",
        colId: "actions",
        width: 96,
        suppressSizeToFit: true,
        sortable: false,
        cellRenderer: (p: ICellRendererParams<RuntimeController>) =>
          p.data ? (
            <span className="flex h-full w-full items-center justify-end gap-1.5">
              {p.data.placement === "remote" ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      className="h-7 w-7"
                      aria-label={`Mint token for ${p.data.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setMinting(p.data ?? null);
                      }}
                    >
                      <KeyRound className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Mint token</TooltipContent>
                </Tooltip>
              ) : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="destructive-outline"
                    className="h-7 w-7"
                    aria-label={`Delete ${p.data.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setDeleting(p.data ?? null);
                      setDeleteOpen(true);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Delete</TooltipContent>
              </Tooltip>
            </span>
          ) : null,
      },
    ],
    [],
  );

  if (controllers.isLoading) return <PageSkeleton />;
  const rows = controllers.data ?? [];

  const newController = (
    <Button type="button" size="sm" onClick={() => setEditing(null)}>
      <Plus className="h-4 w-4" />
      New controller
    </Button>
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-6">
      <PageHeader
        title="Runtime controllers"
        description="Controllers start and stop runtimes. Built-in controllers run inside the API."
        action={newController}
      />
      <RuntimePoolsTabs />

      {controllers.error && (
        <Alert variant="destructive">
          <AlertDescription>
            Failed to load runtime controllers: {controllers.error.message}
          </AlertDescription>
        </Alert>
      )}

      {!controllers.error && rows.length === 0 ? (
        <EmptyState
          icon={Server}
          title="No controllers"
          description="Add a controller before you create a Docker or E2B pool."
          action={newController}
        />
      ) : isMobile ? (
        <MobileList label="Runtime controllers" emptyMessage="No controllers">
          {rows.map((controller) => (
            <li key={controller.id}>
              <button
                type="button"
                onClick={() => setEditing(controller)}
                className="flex min-h-11 w-full flex-col gap-1 px-4 py-3 text-left outline-none hover:bg-accent/40 focus-visible:bg-accent/50"
              >
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {controller.name}
                  </span>
                  <StatusChip controller={controller} />
                </span>
                <span className="text-xs text-muted-foreground">
                  {RUNTIME_KIND_LABEL[controller.kind]} · {placementLabel(controller.placement)} ·{" "}
                  {controller.secretConfigKeys.length} secret
                  {controller.secretConfigKeys.length === 1 ? "" : "s"}
                </span>
              </button>
            </li>
          ))}
        </MobileList>
      ) : (
        <DataGrid
          rowData={rows}
          columnDefs={columnDefs}
          domLayout="autoHeight"
          pagination={false}
          emptyMessage="No controllers."
          rowHeight={56}
          getRowId={(p) => p.data.id}
          onRowClicked={(event) => {
            // AG Grid sees the native click before React's stopPropagation, so
            // a click on a row action button must not also open the editor.
            const target = event.event?.target as HTMLElement | null;
            if (target?.closest("button")) return;
            if (event.data) setEditing(event.data);
          }}
        />
      )}

      {editing !== undefined ? (
        <ControllerDialog
          key={editing?.id ?? "new"}
          controller={editing}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(undefined);
          }}
          onMintToken={
            editing?.placement === "remote"
              ? () => {
                  setMinting(editing);
                  setEditing(undefined);
                }
              : undefined
          }
        />
      ) : null}

      {minting ? (
        <RuntimeControllerTokenDialog
          key={minting.id}
          controller={minting}
          onClose={() => setMinting(null)}
        />
      ) : null}

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Deletes the controller and its stored secrets. A controller that pools still use
              cannot be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const target = deleting;
                if (!target) return;
                remove.mutate(target.id, {
                  onSuccess: () => toast.success(`Deleted ${target.name}`),
                  onError: (err) => toast.error(err.message),
                });
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Runtime controllers: `GET /api/runtime-controllers`, gated on `runtime_pools.enabled`. */
export default function RuntimeControllersPage() {
  return (
    <RuntimePoolsGuard>
      <RuntimeControllersList />
    </RuntimePoolsGuard>
  );
}
