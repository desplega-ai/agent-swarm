import type { ColDef, ICellRendererParams, RowClickedEvent } from "ag-grid-community";
import { RefreshCw } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useSkills, useSyncRemoteSkills } from "@/api/hooks";
import type { Skill } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatRelativeTime } from "@/lib/utils";

function TypeBadge({ type }: { type: string }) {
  return (
    <Badge variant="outline" size="tag">
      {type}
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
    <Badge variant="outline" size="tag" className={`${colors[scope] || ""}`}>
      {scope}
    </Badge>
  );
}

export default function SkillsPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const syncRemote = useSyncRemoteSkills();

  const filters = useMemo(() => {
    const f: Record<string, string> = {};
    if (typeFilter !== "all") f.type = typeFilter;
    if (scopeFilter !== "all") f.scope = scopeFilter;
    return Object.keys(f).length > 0 ? f : undefined;
  }, [typeFilter, scopeFilter]);

  const { data, isLoading } = useSkills(filters);
  const skills = data?.skills ?? [];

  const columnDefs = useMemo<ColDef<Skill>[]>(
    () => [
      {
        field: "name",
        headerName: "Name",
        flex: 1,
        minWidth: 150,
        cellRenderer: (params: ICellRendererParams<Skill>) => (
          <span className="font-medium">{params.value}</span>
        ),
      },
      {
        field: "type",
        headerName: "Type",
        width: 100,
        cellRenderer: (params: ICellRendererParams<Skill>) =>
          params.value ? <TypeBadge type={params.value} /> : null,
      },
      {
        field: "scope",
        headerName: "Scope",
        width: 100,
        cellRenderer: (params: ICellRendererParams<Skill>) =>
          params.value ? <ScopeBadge scope={params.value} /> : null,
      },
      {
        field: "description",
        headerName: "Description",
        flex: 2,
        minWidth: 200,
      },
      {
        field: "version",
        headerName: "Ver",
        width: 70,
      },
      {
        field: "isEnabled",
        headerName: "Status",
        width: 90,
        cellRenderer: (params: ICellRendererParams<Skill>) => (
          <Badge
            variant="outline"
            size="tag"
            className={`${
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
        field: "lastUpdatedAt",
        headerName: "Updated",
        width: 140,
        valueFormatter: (params) => (params.value ? formatRelativeTime(params.value) : "-"),
      },
    ],
    [],
  );

  const onRowClicked = useCallback(
    (event: RowClickedEvent<Skill>) => {
      if (event.data) navigate(`/skills/${event.data.id}`);
    },
    [navigate],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <div className="flex items-center justify-between shrink-0">
        <h1 className="text-xl font-semibold">Skills</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={() => syncRemote.mutate({})}
          disabled={syncRemote.isPending}
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${syncRemote.isPending ? "animate-spin" : ""}`} />
          Sync Remote
        </Button>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <Input
          placeholder="Search skills..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[130px]">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="personal">Personal</SelectItem>
            <SelectItem value="remote">Remote</SelectItem>
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
        rowData={skills}
        columnDefs={columnDefs}
        quickFilterText={search}
        onRowClicked={onRowClicked}
        loading={isLoading}
        emptyMessage="No skills found"
      />
    </div>
  );
}
