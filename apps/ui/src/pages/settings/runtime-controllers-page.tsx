import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { AlertCircle, Plus, Server, Trash2, Undo2 } from "lucide-react";
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
  RUNTIME_KIND_LABEL,
  RUNTIME_PROVIDER_KINDS,
  RUNTIME_STATE_TONE,
} from "@/lib/runtime-pools";
import { RuntimePoolsGuard, RuntimePoolsTabs } from "./runtime-pools-shared";

type Placement = RuntimeController["placement"];

function placementLabel(placement: Placement): string {
  return placement === "builtin" ? "Built in" : "Remote";
}

function StatusChip({ controller }: { controller: RuntimeController }) {
  return (
    <Badge variant="outline" size="tag" className={RUNTIME_STATE_TONE[controller.status]}>
      {controller.status}
    </Badge>
  );
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
}: {
  controller: RuntimeController | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
  const secretDuplicates = duplicateKeys(secrets);
  const valid = !nameError && configDuplicates.length === 0 && secretDuplicates.length === 0;
  const pending = create.isPending || update.isPending;

  function submit() {
    setShowErrors(true);
    setError(null);
    if (!valid) return;
    const secretConfig: Record<string, string | null> = recordFromRows(secrets);
    for (const key of removedSecrets) if (!(key in secretConfig)) secretConfig[key] = null;
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
              aria-invalid={showErrors && Boolean(nameError)}
              autoFocus
            />
            {showErrors && nameError ? (
              <p className="text-xs text-status-error-strong">{nameError}</p>
            ) : null}
          </SettingsRow>
          <div className="grid gap-4 sm:grid-cols-2">
            <SettingsRow
              label="Provider"
              htmlFor="controller-kind"
              helper={controller ? "Fixed after create." : undefined}
            >
              <Select
                value={kind}
                onValueChange={(v) => setKind(v as RuntimeProviderKind)}
                disabled={Boolean(controller)}
              >
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
            {secretDuplicates.length > 0 ? (
              <p className="text-xs text-status-error-strong">
                Duplicate keys: {secretDuplicates.join(", ")}.
              </p>
            ) : null}
          </SettingsRow>
          {error ? (
            <AlertCallout tone="error" icon={AlertCircle}>
              {error}
            </AlertCallout>
          ) : null}
          <DialogFooter>
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
  const [deleting, setDeleting] = useState<RuntimeController | null>(null);

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
        width: 220,
        suppressSizeToFit: true,
        cellRenderer: (p: ICellRendererParams<RuntimeController>) =>
          p.data ? <SecretKeyChips controller={p.data} /> : null,
      },
      {
        headerName: "",
        colId: "actions",
        width: 64,
        suppressSizeToFit: true,
        sortable: false,
        cellRenderer: (p: ICellRendererParams<RuntimeController>) =>
          p.data ? (
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
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Delete</TooltipContent>
            </Tooltip>
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
        />
      ) : null}

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
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
