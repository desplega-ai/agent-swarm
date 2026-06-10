import type { ColDef, ICellRendererParams, RowClickedEvent } from "ag-grid-community";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";

import { useSkills, useSyncRemoteSkills } from "@/api/hooks";
import type { Skill } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
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

function SystemDefaultBadge() {
  return (
    <Badge
      variant="outline"
      size="tag"
      className="border-status-info/30 text-status-info inline-flex items-center gap-1"
    >
      <ShieldCheck className="h-3 w-3" />
      System
    </Badge>
  );
}

export default function SkillsPage() {
  const navigate = useNavigate();
  const { searchParams, setParam } = useUrlSearchState();
  const search = readStringParam(searchParams, "search");
  const typeFilter = readStringParam(searchParams, "type", "all");
  const scopeFilter = readStringParam(searchParams, "scope", "all");
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
        field: "systemDefault",
        headerName: "Default",
        width: 105,
        cellRenderer: (params: ICellRendererParams<Skill>) =>
          params.value ? <SystemDefaultBadge /> : null,
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
                ? "border-status-success/30 text-status-success"
                : "border-status-error/30 text-status-error"
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
      <PageHeader
        className="shrink-0"
        title="Skills"
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => syncRemote.mutate({})}
            disabled={syncRemote.isPending}
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${syncRemote.isPending ? "animate-spin" : ""}`} />
            Sync Remote
          </Button>
        }
      />

      <div className="flex items-center gap-3 shrink-0">
        <Input
          placeholder="Search skills..."
          value={search}
          onChange={(e) => setParam("search", e.target.value, { reset: ["skillsPage"] })}
          className="max-w-xs"
        />
        <Select
          value={typeFilter}
          onValueChange={(value) =>
            setParam("type", value, { defaultValue: "all", reset: ["skillsPage"] })
          }
        >
          <SelectTrigger className="w-[130px]">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="personal">Personal</SelectItem>
            <SelectItem value="remote">Remote</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={scopeFilter}
          onValueChange={(value) =>
            setParam("scope", value, { defaultValue: "all", reset: ["skillsPage"] })
          }
        >
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
      {skills.some((skill) => skill.systemDefault) && (
        <p className="text-xs text-muted-foreground shrink-0">
          System skills are managed by the swarm and re-seeded on start. Fork one under a new name
          to customize its content.
        </p>
      )}

      <DataGrid
        rowData={skills}
        columnDefs={columnDefs}
        quickFilterText={search}
        onRowClicked={onRowClicked}
        loading={isLoading}
        emptyMessage="No skills found"
        paginationQueryKey="skills"
      />
    </div>
  );
}
