import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { ArrowLeft, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import {
  useActivateExtensionVersion,
  useDeleteExtension,
  useDisableExtension,
  useEnableExtension,
  useExtension,
  useExtensionRuns,
  useExtensionTypeDefs,
  useExtensionVersions,
  usePatchExtension,
} from "@/api/hooks/use-extensions";
import type { ExtensionManifest, ExtensionRun, ExtensionVersion } from "@/api/types";
import { ScriptSourceEditor } from "@/components/scripts/script-source-editor";
import { DataGrid } from "@/components/shared/data-grid";
import { PageSkeleton } from "@/components/shared/page-skeleton";
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
import { PageHeader } from "@/components/ui/page-header";
import { Textarea } from "@/components/ui/textarea";
import { describeCron, formatInterval } from "@/lib/schedule-format";
import { formatSmartTime } from "@/lib/utils";
import { statusBadgeVariant } from "./extensions-page";

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
 * run log.
 */
export default function ExtensionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const extensionId = id ?? "";

  const { data: bundle, isLoading, error } = useExtension(id);
  const { data: versions } = useExtensionVersions(id);
  const { data: runs } = useExtensionRuns(id);
  const { data: typeDefsText } = useExtensionTypeDefs();

  const patch = usePatchExtension(extensionId);
  const enable = useEnableExtension(extensionId);
  const disable = useDisableExtension(extensionId);
  const activate = useActivateExtensionVersion(extensionId);
  const remove = useDeleteExtension(extensionId);

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

  if (isLoading) return <PageSkeleton />;

  if (!bundle) {
    return (
      <div className="flex flex-col flex-1 min-h-0 gap-6">
        <PageHeader
          title="Extension not found"
          action={
            <Button type="button" size="sm" variant="ghost" asChild>
              <Link to="/settings/extensions">
                <ArrowLeft className="h-4 w-4" />
                Back
              </Link>
            </Button>
          }
        />
        {error && (
          <Alert variant="destructive">
            <AlertDescription>
              {error instanceof Error ? error.message : String(error)}
            </AlertDescription>
          </Alert>
        )}
      </div>
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
        void navigate("/settings/extensions");
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
    <div className="flex flex-col flex-1 min-h-0 gap-6">
      <PageHeader
        title={
          <div className="flex items-center gap-2 min-w-0">
            <span className="truncate">{extension.name}</span>
            <Badge variant={statusBadgeVariant(extension.status)} size="tag">
              {extension.status}
            </Badge>
          </div>
        }
        description={`Active v${extension.activeVersion} of ${extension.version} · ${extension.consecutiveFailures} consecutive failures`}
        action={
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="ghost" asChild>
              <Link to="/settings/extensions">
                <ArrowLeft className="h-4 w-4" />
                Back
              </Link>
            </Button>
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
        }
      />

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
          <div className="grid gap-4 sm:grid-cols-4">
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
              <InfoTip content="Stored values are scrubbed on read, so secrets show as placeholders. Saving replaces the whole object. The server validates it against the extension schema on enable." />
            </div>
            <Textarea
              id="ext-config"
              value={configText}
              rows={6}
              className="font-mono text-xs"
              onChange={(e) => {
                setConfigText(e.target.value);
                setConfigDirty(true);
              }}
            />
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
