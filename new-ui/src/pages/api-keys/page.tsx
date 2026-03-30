import type { ColDef } from "ag-grid-community";
import { BarChart3, Key, Search, ShieldAlert, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { useApiKeyStatuses } from "@/api/hooks/use-api-keys";
import type { ApiKeyStatus, ApiKeyStatusType } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
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
  return keyType;
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

export default function ApiKeysPage() {
  const { data: keys, isLoading } = useApiKeyStatuses();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");

  const keyTypes = useMemo(() => {
    if (!keys) return [];
    return [...new Set(keys.map((k) => k.keyType))];
  }, [keys]);

  const filteredKeys = useMemo(() => {
    if (!keys) return [];
    return keys.filter((k) => {
      if (statusFilter !== "all" && k.status !== statusFilter) return false;
      if (typeFilter !== "all" && k.keyType !== typeFilter) return false;
      return true;
    });
  }, [keys, statusFilter, typeFilter]);

  const stats = useMemo(() => {
    if (!keys) return { total: 0, available: 0, rateLimited: 0, totalUsage: 0 };
    return {
      total: keys.length,
      available: keys.filter((k) => k.status === "available").length,
      rateLimited: keys.filter((k) => k.status === "rate_limited").length,
      totalUsage: keys.reduce((sum, k) => sum + k.totalUsageCount, 0),
    };
  }, [keys]);

  const columnDefs = useMemo<ColDef<ApiKeyStatus>[]>(
    () => [
      {
        field: "keyType",
        headerName: "Type",
        width: 140,
        cellRenderer: (params: { value: string }) => (
          <Badge
            variant="outline"
            className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase font-mono"
          >
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
    [],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <h1 className="text-xl font-semibold">API Keys</h1>

      {/* Summary cards */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
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
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search keys..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
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
    </div>
  );
}
