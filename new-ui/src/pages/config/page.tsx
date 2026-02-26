import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { useConfig } from "@/hooks/use-config";
import { useConfigs, useUpsertConfig, useDeleteConfig } from "@/api/hooks/use-config-api";
import { useAgents } from "@/api/hooks/use-agents";
import { DataGrid } from "@/components/shared/data-grid";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Loader2, CheckCircle2, XCircle, Hexagon, Plus, Pencil, Trash2, Eye, EyeOff, Copy, Check } from "lucide-react";
import type { SwarmConfig, SwarmConfigScope } from "@/api/types";

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
  const [form, setForm] = useState<ConfigFormData>(emptyConfigForm);

  useEffect(() => {
    if (open) {
      setForm(
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
    }
  }, [editEntry, open]);

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
                onValueChange={(v) => setForm({ ...form, scope: v as SwarmConfigScope, scopeId: "" })}
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

function SwarmConfigSection() {
  const { data: configs, isLoading } = useConfigs();
  const { data: agents } = useAgents();
  const upsertConfig = useUpsertConfig();
  const deleteConfig = useDeleteConfig();

  const agentMap = useMemo(() => {
    const m = new Map<string, string>();
    agents?.forEach((a) => m.set(a.id, a.name));
    return m;
  }, [agents]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editEntry, setEditEntry] = useState<SwarmConfig | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SwarmConfig | null>(null);
  const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(new Set());
  const [scopeFilter, setScopeFilter] = useState<string>("all");

  function handleAdd() {
    setEditEntry(null);
    setDialogOpen(true);
  }

  function handleEdit(entry: SwarmConfig) {
    setEditEntry(entry);
    setDialogOpen(true);
  }

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

  function toggleReveal(id: string) {
    setRevealedSecrets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const filteredConfigs =
    scopeFilter === "all" ? configs : configs?.filter((c) => c.scope === scopeFilter);

  const columnDefs = useMemo<ColDef<SwarmConfig>[]>(
    () => [
      {
        field: "scope",
        headerName: "Scope",
        width: 100,
        cellRenderer: (params: { value: string }) => (
          <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase">
            {params.value}
          </Badge>
        ),
      },
      {
        headerName: "Agent / Scope ID",
        width: 150,
        valueGetter: (params) => {
          const d = params.data;
          if (!d) return "—";
          if (d.scope === "agent" && d.scopeId)
            return agentMap.get(d.scopeId) ?? d.scopeId.slice(0, 8) + "...";
          if (d.scope === "repo" && d.scopeId)
            return d.scopeId.slice(0, 8) + "...";
          return "—";
        },
      },
      {
        field: "key",
        headerName: "Key",
        width: 180,
        cellRenderer: (params: { value: string }) => (
          <span className="font-mono">{params.value}</span>
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
            const revealed = revealedSecrets.has(cfg.id);
            return (
              <div className="flex items-center gap-1 font-mono">
                <span>{revealed ? cfg.value : "••••••••"}</span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleReveal(cfg.id);
                  }}
                >
                  {revealed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                </Button>
              </div>
            );
          }
          return <span className="font-mono">{cfg.value}</span>;
        },
      },
      {
        field: "description",
        headerName: "Description",
        width: 200,
        cellRenderer: (params: { value: string | null }) => (
          <span className="text-muted-foreground">{params.value ?? "—"}</span>
        ),
      },
      {
        headerName: "",
        width: 100,
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
    [agentMap, revealedSecrets, deleteTarget],
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
        loading={isLoading}
        emptyMessage="No configuration entries"
        domLayout="autoHeight"
      />

      <ConfigEntryDialog
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
              Are you sure you want to delete <strong className="font-mono">{deleteTarget?.key}</strong>? This action cannot be undone.
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

export default function ConfigPage() {
  const { config, setConfig, resetConfig, isConfigured } = useConfig();
  const navigate = useNavigate();

  const [apiUrl, setApiUrl] = useState(config.apiUrl);
  const [apiKey, setApiKey] = useState(config.apiKey);
  const [showApiKey, setShowApiKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

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

      setConfig({ apiUrl: url, apiKey });
      setStatus("success");

      setTimeout(() => navigate("/"), 500);
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Connection failed");
    }
  }

  function handleDisconnect() {
    resetConfig();
    setApiUrl("http://localhost:3013");
    setApiKey("");
    setStatus("idle");
  }

  // If not configured, show the connect card centered
  if (!isConfigured) {
    return (
      <div className="flex min-h-[80vh] items-center justify-center">
        <Card className="w-full max-w-md border-border">
          <CardHeader className="text-center">
            <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center">
              <Hexagon className="h-10 w-10 text-primary" />
            </div>
            <CardTitle className="text-xl font-semibold">Agent Swarm</CardTitle>
            <CardDescription>
              Connect to your Agent Swarm API server to get started.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="api-url">API URL</Label>
              <Input
                id="api-url"
                type="url"
                placeholder="http://localhost:3013"
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                disabled={status === "loading"}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="api-key">API Key</Label>
              <div className="flex gap-1">
                <Input
                  id="api-key"
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
                  {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
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
              disabled={status === "loading" || !apiUrl}
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

  // Configured: show connection settings + swarm config CRUD
  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-8">
      <h1 className="text-xl font-semibold">Settings</h1>

      {/* Connection Settings */}
      <Card className="border-border">
        <CardHeader>
          <CardTitle className="text-lg">Connection</CardTitle>
          <CardDescription>API server connection settings.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="api-url-cfg">API URL</Label>
              <Input
                id="api-url-cfg"
                type="url"
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                disabled={status === "loading"}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="api-key-cfg">API Key</Label>
              <div className="flex gap-1">
                <Input
                  id="api-key-cfg"
                  type={showApiKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  disabled={status === "loading"}
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
                  {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
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
              <AlertDescription>Connected!</AlertDescription>
            </Alert>
          )}

          <div className="flex gap-2">
            <Button
              onClick={handleConnect}
              disabled={status === "loading" || !apiUrl}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {status === "loading" ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Reconnecting...
                </>
              ) : (
                "Reconnect"
              )}
            </Button>
            <Button variant="outline" onClick={handleDisconnect}>
              Disconnect
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Swarm Config CRUD */}
      <SwarmConfigSection />
    </div>
  );
}
