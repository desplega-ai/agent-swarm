import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { Search, SquareCode } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useScriptRuns } from "@/api/hooks/use-script-runs";
import { useScripts } from "@/api/hooks/use-scripts";
import type { ScriptListItem, ScriptScope } from "@/api/types";
import { ScriptRunsGrid } from "@/components/scripts/script-runs-grid";
import { DataGrid } from "@/components/shared/data-grid";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { readBooleanParam, readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { formatSmartTime } from "@/lib/utils";

const SCOPE_OPTIONS: Array<ScriptScope | "all"> = ["all", "agent", "global"];

// Server cap on GET /api/script-runs — covers run counts + the Runs tab.
const RUNS_FETCH_LIMIT = 500;

export default function ScriptsPage() {
  const navigate = useNavigate();
  const { searchParams, setParam } = useUrlSearchState();
  const activeTab = readStringParam(searchParams, "tab", "scripts") === "runs" ? "runs" : "scripts";
  const search = readStringParam(searchParams, "search");
  const scopeParam = readStringParam(searchParams, "scope", "all");
  const scopeFilter = SCOPE_OPTIONS.includes(scopeParam as ScriptScope | "all")
    ? (scopeParam as ScriptScope | "all")
    : "all";
  const includeScratch = readBooleanParam(searchParams, "scratch");

  const { data: scripts, isLoading: scriptsLoading } = useScripts({
    scope: scopeFilter,
    includeScratch,
  });
  const { data: runsData, isLoading: runsLoading } = useScriptRuns({ limit: RUNS_FETCH_LIMIT });
  const runs = useMemo(() => runsData?.runs ?? [], [runsData]);

  // Client-computed per-script run counts from the loaded runs page (see plan
  // follow-ups: replace with a server-side aggregate if run volume grows).
  const runCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of runs) {
      if (!run.scriptName) continue;
      counts.set(run.scriptName, (counts.get(run.scriptName) ?? 0) + 1);
    }
    return counts;
  }, [runs]);

  const scriptColumns = useMemo<ColDef<ScriptListItem>[]>(
    () => [
      {
        field: "name",
        headerName: "Name",
        flex: 1,
        minWidth: 200,
        cellRenderer: (params: { value: string; data?: ScriptListItem }) => (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-semibold">{params.value}</span>
            {params.data?.isScratch && (
              <Badge variant="outline" size="tag">
                SCRATCH
              </Badge>
            )}
          </span>
        ),
      },
      {
        field: "scope",
        headerName: "Scope",
        width: 110,
        cellRenderer: (params: { value?: ScriptScope }) =>
          params.value ? (
            <Badge variant="outline" size="tag">
              {params.value}
            </Badge>
          ) : null,
      },
      {
        field: "description",
        headerName: "Description",
        flex: 1,
        minWidth: 200,
        cellRenderer: (params: { value?: string }) => (
          <span className="truncate text-muted-foreground">{params.value || "—"}</span>
        ),
      },
      {
        field: "version",
        headerName: "Version",
        width: 100,
        valueFormatter: (params) => (params.value != null ? `v${params.value}` : ""),
      },
      {
        headerName: "Runs",
        width: 90,
        valueGetter: (params) => (params.data ? (runCounts.get(params.data.name) ?? 0) : 0),
      },
      {
        field: "updatedAt",
        headerName: "Updated",
        width: 150,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : ""),
      },
    ],
    [runCounts],
  );

  const onScriptRowClicked = useCallback(
    (event: RowClickedEvent<ScriptListItem>) => {
      const target = event.event?.target as HTMLElement | null;
      if (target?.closest("a, button")) return;
      if (event.data) navigate(`/scripts/${event.data.id}`);
    },
    [navigate],
  );

  const hasFilters = !!search || scopeFilter !== "all" || includeScratch;
  const showEmptyState = !scriptsLoading && (scripts?.length ?? 0) === 0 && !hasFilters;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader title="Scripts" />

      <Tabs
        value={activeTab}
        onValueChange={(value) => setParam("tab", value, { defaultValue: "scripts" })}
        className="flex flex-col flex-1 min-h-0"
      >
        <TabsList>
          <TabsTrigger value="scripts">Scripts</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
        </TabsList>

        <TabsContent value="scripts" className="flex flex-col flex-1 min-h-0 mt-2 gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative w-full max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search scripts…"
                value={search}
                onChange={(e) => setParam("search", e.target.value, { reset: ["scriptsPage"] })}
                className="pl-9"
              />
            </div>
            <Select
              value={scopeFilter}
              onValueChange={(value) =>
                setParam("scope", value, { defaultValue: "all", reset: ["scriptsPage"] })
              }
            >
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Scope" />
              </SelectTrigger>
              <SelectContent>
                {SCOPE_OPTIONS.map((scope) => (
                  <SelectItem key={scope} value={scope}>
                    {scope === "all" ? "All scopes" : scope}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-2">
              <Switch
                id="include-scratch"
                size="sm"
                checked={includeScratch}
                onCheckedChange={(checked) =>
                  setParam("scratch", checked ? "true" : "", { reset: ["scriptsPage"] })
                }
              />
              <Label htmlFor="include-scratch" className="text-xs text-muted-foreground">
                Include scratch
              </Label>
            </div>
          </div>
          {showEmptyState ? (
            <EmptyState
              icon={SquareCode}
              title="No saved scripts"
              description="Scripts saved by agents via script-upsert (or auto-saved from inline runs) will appear here."
            />
          ) : (
            <DataGrid
              rowData={scripts ?? []}
              columnDefs={scriptColumns}
              quickFilterText={search}
              onRowClicked={onScriptRowClicked}
              loading={scriptsLoading}
              emptyMessage="No scripts match the current filters"
              paginationQueryKey="scripts"
            />
          )}
        </TabsContent>

        <TabsContent value="runs" className="flex flex-col flex-1 min-h-0 mt-2 gap-3">
          <ScriptRunsGrid rows={runs} loading={runsLoading} paginationQueryKey="scriptRuns" />
        </TabsContent>
      </Tabs>
    </div>
  );
}
