import type { ColDef, ICellRendererParams, RowClickedEvent } from "ag-grid-community";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useMcpServers } from "@/api/hooks";
import type { McpServer } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatRelativeTime } from "@/lib/utils";

/**
 * Transport / auth-method / scope chips. Each protocol type has no semantic
 * status meaning — they're visual differentiators. Mapped by closest hue match
 * to existing action / status tokens (pixel parity preserved):
 * - stdio (blue) → `action-default`
 * - http (purple) → `action-delegate-to-agent`
 * - sse (cyan) → `action-script`
 * - oauth (purple) → `action-delegate-to-agent`
 * - auto (sky) → `action-raw-llm`
 * - global (emerald) → `status-success`
 * - swarm (amber) → `status-active`
 */
function TransportBadge({ transport }: { transport: string }) {
  const colors: Record<string, string> = {
    stdio: "border-action-default/30 text-action-default",
    http: "border-action-delegate-to-agent/30 text-action-delegate-to-agent",
    sse: "border-action-script/30 text-action-script",
  };
  return (
    <Badge variant="outline" size="tag" className={`${colors[transport] || ""}`}>
      {transport}
    </Badge>
  );
}

function AuthMethodBadge({ method }: { method: string }) {
  const colors: Record<string, string> = {
    static: "border-status-neutral/30 text-status-neutral",
    oauth: "border-action-delegate-to-agent/30 text-action-delegate-to-agent",
    auto: "border-action-raw-llm/30 text-action-raw-llm",
  };
  return (
    <Badge variant="outline" size="tag" className={`${colors[method] || ""}`}>
      {method}
    </Badge>
  );
}

function ScopeBadge({ scope }: { scope: string }) {
  const colors: Record<string, string> = {
    global: "border-status-success/30 text-status-success",
    swarm: "border-status-active/30 text-status-active",
    agent: "border-status-neutral/30 text-status-neutral",
  };
  return (
    <Badge variant="outline" size="tag" className={`${colors[scope] || ""}`}>
      {scope}
    </Badge>
  );
}

export default function McpServersPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const [transportFilter, setTransportFilter] = useState<string>("all");

  const filters = useMemo(() => {
    const f: Record<string, string> = {};
    if (scopeFilter !== "all") f.scope = scopeFilter;
    if (transportFilter !== "all") f.transport = transportFilter;
    return Object.keys(f).length > 0 ? f : undefined;
  }, [scopeFilter, transportFilter]);

  const { data, isLoading } = useMcpServers(filters);
  const servers = data?.servers ?? [];

  const columnDefs = useMemo<ColDef<McpServer>[]>(
    () => [
      {
        field: "name",
        headerName: "Name",
        flex: 1,
        minWidth: 150,
        cellRenderer: (params: ICellRendererParams<McpServer>) => (
          <span className="font-medium">{params.value}</span>
        ),
      },
      {
        field: "transport",
        headerName: "Transport",
        width: 100,
        cellRenderer: (params: ICellRendererParams<McpServer>) =>
          params.value ? <TransportBadge transport={params.value} /> : null,
      },
      {
        field: "scope",
        headerName: "Scope",
        width: 100,
        cellRenderer: (params: ICellRendererParams<McpServer>) =>
          params.value ? <ScopeBadge scope={params.value} /> : null,
      },
      {
        field: "authMethod",
        headerName: "Auth",
        width: 90,
        cellRenderer: (params: ICellRendererParams<McpServer>) =>
          params.value ? <AuthMethodBadge method={params.value} /> : null,
      },
      {
        field: "description",
        headerName: "Description",
        flex: 2,
        minWidth: 200,
      },
      {
        field: "isEnabled",
        headerName: "Status",
        width: 90,
        cellRenderer: (params: ICellRendererParams<McpServer>) => (
          <Badge
            variant="outline"
            size="tag"
            className={`${
              params.value
                ? "border-status-success/30 text-status-success"
                : "border-status-error/30 text-status-error"
            }`}
          >
            {params.value ? "Enabled" : "Disabled"}
          </Badge>
        ),
      },
      {
        field: "createdAt",
        headerName: "Created",
        width: 140,
        valueFormatter: (params) => (params.value ? formatRelativeTime(params.value) : "-"),
      },
    ],
    [],
  );

  const onRowClicked = useCallback(
    (event: RowClickedEvent<McpServer>) => {
      if (event.data) navigate(`/mcp-servers/${event.data.id}`);
    },
    [navigate],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader title="MCP Servers" className="shrink-0" />

      <div className="flex items-center gap-3 shrink-0">
        <Input
          placeholder="Search servers..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select value={transportFilter} onValueChange={setTransportFilter}>
          <SelectTrigger className="w-[130px]">
            <SelectValue placeholder="Transport" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Transports</SelectItem>
            <SelectItem value="stdio">stdio</SelectItem>
            <SelectItem value="http">http</SelectItem>
            <SelectItem value="sse">sse</SelectItem>
          </SelectContent>
        </Select>
        <Select value={scopeFilter} onValueChange={setScopeFilter}>
          <SelectTrigger className="w-[130px]">
            <SelectValue placeholder="Scope" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Scopes</SelectItem>
            <SelectItem value="global">Global</SelectItem>
            <SelectItem value="swarm">Swarm</SelectItem>
            <SelectItem value="agent">Agent</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <DataGrid
        rowData={servers}
        columnDefs={columnDefs}
        quickFilterText={search}
        onRowClicked={onRowClicked}
        loading={isLoading}
        emptyMessage="No MCP servers found"
      />
    </div>
  );
}
