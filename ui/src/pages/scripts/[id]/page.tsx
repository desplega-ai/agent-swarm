import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { ArrowLeft } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useScriptRuns } from "@/api/hooks/use-script-runs";
import { useScript, useScriptTypeDefs, useScriptVersions } from "@/api/hooks/use-scripts";
import type { ScriptVersion } from "@/api/types";
import { ScriptApiTab } from "@/components/scripts/script-api-tab";
import { ScriptRunsGrid } from "@/components/scripts/script-runs-grid";
import { ScriptSourceEditor } from "@/components/scripts/script-source-editor";
import { DataGrid } from "@/components/shared/data-grid";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { formatSmartTime } from "@/lib/utils";

// Server cap on GET /api/script-runs.
const RUNS_FETCH_LIMIT = 500;

const TABS = ["source", "runs", "versions", "api"] as const;
type Tab = (typeof TABS)[number];

export default function ScriptDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { searchParams, setParam } = useUrlSearchState();
  const tabParam = readStringParam(searchParams, "tab", "source");
  const activeTab: Tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : "source";

  const { data: script, isLoading } = useScript(id ?? "");
  const { data: typeDefs } = useScriptTypeDefs();
  const { data: versions, isLoading: versionsLoading } = useScriptVersions(id ?? "");
  const { data: runsData, isLoading: runsLoading } = useScriptRuns({
    scriptName: script?.name,
    limit: RUNS_FETCH_LIMIT,
  });
  // Guard against the unfiltered first page while the script is still loading.
  const runs = useMemo(() => (script ? (runsData?.runs ?? []) : []), [script, runsData]);

  // Versions tab — selected version's source shown in the shared editor.
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const selectedVersion = useMemo(() => {
    if (!versions || versions.length === 0) return null;
    return versions.find((v) => v.id === selectedVersionId) ?? versions[0];
  }, [versions, selectedVersionId]);

  const versionColumns = useMemo<ColDef<ScriptVersion>[]>(
    () => [
      {
        field: "version",
        headerName: "Version",
        width: 100,
        valueFormatter: (params) => (params.value != null ? `v${params.value}` : ""),
      },
      {
        field: "changedAt",
        headerName: "Changed",
        width: 150,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : ""),
      },
      {
        field: "changeReason",
        headerName: "Reason",
        flex: 1,
        minWidth: 160,
        cellRenderer: (params: { value?: string | null }) => (
          <span className="truncate text-muted-foreground">{params.value || "—"}</span>
        ),
      },
      {
        field: "contentHash",
        headerName: "Hash",
        width: 130,
        cellRenderer: (params: { value?: string }) =>
          params.value ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="block truncate font-mono text-xs text-muted-foreground">
                  {params.value.slice(0, 12)}
                </span>
              </TooltipTrigger>
              <TooltipContent className="font-mono text-xs">{params.value}</TooltipContent>
            </Tooltip>
          ) : null,
      },
    ],
    [],
  );

  const onVersionRowClicked = (event: RowClickedEvent<ScriptVersion>) => {
    if (event.data) setSelectedVersionId(event.data.id);
  };

  if (isLoading) {
    return <PageSkeleton />;
  }

  if (!script) {
    return <p className="text-sm text-muted-foreground">Script not found.</p>;
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <div className="space-y-3">
        <Link
          to="/scripts"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Scripts
        </Link>

        <PageHeader
          title={
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <h1 className="truncate text-xl font-semibold">{script.name}</h1>
              <Badge variant="outline" size="tag">
                {script.scope}
              </Badge>
              <Badge variant="outline" size="tag" className="font-mono">
                v{script.version}
              </Badge>
              {script.isScratch && (
                <Badge variant="outline" size="tag">
                  SCRATCH
                </Badge>
              )}
            </div>
          }
          description={script.description || undefined}
        />
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(value) => setParam("tab", value, { defaultValue: "source" })}
        className="flex flex-col flex-1 min-h-0"
      >
        <TabsList>
          <TabsTrigger value="source">Source</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="versions">Versions</TabsTrigger>
          <TabsTrigger value="api">API</TabsTrigger>
        </TabsList>

        <TabsContent value="source" className="flex flex-col flex-1 min-h-0 mt-2">
          <ScriptSourceEditor
            source={script.source}
            typeDefs={typeDefs}
            className="flex-1 min-h-[320px]"
          />
        </TabsContent>

        <TabsContent value="runs" className="flex flex-col flex-1 min-h-0 mt-2 gap-3">
          <ScriptRunsGrid
            rows={runs}
            loading={runsLoading}
            hideNameColumn
            paginationQueryKey="scriptRuns"
          />
        </TabsContent>

        <TabsContent
          value="versions"
          className="flex flex-col flex-1 min-h-0 mt-2 gap-4 lg:flex-row"
        >
          <div className="flex min-h-[260px] flex-col lg:min-h-0 lg:flex-[2]">
            <DataGrid
              rowData={versions ?? []}
              columnDefs={versionColumns}
              onRowClicked={onVersionRowClicked}
              loading={versionsLoading}
              emptyMessage="No versions recorded"
              pagination={false}
            />
          </div>
          <ScriptSourceEditor
            source={selectedVersion?.source ?? ""}
            typeDefs={typeDefs}
            className="min-h-[320px] flex-1 lg:min-h-0 lg:flex-[3]"
          />
        </TabsContent>

        <TabsContent value="api" className="flex flex-col flex-1 min-h-0 mt-2">
          <ScriptApiTab
            scriptId={script.id}
            ownerAgentId={script.scopeId ?? script.createdByAgentId}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
