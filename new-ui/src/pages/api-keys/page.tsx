import type { ColDef } from "ag-grid-community";
import { BarChart3, DollarSign, Key, Pencil, Search, ShieldAlert, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { useApiKeyCosts, useApiKeyStatuses, useSetApiKeyName } from "@/api/hooks/use-api-keys";
import type { ApiKeyStatus, ApiKeyStatusType } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn, formatSmartTime } from "@/lib/utils";

const statusConfig: Record<ApiKeyStatusType, { label: string; dot: string; text: string }> = {
  available: {
    label: "AVAILABLE",
    dot: "bg-emerald-500",
    text: "text-emerald-600 dark:text-emerald-400",
  },
  rate_limited: {
    label: "RATE LIMITED",
    dot: "bg-red-500",
    text: "text-red-600 dark:text-red-400",
  },
};

function KeyStatusBadge({ status }: { status: ApiKeyStatusType }) {
  const config = statusConfig[status] ?? {
    label: status,
    dot: "bg-zinc-400",
    text: "text-zinc-500",
  };
  return (
    <Badge
      variant="outline"
      className="gap-1.5 text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center"
    >
      <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", config.dot)} />
      <span className={config.text}>{config.label}</span>
    </Badge>
  );
}

function formatKeyType(keyType: string): string {
  if (keyType === "ANTHROPIC_API_KEY") return "Anthropic";
  if (keyType === "CLAUDE_CODE_OAUTH_TOKEN") return "OAuth";
  if (keyType === "OPENROUTER_API_KEY") return "OpenRouter";
  if (keyType === "OPENAI_API_KEY") return "OpenAI";
  if (keyType === "CODEX_OAUTH") return "codex-oauth";
  return keyType;
}

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  pi: "pi-mono",
  codex: "Codex",
};

function formatProvider(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

const PROVIDER_BADGE_TONE: Record<string, string> = {
  claude: "text-amber-600 dark:text-amber-400",
  pi: "text-violet-600 dark:text-violet-400",
  codex: "text-emerald-600 dark:text-emerald-400",
};

function formatExpiry(until: string | null): string {
  if (!until) return "-";
  const d = new Date(until);
  if (d <= new Date()) return "Expired";
  const diff = d.getTime() - Date.now();
  const mins = Math.floor(diff / 60000);
  const secs = Math.floor((diff % 60000) / 1000);
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

export default function ApiKeysPage() {
  const { data: keys, isLoading } = useApiKeyStatuses();
  const { data: costs } = useApiKeyCosts();
  const setKeyName = useSetApiKeyName();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [providerFilter, setProviderFilter] = useState<string>("all");
  // Dialog state for renaming a single key. Decoupled from AG Grid edit
  // mode (which has too many gotchas around cell focus / suppressCellFocus
  // / cellRenderer click forwarding) — clicking the pencil icon opens this
  // dialog directly and the mutation flows through useSetApiKeyName.
  const [editingKey, setEditingKey] = useState<ApiKeyStatus | null>(null);
  const [editingName, setEditingName] = useState("");

  const handleSaveName = () => {
    if (!editingKey) return;
    const trimmed = editingName.trim();
    setKeyName.mutate({
      keyType: editingKey.keyType,
      keySuffix: editingKey.keySuffix,
      scope: editingKey.scope,
      scopeId: editingKey.scopeId,
      name: trimmed.length > 0 ? trimmed : null,
    });
    setEditingKey(null);
    setEditingName("");
  };

  const costMap = useMemo(() => {
    if (!costs) return new Map<string, number>();
    const map = new Map<string, number>();
    for (const c of costs) {
      map.set(`${c.keyType}:${c.keySuffix}`, c.totalCost);
    }
    return map;
  }, [costs]);

  const keyTypes = useMemo(() => {
    if (!keys) return [];
    return [...new Set(keys.map((k) => k.keyType))];
  }, [keys]);

  const providers = useMemo(() => {
    if (!keys) return [];
    return [...new Set(keys.map((k) => k.provider))].sort();
  }, [keys]);

  const filteredKeys = useMemo(() => {
    if (!keys) return [];
    return keys.filter((k) => {
      if (statusFilter !== "all" && k.status !== statusFilter) return false;
      if (typeFilter !== "all" && k.keyType !== typeFilter) return false;
      if (providerFilter !== "all" && k.provider !== providerFilter) return false;
      return true;
    });
  }, [keys, statusFilter, typeFilter, providerFilter]);

  const stats = useMemo(() => {
    const totalCost = costs ? costs.reduce((sum, c) => sum + c.totalCost, 0) : 0;
    if (!keys) return { total: 0, available: 0, rateLimited: 0, totalUsage: 0, totalCost };
    return {
      total: keys.length,
      available: keys.filter((k) => k.status === "available").length,
      rateLimited: keys.filter((k) => k.status === "rate_limited").length,
      totalUsage: keys.reduce((sum, k) => sum + k.totalUsageCount, 0),
      totalCost,
    };
  }, [keys, costs]);

  const columnDefs = useMemo<ColDef<ApiKeyStatus>[]>(
    () => [
      {
        field: "name",
        headerName: "Name",
        flex: 1,
        minWidth: 200,
        // Pass empty cells through quickFilterText so AG Grid's search matches
        // the row even when the user hasn't labeled the key yet (it falls back
        // to the rest of the columns).
        valueFormatter: (params) => params.value ?? "",
        cellRenderer: (params: { value: string | null; data: ApiKeyStatus | undefined }) => {
          const handleClick = (e: React.MouseEvent) => {
            // Stop propagation so the AG Grid row click handler doesn't fire
            // (the API Keys page doesn't have one today, but defensive).
            e.stopPropagation();
            if (!params.data) return;
            setEditingKey(params.data);
            setEditingName(params.value ?? "");
          };
          return (
            <button
              type="button"
              onClick={handleClick}
              className="flex items-center justify-between gap-2 w-full text-left hover:bg-muted/40 rounded px-1 -mx-1"
            >
              {params.value ? (
                <span className="text-xs truncate">{params.value}</span>
              ) : (
                <span className="text-xs italic text-muted-foreground/50">click to name…</span>
              )}
              <Pencil className="h-3 w-3 text-muted-foreground/50 shrink-0" />
            </button>
          );
        },
      },
      {
        field: "provider",
        headerName: "Provider",
        width: 110,
        cellRenderer: (params: { value: string }) => (
          <Badge variant="outline" size="tag">
            <span className={cn("font-mono", PROVIDER_BADGE_TONE[params.value])}>
              {formatProvider(params.value)}
            </span>
          </Badge>
        ),
      },
      {
        field: "keyType",
        headerName: "Type",
        width: 140,
        cellRenderer: (params: { value: string }) => (
          <Badge variant="outline" size="tag" className="font-mono">
            {formatKeyType(params.value)}
          </Badge>
        ),
      },
      {
        field: "keySuffix",
        headerName: "Key Suffix",
        width: 120,
        cellRenderer: (params: { value: string }) => (
          <span className="font-mono text-muted-foreground">...{params.value}</span>
        ),
      },
      {
        field: "keyIndex",
        headerName: "Index",
        width: 80,
        cellRenderer: (params: { value: number }) => (
          <span className="font-mono text-xs">{params.value}</span>
        ),
      },
      {
        field: "status",
        headerName: "Status",
        width: 140,
        cellRenderer: (params: { value: ApiKeyStatusType }) => (
          <KeyStatusBadge status={params.value} />
        ),
      },
      {
        field: "rateLimitedUntil",
        headerName: "Rate Limit Expiry",
        width: 150,
        cellRenderer: (params: { value: string | null; data: ApiKeyStatus | undefined }) => {
          if (params.data?.status !== "rate_limited")
            return <span className="text-muted-foreground">-</span>;
          return (
            <span className="text-xs font-mono text-red-400">{formatExpiry(params.value)}</span>
          );
        },
      },
      {
        field: "totalUsageCount",
        headerName: "Usage",
        width: 90,
        cellRenderer: (params: { value: number }) => (
          <span className="font-mono text-xs">{params.value.toLocaleString()}</span>
        ),
      },
      {
        field: "rateLimitCount",
        headerName: "Rate Limits",
        width: 110,
        cellRenderer: (params: { value: number }) => (
          <span className={cn("font-mono text-xs", params.value > 0 && "text-red-400")}>
            {params.value}
          </span>
        ),
      },
      {
        headerName: "Cost",
        width: 100,
        valueGetter: (params) => {
          if (!params.data) return 0;
          return costMap.get(`${params.data.keyType}:${params.data.keySuffix}`) ?? 0;
        },
        cellRenderer: (params: { value: number }) => (
          <span className="font-mono text-xs">
            {params.value > 0 ? `$${params.value.toFixed(4)}` : "-"}
          </span>
        ),
      },
      {
        field: "lastUsedAt",
        headerName: "Last Used",
        flex: 1,
        minWidth: 140,
        cellRenderer: (params: { value: string | null }) =>
          params.value ? (
            <span className="text-xs text-muted-foreground">{formatSmartTime(params.value)}</span>
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
      },
    ],
    [costMap],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <h1 className="text-xl font-semibold">API Keys</h1>

      {/* Summary cards */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
        <Card>
          <CardContent className="p-3 flex items-center gap-3">
            <div className="rounded-md bg-muted p-2">
              <Key className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total Keys</p>
              <p className="text-lg font-semibold">{stats.total}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 flex items-center gap-3">
            <div className="rounded-md bg-emerald-500/10 p-2">
              <ShieldCheck className="h-4 w-4 text-emerald-500" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Available</p>
              <p className="text-lg font-semibold text-emerald-500">{stats.available}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 flex items-center gap-3">
            <div className="rounded-md bg-red-500/10 p-2">
              <ShieldAlert className="h-4 w-4 text-red-500" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Rate Limited</p>
              <p className="text-lg font-semibold text-red-500">{stats.rateLimited}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 flex items-center gap-3">
            <div className="rounded-md bg-muted p-2">
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total Usage</p>
              <p className="text-lg font-semibold">{stats.totalUsage.toLocaleString()}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 flex items-center gap-3">
            <div className="rounded-md bg-muted p-2">
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total Cost</p>
              <p className="text-lg font-semibold">${stats.totalCost.toFixed(2)}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by name, suffix, type…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={providerFilter} onValueChange={setProviderFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Provider" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Providers</SelectItem>
            {providers.map((p) => (
              <SelectItem key={p} value={p}>
                {formatProvider(p)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="available">Available</SelectItem>
            <SelectItem value="rate_limited">Rate Limited</SelectItem>
          </SelectContent>
        </Select>
        {keyTypes.length > 1 && (
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Key Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              {keyTypes.map((kt) => (
                <SelectItem key={kt} value={kt}>
                  {formatKeyType(kt)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Data grid */}
      <DataGrid
        rowData={filteredKeys}
        columnDefs={columnDefs}
        quickFilterText={search}
        loading={isLoading}
        emptyMessage="No API keys tracked yet"
      />

      {/* Rename dialog */}
      <Dialog
        open={editingKey !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditingKey(null);
            setEditingName("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename API Key</DialogTitle>
          </DialogHeader>
          {editingKey && (
            <div className="space-y-3 py-2">
              <div className="text-xs text-muted-foreground space-y-1">
                <div>
                  <span className="font-mono uppercase">{formatProvider(editingKey.provider)}</span>
                  {" · "}
                  <span className="font-mono">{formatKeyType(editingKey.keyType)}</span>
                  {" · "}
                  <span className="font-mono">...{editingKey.keySuffix}</span>
                </div>
              </div>
              <Input
                autoFocus
                placeholder="e.g. Personal OAuth, Work Anthropic, …"
                value={editingName}
                maxLength={60}
                onChange={(e) => setEditingName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleSaveName();
                  } else if (e.key === "Escape") {
                    setEditingKey(null);
                    setEditingName("");
                  }
                }}
              />
              <p className="text-[10px] text-muted-foreground">
                Leave empty to clear the label. Max 60 characters.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEditingKey(null);
                setEditingName("");
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleSaveName} disabled={setKeyName.isPending}>
              {setKeyName.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
