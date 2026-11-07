import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { Search, SquareCode } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useScriptsSavings } from "@/api/hooks/use-savings";
import { useScriptRuns } from "@/api/hooks/use-script-runs";
import { useScripts } from "@/api/hooks/use-scripts";
import type { SavingsJobRow, ScriptListItem, ScriptScope } from "@/api/types";
import { ScriptRunsGrid, ScriptRunsStatusFilter } from "@/components/scripts/script-runs-grid";
import { DataGridColumnsMenu } from "@/components/shared/columns-menu";
import { DataGrid, HIDE_WHEN_COMPACT, useDataGridColumns } from "@/components/shared/data-grid";
import { EmptyState } from "@/components/shared/empty-state";
import { MobileList, MobileListRow } from "@/components/shared/mobile-list";
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
import { useIsPhone } from "@/hooks/use-mobile";
import { readBooleanParam, readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { cn, formatSmartTime } from "@/lib/utils";
import { formatUsd } from "@/pages/usage/usage-format";

const SCOPE_OPTIONS: Array<ScriptScope | "all"> = ["all", "agent", "global"];

// Server cap on GET /api/script-runs — covers run counts + the Runs tab.
const RUNS_FETCH_LIMIT = 500;

export default function ScriptsPage() {
  const navigate = useNavigate();
  const isPhone = useIsPhone();
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

  const { data: savings } = useScriptsSavings();
  // One request for the whole list, joined by script name.
  const savingsByName = useMemo(() => {
    const m = new Map<string, SavingsJobRow>();
    if (savings?.valid)
      for (const row of savings.rows) if (row.scriptName) m.set(row.scriptName, row);
    return m;
  }, [savings]);
  // Savings are keyed by name: scripts of one name in several scopes share a row.
  const sharedNames = useMemo(() => {
    const seen = new Set<string>();
    const shared = new Set<string>();
    for (const s of scripts ?? []) (seen.has(s.name) ? shared : seen).add(s.name);
    return shared;
  }, [scripts]);

  const gridColumns = useDataGridColumns("scripts");
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
        context: HIDE_WHEN_COMPACT,
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
        colId: "runs",
        headerName: "Runs",
        context: HIDE_WHEN_COMPACT,
        width: 90,
        valueGetter: (params) => (params.data ? (runCounts.get(params.data.name) ?? 0) : 0),
      },
      {
        colId: "saved30d",
        headerName: "Saved (30d)",
        context: HIDE_WHEN_COMPACT,
        width: 130,
        // Sorts by the p50; scripts without a saving sort below every amount.
        valueGetter: (params) =>
          params.data ? (savingsByName.get(params.data.name)?.savingUsd.p50 ?? null) : null,
        cellRenderer: (params: { data?: ScriptListItem }) => {
          const row = params.data ? savingsByName.get(params.data.name) : undefined;
          if (!row || !params.data) return <span className="text-muted-foreground">—</span>;
          const kind =
            row.kind === "script-scheduled"
              ? "scheduled"
              : "called by agents (priced as extra turns)";
          const title = `${formatUsd(row.savingUsd.p10)} to ${formatUsd(row.savingUsd.p90)} (80% range), ${kind}, ${row.substitutedRuns.toLocaleString("en-US")} of ${row.runs.toLocaleString("en-US")} runs${row.capApplied ? ", capped at 24 a day" : ""}${sharedNames.has(params.data.name) ? ". Shared with the script of the same name in the other scope" : ""}`;
          return (
            <span className="font-mono tabular-nums" title={title}>
              {formatUsd(row.savingUsd.p50)}
            </span>
          );
        },
      },
      {
        field: "updatedAt",
        headerName: "Updated",
        context: HIDE_WHEN_COMPACT,
        width: 150,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : ""),
      },
    ],
    [runCounts, savingsByName, sharedNames],
  );

  const onScriptRowClicked = useCallback(
    (event: RowClickedEvent<ScriptListItem>) => {
      const target = event.event?.target as HTMLElement | null;
      if (target?.closest("a, button")) return;
      if (event.data) void navigate(`/scripts/${event.data.id}`);
    },
    [navigate],
  );

  const phoneRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = scripts ?? [];
    if (!q) return all;
    return all.filter((s) =>
      `${s.name} ${s.description ?? ""} ${s.scope}`.toLowerCase().includes(q),
    );
  }, [scripts, search]);

  const hasFilters = !!search || scopeFilter !== "all" || includeScratch;
  const showEmptyState = !scriptsLoading && (scripts?.length ?? 0) === 0 && !hasFilters;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader title="Scripts" />

      <Tabs
        value={activeTab}
        onValueChange={(value) => setParam("tab", value, { defaultValue: "scripts" })}
        className="flex flex-col flex-1 min-h-0 max-md:flex-none"
      >
        {/* Shared toolbar (People pattern): the active tab's filters on the
            left, tabs pinned to the right. Filters hide over the first-run
            empty state (showEmptyState is false whenever a filter is active). */}
        {/* On a phone the tabs lead (sticky)
            and the filters share one row: search, scope, scratch. The
            Columns menu has no grid to act on there, so it hides. */}
        {isPhone ? (
          <TabsList sticky className="w-full">
            <TabsTrigger value="scripts">Scripts</TabsTrigger>
            <TabsTrigger value="runs">Runs</TabsTrigger>
          </TabsList>
        ) : null}
        <div className="flex flex-wrap items-center gap-3 max-md:flex-nowrap max-md:gap-2">
          {activeTab === "scripts" && (
            <div
              className={cn(
                "flex flex-1 min-w-0 flex-wrap items-center gap-3 max-md:flex-nowrap max-md:gap-2",
                showEmptyState && "hidden",
              )}
            >
              <div className="relative w-full max-w-sm max-md:min-w-0 max-md:flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder={isPhone ? "Search…" : "Search scripts…"}
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
                <SelectTrigger className="w-[140px] max-md:w-[88px]">
                  <SelectValue placeholder="Scope" />
                </SelectTrigger>
                <SelectContent>
                  {SCOPE_OPTIONS.map((scope) => (
                    <SelectItem key={scope} value={scope}>
                      {scope === "all" ? (isPhone ? "All" : "All scopes") : scope}
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
                  {isPhone ? "Scratch" : "Include scratch"}
                </Label>
              </div>
              {isPhone ? null : (
                <div className="ml-auto">
                  <DataGridColumnsMenu state={gridColumns} />
                </div>
              )}
            </div>
          )}
          {activeTab === "runs" && (
            <div className="flex flex-1 min-w-0 flex-wrap items-center gap-2">
              <ScriptRunsStatusFilter paginationQueryKey="scriptRuns" />
            </div>
          )}
          {isPhone ? null : (
            <TabsList className="ml-auto shrink-0">
              <TabsTrigger value="scripts">Scripts</TabsTrigger>
              <TabsTrigger value="runs">Runs</TabsTrigger>
            </TabsList>
          )}
        </div>

        <TabsContent value="scripts" className="flex flex-col flex-1 min-h-0 mt-2 gap-3">
          {showEmptyState ? (
            <EmptyState
              icon={SquareCode}
              title="No saved scripts"
              description="Scripts saved by agents via script-upsert (or auto-saved from inline runs) will appear here."
              entity="script"
              fullPage
            />
          ) : isPhone ? (
            <MobileList
              label="Scripts"
              loading={scriptsLoading}
              emptyMessage="No scripts match the current filters"
              className="flex-none overflow-visible"
            >
              {phoneRows.map((script) => (
                <MobileListRow
                  key={script.id}
                  to={`/scripts/${script.id}`}
                  title={script.name}
                  titleLines={1}
                  status={
                    <Badge variant="outline" size="tag">
                      {script.isScratch ? "scratch" : script.scope}
                    </Badge>
                  }
                  meta={[
                    `v${script.version}`,
                    `${runCounts.get(script.name) ?? 0} runs`,
                    script.description || null,
                  ]}
                />
              ))}
            </MobileList>
          ) : (
            <DataGrid
              rowData={scripts ?? []}
              columnDefs={scriptColumns}
              columns={gridColumns}
              quickFilterText={search}
              onRowClicked={onScriptRowClicked}
              loading={scriptsLoading}
              emptyMessage="No scripts match the current filters"
              paginationQueryKey="scripts"
            />
          )}
        </TabsContent>

        <TabsContent value="runs" className="flex flex-col flex-1 min-h-0 mt-2 gap-3">
          <ScriptRunsGrid
            rows={runs}
            loading={runsLoading}
            paginationQueryKey="scriptRuns"
            hideToolbar
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
