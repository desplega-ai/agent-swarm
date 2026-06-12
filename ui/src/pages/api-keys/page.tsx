import type { ColDef } from "ag-grid-community";
import {
  BarChart3,
  DollarSign,
  Key,
  Pencil,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  useApiKeyCosts,
  useApiKeyStatuses,
  useClearApiKeyRateLimit,
  useSetApiKeyName,
} from "@/api/hooks/use-api-keys";
import type { ApiKeyStatus, ApiKeyStatusType } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { HarnessIcon } from "@/components/shared/harness-icon";
import { ProviderIcon } from "@/components/shared/provider-icon";
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
import { PageHeader } from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatPanel } from "@/components/ui/stat-panel";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { formatCost } from "@/lib/cost-format";
import { cn, formatSmartTime } from "@/lib/utils";

const statusConfig: Record<ApiKeyStatusType, { label: string; dot: string; text: string }> = {
  available: {
    label: "AVAILABLE",
    dot: "bg-status-success",
    text: "text-status-success-strong",
  },
  rate_limited: {
    label: "RATE LIMITED",
    dot: "bg-status-error",
    text: "text-status-error-strong",
  },
};

function KeyStatusBadge({ status }: { status: ApiKeyStatusType }) {
  const config = statusConfig[status] ?? {
    label: status,
    dot: "bg-status-neutral",
    text: "text-status-neutral",
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

type KeyTypeMeta = { label: string; icon: "anthropic" | "openai" | "openrouter" | null };

const KEY_TYPE_META: Record<string, KeyTypeMeta> = {
  ANTHROPIC_API_KEY: { label: "Anthropic API Key", icon: "anthropic" },
  CLAUDE_CODE_OAUTH_TOKEN: { label: "Claude OAuth", icon: "anthropic" },
  OPENROUTER_API_KEY: { label: "OpenRouter API Key", icon: "openrouter" },
  OPENAI_API_KEY: { label: "OpenAI API Key", icon: "openai" },
  CODEX_OAUTH: { label: "Codex OAuth", icon: "openai" },
};

function getKeyTypeMeta(keyType: string): KeyTypeMeta {
  return KEY_TYPE_META[keyType] ?? { label: keyType, icon: null };
}

function formatKeyType(keyType: string): string {
  return getKeyTypeMeta(keyType).label;
}

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  "claude-managed": "Claude (managed)",
  pi: "Pi-Mono",
  codex: "Codex",
  devin: "Devin",
  opencode: "Opencode",
};

function formatProvider(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

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

function formatResetAt(resetsAt: number | undefined): string {
  if (!resetsAt) return "";
  return new Date(resetsAt * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function RateLimitWindowsCell({
  windows,
}: {
  windows: ApiKeyStatus["rateLimitWindows"] | undefined;
}) {
  const entries = Object.entries(windows ?? {});
  if (entries.length === 0) return <span className="text-muted-foreground">-</span>;

  return (
    <div className="flex flex-col gap-1 py-1">
      {entries.map(([type, info]) => (
        <div key={type} className="flex min-w-0 items-center gap-1.5 text-[11px] leading-tight">
          <span className="font-mono text-muted-foreground">{type}</span>
          <span className={cn("font-medium", info.status === "rejected" && "text-status-error")}>
            {info.status}
          </span>
          {typeof info.utilization === "number" && (
            <span className="font-mono">{Math.round(info.utilization * 100)}%</span>
          )}
          {info.resetsAt && (
            <span className="truncate text-muted-foreground">
              resets {formatResetAt(info.resetsAt)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export default function ApiKeysPage() {
  const { data: keys, isLoading } = useApiKeyStatuses();
  const { data: costs } = useApiKeyCosts();
  const setKeyName = useSetApiKeyName();
  const clearRateLimit = useClearApiKeyRateLimit();
  const { searchParams, setParam } = useUrlSearchState();
  const search = readStringParam(searchParams, "search");
  const statusFilter = readStringParam(searchParams, "status", "all");
  const typeFilter = readStringParam(searchParams, "type", "all");
  const providerFilter = readStringParam(searchParams, "provider", "all");
  // Dialog state for renaming a single key. Decoupled from AG Grid edit
  // mode (which has too many gotchas around cell focus / suppressCellFocus
  // / cellRenderer click forwarding) — clicking the pencil icon opens this
  // dialog directly and the mutation flows through useSetApiKeyName.
  const [editingKey, setEditingKey] = useState<ApiKeyStatus | null>(null);
  const [editingName, setEditingName] = useState("");
  const [clearingKey, setClearingKey] = useState<ApiKeyStatus | null>(null);

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

  const handleClearRateLimit = () => {
    if (!clearingKey) return;
    clearRateLimit.mutate(
      {
        keyType: clearingKey.keyType,
        keySuffix: clearingKey.keySuffix,
        scope: clearingKey.scope,
        scopeId: clearingKey.scopeId,
      },
      {
        onSuccess: (result) => {
          toast.success(result.message || `Rate limit cleared for ...${clearingKey.keySuffix}`);
          setClearingKey(null);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "Failed to clear rate limit");
        },
      },
    );
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
        width: 140,
        cellRenderer: (params: { value: string }) => (
          <span className="inline-flex items-center gap-1.5 text-foreground">
            <HarnessIcon harness={params.value} />
            <span>{formatProvider(params.value)}</span>
          </span>
        ),
      },
      {
        field: "keyType",
        headerName: "Type",
        width: 180,
        cellRenderer: (params: { value: string }) => {
          const meta = getKeyTypeMeta(params.value);
          return (
            <span className="inline-flex items-center gap-1.5 text-foreground">
              <ProviderIcon provider={meta.icon} className="h-3.5 w-3.5" />
              <span>{meta.label}</span>
            </span>
          );
        },
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
            <span className="text-xs font-mono text-status-error">
              {formatExpiry(params.value)}
            </span>
          );
        },
      },
      {
        field: "rateLimitWindows",
        headerName: "Provider Windows",
        minWidth: 260,
        flex: 1,
        cellRenderer: (params: { value: ApiKeyStatus["rateLimitWindows"] | undefined }) => (
          <RateLimitWindowsCell windows={params.value} />
        ),
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
          <span className={cn("font-mono text-xs", params.value > 0 && "text-status-error")}>
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
            {params.value > 0 ? formatCost(params.value, { precision: 4 }) : "-"}
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
      {
        headerName: "Actions",
        width: 150,
        sortable: false,
        filter: false,
        cellRenderer: (params: { data: ApiKeyStatus | undefined }) => {
          if (!params.data || params.data.status !== "rate_limited") {
            return <span className="text-muted-foreground">-</span>;
          }
          return (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                setClearingKey(params.data ?? null);
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Clear
            </Button>
          );
        },
      },
    ],
    [costMap],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader title="API Keys" />

      {/* Summary cards */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
        <StatPanel icon={Key} label="Total Keys" value={stats.total} />
        <StatPanel
          icon={ShieldCheck}
          label="Available"
          value={stats.available}
          tone="success"
          colorValue
        />
        <StatPanel
          icon={ShieldAlert}
          label="Rate Limited"
          value={stats.rateLimited}
          tone="error"
          colorValue
        />
        <StatPanel icon={BarChart3} label="Total Usage" value={stats.totalUsage.toLocaleString()} />
        <StatPanel icon={DollarSign} label="Total Cost" value={formatCost(stats.totalCost)} />
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by name, suffix, type…"
            value={search}
            onChange={(e) => setParam("search", e.target.value, { reset: ["apiKeysPage"] })}
            className="pl-9"
          />
        </div>
        <Select
          value={providerFilter}
          onValueChange={(value) =>
            setParam("provider", value, {
              defaultValue: "all",
              reset: ["apiKeysPage"],
            })
          }
        >
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
        <Select
          value={statusFilter}
          onValueChange={(value) =>
            setParam("status", value, {
              defaultValue: "all",
              reset: ["apiKeysPage"],
            })
          }
        >
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
          <Select
            value={typeFilter}
            onValueChange={(value) =>
              setParam("type", value, {
                defaultValue: "all",
                reset: ["apiKeysPage"],
              })
            }
          >
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
        paginationQueryKey="apiKeys"
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

      {/* Clear rate-limit dialog */}
      <Dialog
        open={clearingKey !== null}
        onOpenChange={(open) => {
          if (!open && !clearRateLimit.isPending) {
            setClearingKey(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Clear Rate Limit</DialogTitle>
          </DialogHeader>
          {clearingKey && (
            <div className="space-y-3 py-2">
              <div className="text-xs text-muted-foreground space-y-1">
                <div>
                  <span className="font-mono uppercase">
                    {formatProvider(clearingKey.provider)}
                  </span>
                  {" · "}
                  <span className="font-mono">{formatKeyType(clearingKey.keyType)}</span>
                  {" · "}
                  <span className="font-mono">...{clearingKey.keySuffix}</span>
                </div>
                {clearingKey.rateLimitedUntil && (
                  <div>
                    Current expiry:{" "}
                    <span className="font-mono text-status-error">
                      {formatExpiry(clearingKey.rateLimitedUntil)}
                    </span>
                  </div>
                )}
              </div>
              <p className="text-sm text-foreground">
                Clear this key's active rate-limit record so it can be selected by the credential
                pool again.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setClearingKey(null)}
              disabled={clearRateLimit.isPending}
            >
              Cancel
            </Button>
            <Button onClick={handleClearRateLimit} disabled={clearRateLimit.isPending}>
              {clearRateLimit.isPending ? "Clearing…" : "Clear rate limit"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
