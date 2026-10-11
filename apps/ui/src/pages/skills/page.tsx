import type { ColDef, ICellRendererParams, RowClickedEvent } from "ag-grid-community";
import { FolderTree, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";

import { useSkills, useSkillUsage, useSyncRemoteSkills } from "@/api/hooks";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { formatRelativeTime } from "@/lib/utils";
import { AdoptionView } from "./components/adoption-view";
import {
  compareIsoNullsLast,
  formatCount,
  formatLocalDateTime,
  readUsageWindow,
  UsageWindowControl,
} from "./components/usage-shared";

/** A skill row plus its load count in the selected window. */
type SkillRow = Skill & { uses: number };

function TypeBadge({ type }: { type: string }) {
  return (
    <Badge variant="outline" size="tag">
      {type}
    </Badge>
  );
}

function ScopeBadge({ scope }: { scope: string }) {
  const colors: Record<string, string> = {
    global: "border-status-success/30 text-status-success-strong",
    swarm: "border-status-active/30 text-status-active-strong",
    agent: "border-status-neutral/30 text-status-neutral-strong",
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
      className="border-status-info/30 text-status-info-strong inline-flex items-center gap-1"
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
  const usageFilter = readStringParam(searchParams, "usage", "all");
  const activeTab =
    readStringParam(searchParams, "tab", "skills") === "adoption" ? "adoption" : "skills";
  const usageWindow = readUsageWindow(searchParams);
  const syncRemote = useSyncRemoteSkills();

  const filters = useMemo(() => {
    const f: Record<string, string> = {};
    if (typeFilter !== "all") f.type = typeFilter;
    if (scopeFilter !== "all") f.scope = scopeFilter;
    return Object.keys(f).length > 0 ? f : undefined;
  }, [typeFilter, scopeFilter]);

  const { data, isLoading } = useSkills(filters);
  const { data: usage, isLoading: usageLoading } = useSkillUsage(usageWindow);

  const rows = useMemo<SkillRow[]>(() => {
    const uses = new Map<string, number>();
    for (const row of usage?.bySkill ?? []) {
      if (row.skillId) uses.set(row.skillId, row.invocations);
    }
    const all = (data?.skills ?? []).map((skill) => ({ ...skill, uses: uses.get(skill.id) ?? 0 }));
    if (usageFilter === "used") return all.filter((row) => row.uses > 0);
    if (usageFilter === "unused") return all.filter((row) => row.uses === 0);
    return all;
  }, [data, usage, usageFilter]);

  const columnDefs = useMemo<ColDef<SkillRow>[]>(
    () => [
      {
        field: "name",
        headerName: "Name",
        flex: 1,
        minWidth: 150,
        cellRenderer: (params: ICellRendererParams<SkillRow>) => (
          <span className="inline-flex items-center gap-1.5 font-medium">
            {params.value}
            {params.data?.isComplex && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <FolderTree
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    aria-label="Complex skill"
                  />
                </TooltipTrigger>
                <TooltipContent side="right">
                  Complex skill — ships bundled files alongside SKILL.md.
                </TooltipContent>
              </Tooltip>
            )}
          </span>
        ),
      },
      {
        field: "type",
        headerName: "Type",
        width: 90,
        cellRenderer: (params: ICellRendererParams<SkillRow>) =>
          params.value ? <TypeBadge type={params.value} /> : null,
      },
      {
        field: "scope",
        headerName: "Scope",
        width: 90,
        cellRenderer: (params: ICellRendererParams<SkillRow>) =>
          params.value ? <ScopeBadge scope={params.value} /> : null,
      },
      {
        field: "systemDefault",
        headerName: "Default",
        width: 100,
        cellRenderer: (params: ICellRendererParams<SkillRow>) =>
          params.value ? <SystemDefaultBadge /> : null,
      },
      {
        field: "description",
        headerName: "Description",
        flex: 2,
        minWidth: 150,
      },
      {
        field: "version",
        headerName: "Ver",
        width: 60,
      },
      {
        field: "isEnabled",
        headerName: "Status",
        width: 90,
        cellRenderer: (params: ICellRendererParams<SkillRow>) => (
          <Badge
            variant="outline"
            size="tag"
            className={`${
              params.value
                ? "border-status-success/30 text-status-success-strong"
                : "border-status-error/30 text-status-error-strong"
            }`}
          >
            {params.value ? "Enabled" : "Disabled"}
          </Badge>
        ),
      },
      {
        field: "uses",
        headerName: "Uses",
        headerTooltip: "Loads in the selected window, at most one per runner session",
        width: 100,
        type: "numericColumn",
        valueFormatter: (params) => formatCount(params.value ?? 0),
      },
      {
        field: "lastInvokedAt",
        headerName: "Last used",
        width: 120,
        comparator: compareIsoNullsLast,
        cellRenderer: (params: ICellRendererParams<SkillRow>) =>
          params.value ? (
            <span title={formatLocalDateTime(params.value)}>
              {formatRelativeTime(params.value)}
            </span>
          ) : (
            <span className="text-muted-foreground">Never</span>
          ),
      },
      {
        field: "lastUpdatedAt",
        headerName: "Updated",
        width: 130,
        valueFormatter: (params) => (params.value ? formatRelativeTime(params.value) : "-"),
      },
    ],
    [],
  );

  const onRowClicked = useCallback(
    (event: RowClickedEvent<SkillRow>) => {
      if (event.data) void navigate(`/skills/${event.data.id}`);
    },
    [navigate],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader className="shrink-0" title="Skills" />

      <Tabs
        value={activeTab}
        onValueChange={(value) => setParam("tab", value, { defaultValue: "skills" })}
        className="flex flex-col flex-1 min-h-0"
      >
        {/* Shared toolbar: the list filters on the left (Skills tab only), the
            usage window and tabs pinned to the right. */}
        <div className="flex flex-wrap items-center gap-3 shrink-0">
          {activeTab === "skills" ? (
            <>
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
              <Select
                value={usageFilter}
                onValueChange={(value) =>
                  setParam("usage", value, { defaultValue: "all", reset: ["skillsPage"] })
                }
              >
                <SelectTrigger className="w-[160px]" aria-label="Usage">
                  <SelectValue placeholder="Usage" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Usage</SelectItem>
                  <SelectItem value="used">Used</SelectItem>
                  <SelectItem value="unused">Unused in window</SelectItem>
                </SelectContent>
              </Select>
            </>
          ) : null}
          <div className="ml-auto flex items-center gap-3">
            <UsageWindowControl
              value={usageWindow}
              onChange={(value) =>
                setParam("window", value, { defaultValue: "30d", reset: ["skillsPage"] })
              }
            />
            {activeTab === "skills" ? (
              // Sync lives in the toolbar as a bare icon, no lone header action row.
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8"
                    onClick={() => syncRemote.mutate({})}
                    disabled={syncRemote.isPending}
                    aria-label="Sync remote skills"
                  >
                    <RefreshCw
                      className={`h-4 w-4 ${syncRemote.isPending ? "animate-spin" : ""}`}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Sync remote skills</TooltipContent>
              </Tooltip>
            ) : null}
            <TabsList className="shrink-0">
              <TabsTrigger value="skills">Skills</TabsTrigger>
              <TabsTrigger value="adoption">Adoption</TabsTrigger>
            </TabsList>
          </div>
        </div>

        <TabsContent value="skills" className="flex flex-col flex-1 min-h-0 mt-2">
          <DataGrid
            rowData={rows}
            columnDefs={columnDefs}
            quickFilterText={search}
            onRowClicked={onRowClicked}
            loading={isLoading || (usageFilter !== "all" && usageLoading)}
            emptyMessage={
              usageFilter === "unused" ? "Every skill was used in this window" : "No skills found"
            }
            paginationQueryKey="skills"
          />
        </TabsContent>

        <TabsContent value="adoption" className="flex-1 min-h-0 overflow-y-auto mt-2">
          <AdoptionView summary={usage} isLoading={usageLoading} window={usageWindow} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
