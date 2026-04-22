import type { ColDef, ICellRendererParams, RowClickedEvent } from "ag-grid-community";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useMcpServers } from "@/api/hooks";
import type { McpServer } from "@/api/types";
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

function TransportBadge({ transport }: { transport: string }) {
  const colors: Record<string, string> = {
    stdio: "border-blue-500/30 text-blue-400",
    http: "border-purple-500/30 text-purple-400",
    sse: "border-cyan-500/30 text-cyan-400",
  };
  return (
    <Badge
      variant="outline"
      className={`text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase ${colors[transport] || ""}`}
    >
      {transport}
    </Badge>
  );
}

function AuthMethodBadge({ method }: { method: string }) {
  const colors: Record<string, string> = {
    static: "border-zinc-500/30 text-zinc-400",
    oauth: "border-purple-500/30 text-purple-400",
    auto: "border-sky-500/30 text-sky-400",
  };
  return (
    <Badge
      variant="outline"
      className={`text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase ${colors[method] || ""}`}
    >
      {method}
    </Badge>
  );
}

function ScopeBadge({ scope }: { scope: string }) {
  const colors: Record<string, string> = {
    global: "border-emerald-500/30 text-emerald-400",
    swarm: "border-amber-500/30 text-amber-400",
    agent: "border-zinc-500/30 text-zinc-400",
  };
  return (
    <Badge
      variant="outline"
      className={`text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase ${colors[scope] || ""}`}
    >
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
            className={`text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase ${
              params.value
                ? "border-emerald-500/30 text-emerald-400"
                : "border-red-500/30 text-red-400"
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
      <div className="flex items-center justify-between shrink-0">
        <h1 className="text-xl font-semibold">MCP Servers</h1>
      </div>

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
