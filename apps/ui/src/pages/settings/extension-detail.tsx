import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  useActivateExtensionVersion,
  useCancelExtensionRequests,
  useDeleteExtension,
  useDisableExtension,
  useEnableExtension,
  useExtension,
  useExtensionRuns,
  useExtensionTypeDefs,
  useExtensionVersions,
  usePatchExtension,
} from "@/api/hooks/use-extensions";
import type {
  ExtensionManifest,
  ExtensionRun,
  ExtensionStatus,
  ExtensionVersion,
} from "@/api/types";
import { Spinner } from "@/components/kibo-ui/spinner";
import { ScriptSourceEditor } from "@/components/scripts/script-source-editor";
import { DataGrid } from "@/components/shared/data-grid";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoRow } from "@/components/ui/info-row";
import { InfoTip } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { describeCron, formatInterval } from "@/lib/schedule-format";
import { formatSmartTime } from "@/lib/utils";

/** Status to badge variant. `error` and `auto-disabled` both need attention. */
export function statusBadgeVariant(
  status: ExtensionStatus,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "enabled") return "default";
  if (status === "error" || status === "auto-disabled") return "destructive";
  return "outline";
}

/** Bundle paths Monaco should render as TypeScript; anything else shows as plain text. */
const TS_FILE = /\.(?:[cm]?[jt]sx?)$/;

/** Version history for one bundle, with the activate action on each row. */
function VersionsGrid({
  versions,
  activeVersion,
  busy,
  onActivate,
}: {
  versions: ExtensionVersion[];
  activeVersion: number;
  busy: boolean;
  onActivate: (version: number) => void;
}) {
  const columnDefs = useMemo<ColDef<ExtensionVersion>[]>(
    () => [
      {
        headerName: "Version",
        field: "version",
        width: 150,
        suppressSizeToFit: true,
        cellRenderer: (p: ICellRendererParams<ExtensionVersion>) =>
          p.data ? (
            <span className="font-mono text-xs">
              v{p.data.version}
              {p.data.version === activeVersion && (
                <Badge variant="outline" size="tag" className="ml-2">
                  active
                </Badge>
              )}
            </span>
          ) : null,
      },
      {
        headerName: "Changed",
        field: "changedAt",
        width: 160,
        suppressSizeToFit: true,
        cellRenderer: (p: ICellRendererParams<ExtensionVersion>) => (
          <span className="text-xs text-muted-foreground">
            {p.data ? formatSmartTime(p.data.changedAt) : null}
          </span>
        ),
      },
      {
        headerName: "Reason",
        field: "changeReason",
        flex: 1,
        minWidth: 200,
        cellRenderer: (p: ICellRendererParams<ExtensionVersion>) => (
          <span className="text-xs text-muted-foreground">{p.data?.changeReason || "—"}</span>
        ),
      },
      {
        headerName: "Action",
        colId: "action",
        width: 120,
        suppressSizeToFit: true,
        sortable: false,
        cellClass: "ag-right-aligned-cell",
        headerClass: "ag-right-aligned-header",
        cellRenderer: (p: ICellRendererParams<ExtensionVersion>) =>
          p.data ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || p.data.version === activeVersion}
              onClick={(e) => {
                e.stopPropagation();
                if (p.data) onActivate(p.data.version);
              }}
            >
              Activate
            </Button>
          ) : null,
      },
    ],
    [activeVersion, busy, onActivate],
  );

  return (
    <DataGrid
      rowData={versions}
      columnDefs={columnDefs}
      domLayout="autoHeight"
      pagination={false}
      emptyMessage="No versions yet."
    />
  );
}

/** Tail of the extension run log. */
function RunLogGrid({ runs }: { runs: ExtensionRun[] }) {
  const columnDefs = useMemo<ColDef<ExtensionRun>[]>(
    () => [
      {
        headerName: "When",
        field: "createdAt",
        width: 150,
        suppressSizeToFit: true,
        cellRenderer: (p: ICellRendererParams<ExtensionRun>) => (
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {p.data ? formatSmartTime(p.data.createdAt) : null}
          </span>
        ),
      },
      {
        headerName: "Event",
        field: "event",
        width: 200,
        suppressSizeToFit: true,
        cellClass: "font-mono text-xs",
      },
      {
        headerName: "Action",
        field: "action",
        width: 140,
        suppressSizeToFit: true,
        cellRenderer: (p: ICellRendererParams<ExtensionRun>) =>
          p.data ? (
            <Badge
              variant={
                p.data.action === "error" ||
                p.data.action === "timeout" ||
                p.data.action === "load-error"
                  ? "destructive"
                  : "outline"
              }
              size="tag"
            >
              {p.data.action}
            </Badge>
          ) : null,
      },
      {
        headerName: "Duration",
        field: "durationMs",
        width: 120,
        suppressSizeToFit: true,
        cellClass: "ag-right-aligned-cell font-mono text-xs",
        headerClass: "ag-right-aligned-header",
        valueFormatter: (p) => (p.value == null ? "—" : `${p.value} ms`),
      },
      {
        headerName: "Agent",
        field: "agentId",
        width: 120,
        suppressSizeToFit: true,
        cellRenderer: (p: ICellRendererParams<ExtensionRun>) => (
          <span className="font-mono text-xs text-muted-foreground" title={p.data?.agentId ?? ""}>
            {p.data?.agentId ? p.data.agentId.slice(0, 8) : "—"}
          </span>
        ),
      },
      {
        headerName: "Subject",
        field: "subject",
        flex: 1,
        minWidth: 180,
        cellRenderer: (p: ICellRendererParams<ExtensionRun>) => (
          <span className="text-xs text-muted-foreground break-all">{p.data?.subject || "—"}</span>
        ),
      },
      {
        headerName: "Message",
        field: "message",
        flex: 1,
        minWidth: 200,
        cellRenderer: (p: ICellRendererParams<ExtensionRun>) => (
          <span className="text-xs text-muted-foreground break-all">{p.data?.message || "—"}</span>
        ),
      },
    ],
    [],
  );

  return (
    <DataGrid
      rowData={runs}
      columnDefs={columnDefs}
      domLayout="autoHeight"
      pagination={false}
      emptyMessage="No runs yet."
    />
  );
}

/**
 * Read-only viewer over the active snapshot's files. The hooks entry opens
 * first; `.ts`/`.js` files get Monaco, anything else renders as plain text.
 */
function BundleFiles({
  files,
  hooksPath,
  typeDefs,
}: {
  files: Record<string, string>;
  hooksPath: string;
  typeDefs?: { sdkTypes: string; stdlibTypes: string };
}) {
  const paths = useMemo(
    () =>
      Object.keys(files).sort((a, b) =>
        a === hooksPath ? -1 : b === hooksPath ? 1 : a.localeCompare(b),
      ),
    [files, hooksPath],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const current = selected && selected in files ? selected : (paths[0] ?? null);

  if (!current) return <p className="text-sm text-muted-foreground">No files in this bundle.</p>;

  const source = files[current] ?? "";
  return (
    <div className="flex flex-col gap-3">
      {paths.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {paths.map((path) => (
            <Button
              key={path}
              type="button"
              size="sm"
              variant={path === current ? "secondary" : "ghost"}
              className="font-mono text-xs"
              onClick={() => setSelected(path)}
            >
              {path}
            </Button>
          ))}
        </div>
      )}
      {TS_FILE.test(current) ? (
        <ScriptSourceEditor
          source={source}
          typeDefs={current === hooksPath ? typeDefs : undefined}
          readOnly
          height="360px"
        />
      ) : (
        <pre className="max-h-[360px] overflow-auto rounded-md border bg-card p-3 font-mono text-xs whitespace-pre-wrap">
          {source}
        </pre>
      )}
    </div>
  );
}

/** Scripts, schedules, skills, and workflows the manifest declares. */
function ManifestAssets({ assets }: { assets: ExtensionManifest["assets"] }) {
  const scripts = assets.scripts ?? [];
  const schedules = assets.schedules ?? [];
  const skills = assets.skills ?? [];
  const workflows = assets.workflows ?? [];
  if (
    scripts.length === 0 &&
    schedules.length === 0 &&
    skills.length === 0 &&
    workflows.length === 0
  ) {
    return (
      <p className="text-sm text-muted-foreground">
        Hooks only — this bundle declares no scripts, schedules, skills, or workflows.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {scripts.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Scripts
          </h4>
          <ul className="flex flex-col gap-1.5">
            {scripts.map((script) => (
              <li key={script.name} className="text-sm">
                <span className="font-mono">{script.name}</span>
                <span className="font-mono text-xs text-muted-foreground"> · {script.file}</span>
                <div className="text-xs text-muted-foreground">{script.description}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {schedules.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Schedules
          </h4>
          <ul className="flex flex-col gap-1.5">
            {schedules.map((schedule) => {
              const cadence = schedule.cronExpression
                ? describeCron(schedule.cronExpression)
                : schedule.intervalMs
                  ? `Every ${formatInterval(schedule.intervalMs)}`
                  : "No cadence";
              return (
                <li key={schedule.name} className="text-sm">
                  <span className="font-mono">{schedule.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {" "}
                    · runs <span className="font-mono">{schedule.script}</span> · {cadence}
                    {schedule.cronExpression && (
                      <code className="ml-1 font-mono">({schedule.cronExpression})</code>
                    )}
                    {schedule.timezone ? ` · ${schedule.timezone}` : ""}
                  </span>
                  {schedule.description && (
                    <div className="text-xs text-muted-foreground">{schedule.description}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {(skills.length > 0 || workflows.length > 0) && (
        <div className="flex flex-col gap-1.5">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Skills &amp; workflows
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {skills.map(({ dir }) => (
              <Badge key={`skill:${dir}`} variant="outline" size="tag">
                skill · {dir.split("/").pop()}
              </Badge>
            ))}
            {workflows.map(({ file }) => (
              <Badge key={`workflow:${file}`} variant="outline" size="tag">
                workflow · {file}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One installed extension: its manifest and the active snapshot's files
 * (read-only — bundles come from the catalog, see `/settings/extensions/new`),
 * enable/disable, priority and config, the version list, and the tail of the
 * run log. Rendered by {@link ExtensionDetailSheet}.
 */
export function ExtensionDetail({
  extensionId,
  active,
  onDeleted,
}: {
  extensionId: string;
  /** False while the sheet closes: render cached data, fetch nothing. */
  active: boolean;
  onDeleted: () => void;
}) {
  const patch = usePatchExtension(extensionId);
  const enable = useEnableExtension(extensionId);
  const disable = useDisableExtension(extensionId);
  const activate = useActivateExtensionVersion(extensionId);
  const remove = useDeleteExtension(extensionId);

  // Stop fetching once a delete starts: its success drops these caches, and a
  // still-enabled observer would re-create them and poll the 404.
  const live = active && !remove.isPending && !remove.isSuccess;
  const { data: bundle, isLoading, error } = useExtension(extensionId, { enabled: live });
  const { data: versions } = useExtensionVersions(extensionId, { enabled: live });
  const { data: runs } = useExtensionRuns(extensionId, { enabled: live });
  const { data: typeDefsText } = useExtensionTypeDefs();

  const [priority, setPriority] = useState("0");
  const [configText, setConfigText] = useState("{}");
  const [configDirty, setConfigDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The extension query is on the global poll; only adopt server state when the
  // stored bundle actually changed, otherwise a refetch would discard edits.
  const loadedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!bundle) return;
    const key = `${bundle.extension.id}:${bundle.extension.contentHash}`;
    if (loadedKey.current === key) return;
    loadedKey.current = key;
    setPriority(String(bundle.extension.priority));
    if (!configDirty) setConfigText(bundle.extension.configJson || "{}");
  }, [bundle, configDirty]);

  // ScriptSourceEditor registers whatever it is given as the Monaco SDK extra
  // lib; the extension `.d.ts` declares its own `swarm-extension` module, so it
  // stands alone and needs no stdlib blob.
  const typeDefs = useMemo(
    () => (typeDefsText ? { sdkTypes: typeDefsText, stdlibTypes: "" } : undefined),
    [typeDefsText],
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-3.5" /> Loading extension…
      </div>
    );
  }

  if (!bundle) {
    // Deleted: the cache entry is gone and the sheet is sliding out.
    if (!live) return null;
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {error
            ? error instanceof Error
              ? error.message
              : String(error)
            : "Extension not found."}
        </AlertDescription>
      </Alert>
    );
  }

  const { extension, manifest, files } = bundle;

  function parseConfig(): Record<string, unknown> | null {
    const text = configText.trim();
    if (!text) return {};
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setSaveError("Config must be a JSON object.");
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch (err) {
      setSaveError(`Config is not valid JSON: ${(err as Error).message}`);
      return null;
    }
  }

  function handleSaveSettings() {
    setSaveError(null);
    const config = configDirty ? parseConfig() : undefined;
    if (configDirty && !config) return;
    patch.mutate(
      { priority: Number(priority) || 0, ...(config ? { config } : {}) },
      {
        onSuccess: () => setConfigDirty(false),
        onError: (err) => setSaveError(err instanceof Error ? err.message : String(err)),
      },
    );
  }

  function handleDelete() {
    setSaveError(null);
    remove.mutate(undefined, {
      onSuccess: (result) => {
        const deleted = result.assets?.deleted.length ?? 0;
        const detached = result.assets?.detached.length ?? 0;
        const parts = [
          deleted > 0 ? `${deleted} asset${deleted === 1 ? "" : "s"} deleted` : null,
          detached > 0 ? `${detached} detached` : null,
        ].filter((part): part is string => part !== null);
        toast.success(`Deleted ${extension.name}`, {
          description: parts.length > 0 ? parts.join(", ") : undefined,
        });
        onDeleted();
      },
      onError: (err) => setSaveError(err.message),
    });
  }

  const busy =
    patch.isPending ||
    enable.isPending ||
    disable.isPending ||
    activate.isPending ||
    remove.isPending;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="destructive-outline"
          disabled={busy}
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 className="h-4 w-4" />
          Delete
        </Button>
        {extension.enabled ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              disable.mutate(undefined, {
                onError: (err) => setSaveError(err.message),
              })
            }
          >
            Disable
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() =>
              enable.mutate(undefined, {
                onError: (err) => setSaveError(err.message),
              })
            }
          >
            Enable
          </Button>
        )}
      </div>

      {saveError && (
        <Alert variant="destructive">
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}

      {extension.lastError && (
        <Alert variant="destructive">
          <AlertDescription className="font-mono text-[11px] break-all">
            {extension.lastError}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Bundle</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <InfoRow label="Manifest version">
              <span className="font-mono text-xs">{manifest.version}</span>
            </InfoRow>
            <InfoRow label="Runtime">
              <span className="font-mono text-xs">{manifest.runtime}</span>
            </InfoRow>
            <InfoRow label="Hooks asset">
              <span className="font-mono text-xs break-all">{manifest.assets.hooks}</span>
            </InfoRow>
            <InfoRow label="Author">{manifest.author || "—"}</InfoRow>
          </div>
          <InfoRow label="Description">{manifest.description || "—"}</InfoRow>
          {manifest.homepage && (
            <InfoRow label="Homepage">
              <a
                href={manifest.homepage}
                target="_blank"
                rel="noreferrer"
                className="break-all underline underline-offset-2"
              >
                {manifest.homepage}
              </a>
            </InfoRow>
          )}
          <BundleFiles files={files} hooksPath={manifest.assets.hooks} typeDefs={typeDefs} />
          <p className="text-xs text-muted-foreground">
            Read-only. Bundles install from the{" "}
            <Link to="/settings/extensions/new" className="underline underline-offset-2">
              extension catalog
            </Link>
            ; reinstall from there to pick up a newer version.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Assets</CardTitle>
        </CardHeader>
        <CardContent>
          <ManifestAssets assets={manifest.assets} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5 max-w-[160px]">
            <Label htmlFor="ext-priority">Priority</Label>
            <Input
              id="ext-priority"
              type="number"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <Label htmlFor="ext-config">Config (JSON)</Label>
              <InfoTip content="Stored values are scrubbed on read, so secrets show as placeholders. The server validates the config against the extension schema on enable." />
            </div>
            <Textarea
              id="ext-config"
              value={configText}
              rows={6}
              className="font-mono text-xs"
              aria-describedby="ext-config-note"
              onChange={(e) => {
                setConfigText(e.target.value);
                setConfigDirty(true);
              }}
            />
            <p id="ext-config-note" className="text-xs text-muted-foreground">
              Saving replaces the whole object.
            </p>
          </div>
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={handleSaveSettings}
            >
              Save settings
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Versions</CardTitle>
        </CardHeader>
        <CardContent>
          <VersionsGrid
            versions={versions ?? []}
            activeVersion={extension.activeVersion}
            busy={busy}
            onActivate={(version) => {
              loadedKey.current = null;
              activate.mutate(version, {
                onError: (err) => setSaveError(err.message),
              });
            }}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Run log</CardTitle>
        </CardHeader>
        <CardContent>
          {(runs?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">
              No runs yet. Entries appear once an enabled extension handles an event.
            </p>
          ) : (
            <RunLogGrid runs={runs ?? []} />
          )}
        </CardContent>
      </Card>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {extension.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes the extension. The scripts, schedules, workflows, and skills it installed are
              deleted, except ones edited since install, which are kept and detached. You can
              reinstall it from the catalog.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmDelete(false);
                handleDelete();
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

/**
 * Focus handling for a sheet opened without a SheetTrigger, where Radix would
 * return focus to <body> on close. Spread `contentProps` on SheetContent. Open focuses the panel itself (not its first
 * button, Delete or Install) and remembers what had focus; close returns there,
 * or to `fallback()` when nothing did (deep link) or it left the page.
 * `forgetOpener()` sends the next close to `fallback()` even while the opener
 * is still in the DOM, as a deleted card is until the list refetch lands.
 */
export function useSheetFocus(fallback: () => HTMLElement | null) {
  const opener = useRef<HTMLElement | null>(null);
  const forgetOpener = () => {
    opener.current = null;
  };
  const contentProps = {
    onOpenAutoFocus(event: Event) {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
      event.preventDefault();
      if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
    },
    onCloseAutoFocus(event: Event) {
      event.preventDefault();
      const target = opener.current?.isConnected ? opener.current : fallback();
      opener.current = null;
      target?.focus();
    },
  };
  return { contentProps, forgetOpener };
}

/**
 * Right-side sheet over the installed-extensions grid. Open while
 * `extensionId` is set; the route `/settings/extensions/:id` drives it, so
 * deep links land on the grid with this sheet open. Full width on small
 * screens. `focusFallback` names where focus goes on close when the opener is
 * gone, or always once the extension was deleted.
 */
export function ExtensionDetailSheet({
  extensionId,
  onClose,
  focusFallback,
}: {
  extensionId: string | null;
  onClose: () => void;
  focusFallback: (extensionId: string, deleted: boolean) => HTMLElement | null;
}) {
  const open = !!extensionId;
  // Keep the last id so the body stays rendered while the sheet animates
  // closed; its queries stop with `open`, so a closed or deleted extension is
  // never polled.
  const [shownId, setShownId] = useState(extensionId);
  const deleted = useRef(false);
  if (extensionId && extensionId !== shownId) {
    setShownId(extensionId);
    deleted.current = false;
  }
  // Cache reader only: the body's query owns fetching and polling.
  const { data: bundle } = useExtension(shownId ?? undefined, { enabled: false });
  const extension = bundle?.extension;
  const focus = useSheetFocus(() => (shownId ? focusFallback(shownId, deleted.current) : null));
  // The header's disabled observer keeps a failing fetch retrying after the
  // body stops, so closing (or switching extensions) cancels that id's requests.
  const cancelRequests = useCancelExtensionRequests();
  useEffect(() => {
    if (!open || !shownId) return;
    return () => cancelRequests(shownId);
  }, [open, shownId, cancelRequests]);

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-3xl" {...focus.contentProps}>
        <SheetHeader className="border-b border-border px-6 py-4 pr-12">
          <SheetTitle className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono">{extension?.name ?? "Extension"}</span>
            {extension && (
              <Badge variant={statusBadgeVariant(extension.status)} size="tag">
                {extension.status}
              </Badge>
            )}
          </SheetTitle>
          <SheetDescription>
            {extension
              ? `Active v${extension.activeVersion} of ${extension.version} · ${extension.consecutiveFailures} consecutive failures`
              : "Installed extension"}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {shownId && (
            <ExtensionDetail
              key={shownId}
              extensionId={shownId}
              active={open}
              onDeleted={() => {
                deleted.current = true;
                focus.forgetOpener();
                onClose();
              }}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
