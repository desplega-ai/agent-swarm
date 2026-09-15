import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { ArrowLeft, Save } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ExtensionInstallError } from "@/api/client";
import {
  useActivateExtensionVersion,
  useDisableExtension,
  useEnableExtension,
  useExtension,
  useExtensionRuns,
  useExtensionTypeDefs,
  useExtensionVersions,
  useInstallExtension,
  usePatchExtension,
} from "@/api/hooks/use-extensions";
import type { ExtensionManifest, ExtensionRun, ExtensionVersion } from "@/api/types";
import { ScriptSourceEditor } from "@/components/scripts/script-source-editor";
import { DataGrid } from "@/components/shared/data-grid";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { Textarea } from "@/components/ui/textarea";
import { formatSmartTime } from "@/lib/utils";
import { statusBadgeVariant } from "./extensions-page";

/** The `minimal` fixture bundle, used as the starting point for a new extension. */
const TEMPLATE_HOOKS = `import type { SwarmExtension } from "swarm-extension";

const extension: SwarmExtension = (api) => {
  api.on("pre.task.create", () => ({ action: "continue" }));
};

export default extension;
`;

const TEMPLATE_FORM = {
  name: "",
  description: "",
  version: "1.0.0",
  hooksPath: "hooks.ts",
  source: TEMPLATE_HOOKS,
};

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
 * One extension bundle: manifest fields, the `hooks.ts` editor typed against
 * `swarm-extension.d.ts`, enable/disable, priority and config, the version
 * list, and the tail of the run log.
 *
 * `:id` is `new` for an unsaved bundle — the same form, seeded from the
 * minimal template, whose first Save installs version 1.
 */
export default function ExtensionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isNew = !id || id === "new";
  const extensionId = isNew ? undefined : id;

  const { data: bundle, isLoading } = useExtension(extensionId);
  const { data: versions } = useExtensionVersions(extensionId);
  const { data: runs } = useExtensionRuns(extensionId);
  const { data: typeDefsText } = useExtensionTypeDefs();

  const install = useInstallExtension();
  const patch = usePatchExtension(extensionId ?? "");
  const enable = useEnableExtension(extensionId ?? "");
  const disable = useDisableExtension(extensionId ?? "");
  const activate = useActivateExtensionVersion(extensionId ?? "");

  const [form, setForm] = useState(TEMPLATE_FORM);
  const [priority, setPriority] = useState("0");
  const [configText, setConfigText] = useState("{}");
  const [configDirty, setConfigDirty] = useState(false);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The extension query is on the global poll; only adopt server state when the
  // stored bundle actually changed, otherwise a refetch would discard edits.
  const loadedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!bundle) return;
    const key = `${bundle.extension.id}:${bundle.extension.contentHash}`;
    if (loadedKey.current === key) return;
    loadedKey.current = key;
    const hooksPath = bundle.manifest.assets.hooks;
    setForm({
      name: bundle.manifest.name,
      description: bundle.manifest.description,
      version: bundle.manifest.version,
      hooksPath,
      source: bundle.files[hooksPath] ?? "",
    });
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

  if (!isNew && isLoading) return <PageSkeleton />;

  const extension = bundle?.extension;

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
    } catch (error) {
      setSaveError(`Config is not valid JSON: ${(error as Error).message}`);
      return null;
    }
  }

  function handleSaveBundle() {
    setDiagnostics([]);
    setSaveError(null);
    const manifest: ExtensionManifest = {
      name: form.name.trim(),
      description: form.description,
      version: form.version.trim(),
      runtime: "api",
      assets: { hooks: form.hooksPath },
    };
    install.mutate(
      { manifest, files: { [form.hooksPath]: form.source } },
      {
        onSuccess: (result) => {
          loadedKey.current = null;
          if (isNew) void navigate(`/settings/extensions/${result.extension.id}`);
        },
        onError: (error) => {
          if (error instanceof ExtensionInstallError) {
            setDiagnostics(error.diagnostics);
            setSaveError(error.message);
            return;
          }
          setSaveError(error instanceof Error ? error.message : String(error));
        },
      },
    );
  }

  function handleSaveSettings() {
    setSaveError(null);
    const config = configDirty ? parseConfig() : undefined;
    if (configDirty && !config) return;
    patch.mutate(
      { priority: Number(priority) || 0, ...(config ? { config } : {}) },
      {
        onSuccess: () => setConfigDirty(false),
        onError: (error) => setSaveError(error instanceof Error ? error.message : String(error)),
      },
    );
  }

  const busy = install.isPending || patch.isPending || enable.isPending || disable.isPending;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-6">
      <PageHeader
        title={
          <div className="flex items-center gap-2 min-w-0">
            <span className="truncate">{isNew ? "New extension" : extension?.name}</span>
            {extension && (
              <Badge variant={statusBadgeVariant(extension.status)} size="tag">
                {extension.status}
              </Badge>
            )}
          </div>
        }
        description={
          extension
            ? `Active v${extension.activeVersion} of ${extension.version} · ${extension.consecutiveFailures} consecutive failures`
            : "Seeded from the minimal bundle. Save to install version 1."
        }
        action={
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="ghost" asChild>
              <Link to="/settings/extensions">
                <ArrowLeft className="h-4 w-4" />
                Back
              </Link>
            </Button>
            {extension &&
              (extension.enabled ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    disable.mutate(undefined, {
                      onError: (error) => setSaveError(error.message),
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
                      onError: (error) => setSaveError(error.message),
                    })
                  }
                >
                  Enable
                </Button>
              ))}
          </div>
        }
      />

      {saveError && (
        <Alert variant="destructive">
          <AlertDescription>
            <p>{saveError}</p>
            {diagnostics.length > 0 && (
              <ul className="mt-2 list-disc pl-4 font-mono text-[11px] leading-relaxed">
                {diagnostics.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}

      {extension?.lastError && (
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
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ext-name">Name</Label>
              <Input
                id="ext-name"
                value={form.name}
                placeholder="my-extension"
                disabled={!isNew}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ext-version">Manifest version</Label>
              <Input
                id="ext-version"
                value={form.version}
                placeholder="1.0.0"
                onChange={(e) => setForm({ ...form, version: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ext-hooks">Hooks asset</Label>
              <Input id="ext-hooks" value={form.hooksPath} disabled readOnly />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ext-description">Description</Label>
            <Input
              id="ext-description"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <ScriptSourceEditor
            source={form.source}
            onChange={(source) => setForm({ ...form, source })}
            typeDefs={typeDefs}
            readOnly={false}
            height="360px"
          />
          <div className="flex justify-end">
            <Button type="button" size="sm" disabled={busy} onClick={handleSaveBundle}>
              <Save className="h-4 w-4" />
              {isNew ? "Install" : "Save new version"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {extension && (
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
              <Label htmlFor="ext-config">Config (JSON)</Label>
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
              <p className="text-xs text-muted-foreground">
                Stored values are scrubbed on read, so secrets show as placeholders. Saving replaces
                the whole object. The server validates it against the extension schema on enable.
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
      )}

      {extension && (
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
                  onError: (error) => setSaveError(error.message),
                });
              }}
            />
          </CardContent>
        </Card>
      )}

      {extension && (
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
      )}
    </div>
  );
}
