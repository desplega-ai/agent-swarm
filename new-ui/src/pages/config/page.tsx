import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useConfig } from "@/hooks/use-config";
import { useConfigs, useUpsertConfig, useDeleteConfig } from "@/api/hooks/use-swarm-config";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, CheckCircle2, XCircle, Hexagon, Plus, Pencil, Trash2, Eye, EyeOff, Settings } from "lucide-react";
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
  const [form, setForm] = useState<ConfigFormData>(
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
                onValueChange={(v) => setForm({ ...form, scope: v as SwarmConfigScope })}
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
            {form.scope !== "global" && (
              <div className="space-y-2">
                <Label>Scope ID</Label>
                <Input
                  placeholder={form.scope === "agent" ? "Agent UUID" : "Repo UUID"}
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
            <Button type="submit" className="bg-amber-600 hover:bg-amber-700">
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
  const upsertConfig = useUpsertConfig();
  const deleteConfig = useDeleteConfig();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editEntry, setEditEntry] = useState<SwarmConfig | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
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

  function handleDelete(id: string) {
    deleteConfig.mutate(id);
    setDeleteConfirm(null);
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Swarm Configuration</h2>
        <Button onClick={handleAdd} size="sm" className="gap-1 bg-amber-600 hover:bg-amber-700">
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

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-4 text-center">Loading configs...</div>
      ) : filteredConfigs && filteredConfigs.length > 0 ? (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Scope</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-[100px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredConfigs.map((cfg) => (
                <TableRow key={cfg.id}>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px]">
                      {cfg.scope}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-sm">{cfg.key}</TableCell>
                  <TableCell className="font-mono text-sm max-w-[200px] truncate">
                    {cfg.isSecret ? (
                      <div className="flex items-center gap-1">
                        <span>
                          {revealedSecrets.has(cfg.id) ? cfg.value : "••••••••"}
                        </span>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6"
                          onClick={() => toggleReveal(cfg.id)}
                        >
                          {revealedSecrets.has(cfg.id) ? (
                            <EyeOff className="h-3 w-3" />
                          ) : (
                            <Eye className="h-3 w-3" />
                          )}
                        </Button>
                      </div>
                    ) : (
                      cfg.value
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">
                    {cfg.description ?? "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => handleEdit(cfg)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      {deleteConfirm === cfg.id ? (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-red-400 hover:text-red-300"
                          onClick={() => handleDelete(cfg.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      ) : (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => setDeleteConfirm(cfg.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
          <Settings className="h-6 w-6 mb-2" />
          <p className="text-sm">No configuration entries</p>
        </div>
      )}

      <ConfigEntryDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editEntry={editEntry}
        onSubmit={handleSubmit}
      />
    </div>
  );
}

export default function ConfigPage() {
  const { config, setConfig, resetConfig, isConfigured } = useConfig();
  const navigate = useNavigate();

  const [apiUrl, setApiUrl] = useState(config.apiUrl);
  const [apiKey, setApiKey] = useState(config.apiKey);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

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
        <Card className="w-full max-w-md border-amber-500/20">
          <CardHeader className="text-center">
            <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center">
              <Hexagon className="h-10 w-10 text-amber-500" />
            </div>
            <CardTitle className="font-display text-xl">Agent Swarm</CardTitle>
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
              <Input
                id="api-key"
                type="password"
                placeholder="Enter your API key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={status === "loading"}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleConnect();
                }}
              />
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
              className="w-full bg-amber-600 text-white hover:bg-amber-700"
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
    <div className="space-y-8">
      <h1 className="font-display text-2xl font-bold">Settings</h1>

      {/* Connection Settings */}
      <Card className="border-amber-500/20">
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
              <Input
                id="api-key-cfg"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={status === "loading"}
              />
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
              className="bg-amber-600 text-white hover:bg-amber-700"
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
