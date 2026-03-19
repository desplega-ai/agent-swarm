import type { ColDef, ICellRendererParams, RowClickedEvent } from "ag-grid-community";
import {
  Check,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  Hexagon,
  Loader2,
  Pencil,
  Plus,
  Signal,
  Trash2,
  XCircle,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useConfigs, useDeleteConfig, useUpsertConfig } from "@/api/hooks/use-config-api";
import type { SwarmConfig, SwarmConfigScope } from "@/api/types";
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useConfig } from "@/hooks/use-config";
import type { Connection } from "@/lib/config";
import { generateSlug } from "@/lib/slugs";

// ---------------------------------------------------------------------------
// Swarm Config (server-side CRUD) — preserved from previous implementation
// ---------------------------------------------------------------------------

interface ConfigFormData {
  scope: SwarmConfigScope;
  scopeId: string;
  key: string;
  value: string;
  isSecret: boolean;
  description: string;
}

const emptyConfigForm: ConfigFormData = {
  scope: "global",
  scopeId: "",
  key: "",
  value: "",
  isSecret: false,
  description: "",
};

function ConfigEntryDialog({
  open,
  onOpenChange,
  editEntry,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editEntry: SwarmConfig | null;
  onSubmit: (data: ConfigFormData) => void;
}) {
  const { data: agents } = useAgents();
  const [form, setForm] = useState<ConfigFormData>(() =>
    editEntry
      ? {
          scope: editEntry.scope,
          scopeId: editEntry.scopeId ?? "",
          key: editEntry.key,
          value: editEntry.isSecret ? "" : editEntry.value,
          isSecret: editEntry.isSecret,
          description: editEntry.description ?? "",
        }
      : emptyConfigForm,
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit(form);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{editEntry ? "Edit Config Entry" : "Add Config Entry"}</DialogTitle>
            <DialogDescription>
              {editEntry ? "Update configuration entry." : "Add a new configuration entry."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Scope</Label>
              <Select
                value={form.scope}
                onValueChange={(v) =>
                  setForm({ ...form, scope: v as SwarmConfigScope, scopeId: "" })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Global</SelectItem>
                  <SelectItem value="agent">Agent</SelectItem>
                  <SelectItem value="repo">Repo</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.scope === "agent" && (
              <div className="space-y-2">
                <Label>Agent</Label>
                {agents && agents.length > 0 ? (
                  <Select
                    value={form.scopeId}
                    onValueChange={(v) => setForm({ ...form, scopeId: v })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select agent..." />
                    </SelectTrigger>
                    <SelectContent>
                      {agents.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          <span>{a.name}</span>
                          <span className="ml-2 text-xs text-muted-foreground font-mono">
                            {a.id.slice(0, 8)}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    placeholder="Agent UUID"
                    value={form.scopeId}
                    onChange={(e) => setForm({ ...form, scopeId: e.target.value })}
                  />
                )}
              </div>
            )}
            {form.scope === "repo" && (
              <div className="space-y-2">
                <Label>Scope ID</Label>
                <Input
                  placeholder="Repo UUID"
                  value={form.scopeId}
                  onChange={(e) => setForm({ ...form, scopeId: e.target.value })}
                />
              </div>
            )}
            <div className="space-y-2">
              <Label>Key</Label>
              <Input
                placeholder="CONFIG_KEY"
                value={form.key}
                onChange={(e) => setForm({ ...form, key: e.target.value })}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Value</Label>
              <Input
                type={form.isSecret ? "password" : "text"}
                placeholder="config value"
                value={form.value}
                onChange={(e) => setForm({ ...form, value: e.target.value })}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Description (optional)</Label>
              <Input
                placeholder="What this config does"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="config-secret"
                checked={form.isSecret}
                onCheckedChange={(checked) => setForm({ ...form, isSecret: checked })}
              />
              <Label htmlFor="config-secret">Secret value</Label>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" className="bg-primary hover:bg-primary/90">
              {editEntry ? "Update" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConfigDetailDialog({
  config,
  onOpenChange,
  agentName,
}: {
  config: SwarmConfig | null;
  onOpenChange: (open: boolean) => void;
  agentName?: string;
}) {
  const [showValue, setShowValue] = useState(false);
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    if (!config) return;
    navigator.clipboard.writeText(config.value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Dialog open={!!config} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-mono text-base">{config?.key}</DialogTitle>
          <DialogDescription>{config?.description || "No description"}</DialogDescription>
        </DialogHeader>
        {config && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase"
              >
                {config.scope}
              </Badge>
              {config.isSecret && (
                <Badge
                  variant="outline"
                  className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase border-amber-500/30 text-amber-400"
                >
                  secret
                </Badge>
              )}
            </div>

            {config.scope !== "global" && config.scopeId && (
              <div>
                <Label className="text-xs text-muted-foreground uppercase tracking-wide">
                  {config.scope === "agent" ? "Agent" : "Scope ID"}
                </Label>
                <p className="text-sm mt-0.5">{agentName || `${config.scopeId.slice(0, 8)}...`}</p>
              </div>
            )}

            <div>
              <Label className="text-xs text-muted-foreground uppercase tracking-wide">Value</Label>
              <div className="flex items-center gap-1 mt-1">
                <code className="flex-1 text-sm font-mono rounded-md bg-muted p-2 break-all select-text">
                  {showValue ? config.value : "••••••••••••••••"}
                </code>
                <div className="flex flex-col gap-1 shrink-0">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => setShowValue(!showValue)}
                  >
                    {showValue ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={handleCopy}>
                    {copied ? (
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SwarmConfigSection() {
  const { data: configs, isLoading } = useConfigs({ includeSecrets: true });
  const { data: agents } = useAgents();
  const upsertConfig = useUpsertConfig();
  const deleteConfig = useDeleteConfig();

  const agentMap = useMemo(() => {
    const m = new Map<string, string>();
    agents?.forEach((a) => {
      m.set(a.id, a.name);
    });
    return m;
  }, [agents]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editEntry, setEditEntry] = useState<SwarmConfig | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SwarmConfig | null>(null);
  const [detailEntry, setDetailEntry] = useState<SwarmConfig | null>(null);
  const [scopeFilter, setScopeFilter] = useState<string>("all");

  function handleAdd() {
    setEditEntry(null);
    setDialogOpen(true);
  }

  const handleEdit = useCallback((entry: SwarmConfig) => {
    setEditEntry(entry);
    setDialogOpen(true);
  }, []);

  function handleSubmit(data: ConfigFormData) {
    upsertConfig.mutate({
      scope: data.scope,
      scopeId: data.scopeId || null,
      key: data.key,
      value: data.value,
      isSecret: data.isSecret,
      description: data.description || null,
    });
    setEditEntry(null);
  }

  function handleDelete() {
    if (deleteTarget) {
      deleteConfig.mutate(deleteTarget.id);
      setDeleteTarget(null);
    }
  }

  const onRowClicked = useCallback((event: RowClickedEvent<SwarmConfig>) => {
    // Ignore clicks on interactive elements (buttons, links) inside cells
    const target = event.event?.target as HTMLElement | undefined;
    if (target?.closest("button, a, [role='button']")) return;
    if (event.data) setDetailEntry(event.data);
  }, []);

  const filteredConfigs =
    scopeFilter === "all" ? configs : configs?.filter((c) => c.scope === scopeFilter);

  const columnDefs = useMemo<ColDef<SwarmConfig>[]>(
    () => [
      {
        field: "scope",
        headerName: "Scope",
        width: 110,
        minWidth: 90,
        cellRenderer: (params: { value: string }) => (
          <Badge
            variant="outline"
            className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase"
          >
            {params.value}
          </Badge>
        ),
      },
      {
        headerName: "Agent / Scope ID",
        width: 160,
        minWidth: 120,
        valueGetter: (params) => {
          const d = params.data;
          if (!d) return "—";
          if (d.scope === "agent" && d.scopeId)
            return agentMap.get(d.scopeId) ?? `${d.scopeId.slice(0, 8)}...`;
          if (d.scope === "repo" && d.scopeId) return `${d.scopeId.slice(0, 8)}...`;
          return "—";
        },
      },
      {
        field: "key",
        headerName: "Key",
        width: 200,
        minWidth: 140,
        cellRenderer: (params: { value: string }) => (
          <span className="font-mono select-text">{params.value}</span>
        ),
      },
      {
        field: "value",
        headerName: "Value",
        flex: 1,
        minWidth: 200,
        cellRenderer: (params: ICellRendererParams<SwarmConfig>) => {
          const cfg = params.data;
          if (!cfg) return null;
          if (cfg.isSecret) {
            return <span className="font-mono text-muted-foreground">••••••••</span>;
          }
          return <span className="font-mono truncate select-text">{cfg.value}</span>;
        },
      },
      {
        field: "description",
        headerName: "Description",
        width: 200,
        minWidth: 120,
        cellRenderer: (params: { value: string | null }) => (
          <span className="text-muted-foreground truncate">{params.value ?? "—"}</span>
        ),
      },
      {
        headerName: "",
        width: 100,
        minWidth: 100,
        sortable: false,
        cellRenderer: (params: ICellRendererParams<SwarmConfig>) => {
          const cfg = params.data;
          if (!cfg) return null;
          return (
            <div className="flex items-center gap-1">
              <Button
                size="icon"
                variant="outline"
                className="h-7 w-7 border-border/60"
                onClick={(e) => {
                  e.stopPropagation();
                  handleEdit(cfg);
                }}
              >
                <Pencil className="h-3 w-3" />
              </Button>
              <Button
                size="icon"
                variant="outline"
                className="h-7 w-7 border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleteTarget(cfg);
                }}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          );
        },
      },
    ],
    [agentMap, handleEdit],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Swarm Configuration</h2>
        <Button onClick={handleAdd} size="sm" className="gap-1 bg-primary hover:bg-primary/90">
          <Plus className="h-3.5 w-3.5" /> Add Entry
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <Select value={scopeFilter} onValueChange={setScopeFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Scopes</SelectItem>
            <SelectItem value="global">Global</SelectItem>
            <SelectItem value="agent">Agent</SelectItem>
            <SelectItem value="repo">Repo</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <DataGrid
        rowData={filteredConfigs ?? []}
        columnDefs={columnDefs}
        onRowClicked={onRowClicked}
        loading={isLoading}
        emptyMessage="No configuration entries"
        domLayout="autoHeight"
        enableCellTextSelection
      />

      <ConfigDetailDialog
        config={detailEntry}
        onOpenChange={(open) => !open && setDetailEntry(null)}
        agentName={detailEntry?.scopeId ? agentMap.get(detailEntry.scopeId) : undefined}
      />

      <ConfigEntryDialog
        key={editEntry?.id ?? "new"}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editEntry={editEntry}
        onSubmit={handleSubmit}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Config Entry</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete{" "}
              <strong className="font-mono">{deleteTarget?.key}</strong>? This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connection Form Dialog — add/edit a connection
// ---------------------------------------------------------------------------

interface ConnectionFormState {
  name: string;
  apiUrl: string;
  apiKey: string;
}

function ConnectionFormDialog({
  open,
  onOpenChange,
  editConnection,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editConnection: Connection | null;
  onSubmit: (data: ConnectionFormState) => void;
}) {
  const [form, setForm] = useState<ConnectionFormState>(() =>
    editConnection
      ? { name: editConnection.name, apiUrl: editConnection.apiUrl, apiKey: editConnection.apiKey }
      : { name: "", apiUrl: "http://localhost:3013", apiKey: "" },
  );
  const [showKey, setShowKey] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [placeholder] = useState(() => generateSlug());

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setErrorMsg("");

    try {
      const url = form.apiUrl.replace(/\/+$/, "");
      const res = await fetch(`${url}/health`, {
        headers: form.apiKey ? { Authorization: `Bearer ${form.apiKey}` } : {},
      });
      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`);
      }
      await res.json();
      onSubmit({ ...form, name: form.name || placeholder, apiUrl: url });
      onOpenChange(false);
      setStatus("idle");
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Connection failed");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{editConnection ? "Edit Connection" : "Add Connection"}</DialogTitle>
            <DialogDescription>
              {editConnection
                ? "Update connection settings. A health check will run on save."
                : "Add a new API server connection. A health check will verify the connection."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="conn-name">Name (optional)</Label>
              <Input
                id="conn-name"
                placeholder={placeholder}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="conn-url">API URL</Label>
              <Input
                id="conn-url"
                type="url"
                placeholder="http://localhost:3013"
                value={form.apiUrl}
                onChange={(e) => setForm({ ...form, apiUrl: e.target.value })}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="conn-key">API Key</Label>
              <div className="flex gap-1">
                <Input
                  id="conn-key"
                  type={showKey ? "text" : "password"}
                  placeholder="Enter your API key"
                  value={form.apiKey}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                  required
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="shrink-0"
                  onClick={() => setShowKey(!showKey)}
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            {status === "error" && (
              <Alert variant="destructive">
                <XCircle className="h-4 w-4" />
                <AlertDescription>{errorMsg}</AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={status === "loading" || !form.apiUrl || !form.apiKey}
              className="bg-primary hover:bg-primary/90"
            >
              {status === "loading" ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Checking...
                </>
              ) : editConnection ? (
                "Save"
              ) : (
                "Connect"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Connection Card — single connection in the list
// ---------------------------------------------------------------------------

function ConnectionCard({
  connection,
  isActive,
  onActivate,
  onEdit,
  onDelete,
}: {
  connection: Connection;
  isActive: boolean;
  onActivate: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [testStatus, setTestStatus] = useState<"idle" | "loading" | "success" | "error">("idle");

  async function handleTest() {
    setTestStatus("loading");
    try {
      const url = connection.apiUrl.replace(/\/+$/, "");
      const res = await fetch(`${url}/health`, {
        headers: connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {},
      });
      if (!res.ok) throw new Error();
      await res.json();
      setTestStatus("success");
      setTimeout(() => setTestStatus("idle"), 3000);
    } catch {
      setTestStatus("error");
      setTimeout(() => setTestStatus("idle"), 3000);
    }
  }

  return (
    <Card className={`border-border ${isActive ? "ring-1 ring-primary/50 border-primary/30" : ""}`}>
      <CardContent className="flex items-center gap-4 py-4">
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate">{connection.name}</span>
            {isActive && (
              <Badge
                variant="outline"
                className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase border-primary/30 text-primary"
              >
                active
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground font-mono truncate">{connection.apiUrl}</p>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {/* Test / Connect */}
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            onClick={isActive ? handleTest : onActivate}
            disabled={testStatus === "loading"}
          >
            {testStatus === "loading" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : testStatus === "success" ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
            ) : testStatus === "error" ? (
              <XCircle className="h-3.5 w-3.5 text-red-400" />
            ) : (
              <Signal className="h-3.5 w-3.5" />
            )}
            {isActive ? "Test" : "Connect"}
          </Button>

          {/* Edit */}
          <Button
            size="icon"
            variant="outline"
            className="h-8 w-8 border-border/60"
            onClick={onEdit}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>

          {/* Delete */}
          <Button
            size="icon"
            variant="outline"
            className="h-8 w-8 border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300"
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Connections Section — multi-connection management
// ---------------------------------------------------------------------------

function ConnectionsSection() {
  const {
    connections,
    activeConnection,
    switchConnection,
    addConnection,
    updateConnection,
    removeConnection,
    resetConfig,
  } = useConfig();
  const navigate = useNavigate();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Connection | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Connection | null>(null);

  function handleAdd() {
    setEditTarget(null);
    setDialogOpen(true);
  }

  function handleEdit(conn: Connection) {
    setEditTarget(conn);
    setDialogOpen(true);
  }

  function handleSubmit(data: ConnectionFormState) {
    if (editTarget) {
      updateConnection(editTarget.id, {
        name: data.name,
        apiUrl: data.apiUrl,
        apiKey: data.apiKey,
      });
    } else {
      const created = addConnection({
        name: data.name,
        apiUrl: data.apiUrl,
        apiKey: data.apiKey,
      });
      // If first connection, set active and go to dashboard
      if (connections.length === 0) {
        switchConnection(created.id);
        navigate("/");
      }
    }
    setEditTarget(null);
  }

  function handleDelete() {
    if (!deleteTarget) return;

    // If this is the last connection, clear everything
    if (connections.length === 1) {
      resetConfig();
      setDeleteTarget(null);
      return;
    }

    // Can't delete the active connection if there are others — switch first
    if (activeConnection?.id === deleteTarget.id) {
      const other = connections.find((c) => c.id !== deleteTarget.id);
      if (other) switchConnection(other.id);
    }

    removeConnection(deleteTarget.id);
    setDeleteTarget(null);
  }

  function handleActivate(id: string) {
    switchConnection(id);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Connections</h2>
        <Button onClick={handleAdd} size="sm" className="gap-1 bg-primary hover:bg-primary/90">
          <Plus className="h-3.5 w-3.5" /> Add Connection
        </Button>
      </div>

      <div className="space-y-3">
        {connections.map((conn) => (
          <ConnectionCard
            key={conn.id}
            connection={conn}
            isActive={activeConnection?.id === conn.id}
            onActivate={() => handleActivate(conn.id)}
            onEdit={() => handleEdit(conn)}
            onDelete={() => setDeleteTarget(conn)}
          />
        ))}
      </div>

      <ConnectionFormDialog
        key={editTarget?.id ?? "new"}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editConnection={editTarget}
        onSubmit={handleSubmit}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Connection</AlertDialogTitle>
            <AlertDialogDescription>
              {connections.length === 1 ? (
                <>
                  This is your only connection. Deleting it will clear all settings and return you
                  to the setup screen.
                </>
              ) : (
                <>
                  Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? This action
                  cannot be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unconfigured Welcome Card — shown when no connections exist
// ---------------------------------------------------------------------------

function WelcomeCard() {
  const { addConnection, switchConnection } = useConfig();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [apiUrl, setApiUrl] = useState("http://localhost:3013");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [placeholder] = useState(() => generateSlug());

  function handleCopyApiKey() {
    navigator.clipboard.writeText(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleConnect() {
    setStatus("loading");
    setErrorMsg("");

    try {
      const url = apiUrl.replace(/\/+$/, "");
      const res = await fetch(`${url}/health`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`);
      }
      await res.json();

      const created = addConnection({
        name: name || placeholder,
        apiUrl: url,
        apiKey,
      });
      switchConnection(created.id);
      setStatus("success");

      setTimeout(() => navigate("/"), 500);
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Connection failed");
    }
  }

  return (
    <div className="flex min-h-[80vh] items-center justify-center">
      <Card className="w-full max-w-md border-border">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center">
            <Hexagon className="h-10 w-10 text-primary" />
          </div>
          <CardTitle className="text-xl font-semibold">Agent Swarm</CardTitle>
          <CardDescription>Connect to your Agent Swarm API server to get started.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="welcome-name">Connection Name (optional)</Label>
            <Input
              id="welcome-name"
              placeholder={placeholder}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="welcome-url">API URL</Label>
            <Input
              id="welcome-url"
              type="url"
              placeholder="http://localhost:3013"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              disabled={status === "loading"}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="welcome-key">API Key</Label>
            <div className="flex gap-1">
              <Input
                id="welcome-key"
                type={showApiKey ? "text" : "password"}
                placeholder="Enter your API key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={status === "loading"}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleConnect();
                }}
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="shrink-0"
                onClick={() => setShowApiKey(!showApiKey)}
              >
                {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="shrink-0"
                onClick={handleCopyApiKey}
                disabled={!apiKey}
              >
                {copied ? (
                  <Check className="h-4 w-4 text-emerald-400" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>

          {status === "error" && (
            <Alert variant="destructive">
              <XCircle className="h-4 w-4" />
              <AlertDescription>{errorMsg}</AlertDescription>
            </Alert>
          )}

          {status === "success" && (
            <Alert className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              <AlertDescription>Connected! Redirecting to dashboard...</AlertDescription>
            </Alert>
          )}

          <Button
            onClick={handleConnect}
            disabled={status === "loading" || !apiUrl || !apiKey}
            className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {status === "loading" ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Connecting...
              </>
            ) : (
              "Connect"
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main ConfigPage
// ---------------------------------------------------------------------------

export default function ConfigPage() {
  const { isConfigured } = useConfig();

  if (!isConfigured) {
    return <WelcomeCard />;
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-8">
      <h1 className="text-xl font-semibold">Settings</h1>

      {/* Multi-connection management */}
      <ConnectionsSection />

      {/* Swarm Config CRUD (operates on active connection's API) */}
      <SwarmConfigSection />
    </div>
  );
}
