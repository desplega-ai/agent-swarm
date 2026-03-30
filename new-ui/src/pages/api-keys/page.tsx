import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { useMemo, useState } from "react";

import { useApiKeyStatuses } from "@/api/hooks/use-api-keys";
import type { ApiKeyStatus } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatRelativeTime } from "@/lib/utils";

function StatusBadge({ status }: { status: string }) {
  const isRateLimited = status === "rate_limited";
  return (
    <Badge
      variant="outline"
      className={`text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase ${
        isRateLimited ? "border-red-500/30 text-red-400" : "border-emerald-500/30 text-emerald-400"
      }`}
    >
      {isRateLimited ? "Rate Limited" : "Available"}
    </Badge>
  );
}

function KeyTypeBadge({ keyType }: { keyType: string }) {
  const label = keyType.includes("OAUTH")
    ? "OAuth"
    : keyType.includes("ANTHROPIC")
      ? "Anthropic"
      : keyType.includes("OPENROUTER")
        ? "OpenRouter"
        : keyType;
  const colors = keyType.includes("OAUTH")
    ? "border-amber-500/30 text-amber-400"
    : keyType.includes("ANTHROPIC")
      ? "border-blue-500/30 text-blue-400"
      : "border-zinc-500/30 text-zinc-400";
  return (
    <Badge
      variant="outline"
      className={`text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase ${colors}`}
    >
      {label}
    </Badge>
  );
}

export default function ApiKeysPage() {
  const [search, setSearch] = useState("");
  const [keyTypeFilter, setKeyTypeFilter] = useState<string>("all");

  const { data: keys, isLoading } = useApiKeyStatuses(
    keyTypeFilter !== "all" ? keyTypeFilter : undefined,
  );

  const keyTypes = useMemo(() => {
    if (!keys) return [];
    return [...new Set(keys.map((k) => k.keyType))];
  }, [keys]);

  const stats = useMemo(() => {
    if (!keys) return { total: 0, available: 0, rateLimited: 0 };
    return {
      total: keys.length,
      available: keys.filter((k) => k.status === "available").length,
      rateLimited: keys.filter((k) => k.status === "rate_limited").length,
    };
  }, [keys]);

  const columnDefs = useMemo<ColDef<ApiKeyStatus>[]>(
    () => [
      {
        field: "keyType",
        headerName: "Type",
        width: 140,
        cellRenderer: (params: ICellRendererParams<ApiKeyStatus>) =>
          params.data ? <KeyTypeBadge keyType={params.data.keyType} /> : null,
      },
      {
        field: "keySuffix",
        headerName: "Key Suffix",
        width: 120,
        cellRenderer: (params: ICellRendererParams<ApiKeyStatus>) => (
          <span className="font-mono text-muted-foreground">...{params.value}</span>
        ),
      },
      {
        field: "keyIndex",
        headerName: "Index",
        width: 80,
        cellRenderer: (params: ICellRendererParams<ApiKeyStatus>) => (
          <span className="font-mono">{params.value}</span>
        ),
      },
      {
        field: "status",
        headerName: "Status",
        width: 130,
        cellRenderer: (params: ICellRendererParams<ApiKeyStatus>) =>
          params.data ? <StatusBadge status={params.data.status} /> : null,
      },
      {
        field: "rateLimitedUntil",
        headerName: "Rate Limit Expires",
        width: 170,
        cellRenderer: (params: ICellRendererParams<ApiKeyStatus>) => {
          if (!params.value) return <span className="text-muted-foreground/50">-</span>;
          const expiry = new Date(params.value);
          const now = new Date();
          const isExpired = expiry <= now;
          return (
            <span className={isExpired ? "text-muted-foreground/50 line-through" : "text-red-400"}>
              {formatRelativeTime(params.value)}
            </span>
          );
        },
      },
      {
        field: "totalUsageCount",
        headerName: "Usage Count",
        width: 120,
        cellRenderer: (params: ICellRendererParams<ApiKeyStatus>) => (
          <span className="font-mono">{params.value?.toLocaleString()}</span>
        ),
      },
      {
        field: "rateLimitCount",
        headerName: "Rate Limits",
        width: 110,
        cellRenderer: (params: ICellRendererParams<ApiKeyStatus>) => {
          const count = params.value ?? 0;
          return (
            <span
              className={`font-mono ${count > 0 ? "text-red-400" : "text-muted-foreground/50"}`}
            >
              {count}
            </span>
          );
        },
      },
      {
        field: "lastUsedAt",
        headerName: "Last Used",
        flex: 1,
        minWidth: 140,
        cellRenderer: (params: ICellRendererParams<ApiKeyStatus>) =>
          params.value ? (
            <span className="text-muted-foreground">{formatRelativeTime(params.value)}</span>
          ) : (
            <span className="text-muted-foreground/50">Never</span>
          ),
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">API Keys</h1>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span>
            <span className="font-mono text-foreground">{stats.total}</span> total
          </span>
          <span>
            <span className="font-mono text-emerald-400">{stats.available}</span> available
          </span>
          {stats.rateLimited > 0 && (
            <span>
              <span className="font-mono text-red-400">{stats.rateLimited}</span> rate limited
            </span>
          )}
        </div>
      </div>

      <div className="flex gap-3">
        <Input
          placeholder="Search keys..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select value={keyTypeFilter} onValueChange={setKeyTypeFilter}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="All key types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All key types</SelectItem>
            {keyTypes.map((kt) => (
              <SelectItem key={kt} value={kt}>
                {kt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DataGrid<ApiKeyStatus>
        rowData={keys}
        columnDefs={columnDefs}
        quickFilterText={search}
        loading={isLoading}
        emptyMessage="No API keys tracked yet"
      />
    </div>
  );
}
