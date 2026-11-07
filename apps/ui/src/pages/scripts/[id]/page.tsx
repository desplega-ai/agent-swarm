import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { Copy } from "lucide-react";
import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useScriptRuns } from "@/api/hooks/use-script-runs";
import { useScript, useScriptTypeDefs, useScriptVersions } from "@/api/hooks/use-scripts";
import type { ScriptVersion } from "@/api/types";
import { SavingsHeaderAmount, SavingsTab } from "@/components/savings/workflow-savings";
import { ScriptApiTab } from "@/components/scripts/script-api-tab";
import { ScriptRunsGrid, ScriptRunsStatusFilter } from "@/components/scripts/script-runs-grid";
import { ScriptSourceEditor } from "@/components/scripts/script-source-editor";
import { ActionSheetItem } from "@/components/sessions-v2/mobile/action-sheet";
import { DataGrid } from "@/components/shared/data-grid";
import { DetailHeader } from "@/components/shared/detail-header";
import { MobileList, MobileListRow } from "@/components/shared/mobile-list";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useIsPhone } from "@/hooks/use-mobile";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { formatSmartTime } from "@/lib/utils";

// Server cap on GET /api/script-runs.
const RUNS_FETCH_LIMIT = 500;

const TABS = ["source", "runs", "savings", "versions", "api"] as const;
type Tab = (typeof TABS)[number];

export default function ScriptDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { searchParams, setParam } = useUrlSearchState();
  const tabParam = readStringParam(searchParams, "tab", "source");
  const activeTab: Tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : "source";

  const isPhone = useIsPhone();
  const { copy } = useCopyToClipboard();
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
    // Compact DetailHeader + sticky tabs. On a
    // phone the page scrolls as one column: header, sticky tabs, full-height
    // source. On desktop the source still fills the remaining height.
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      <DetailHeader
        back={{ to: "/scripts", label: "Scripts" }}
        title={script.name}
        badges={
          isPhone
            ? undefined
            : [
                <Badge key="scope" variant="outline" size="tag">
                  {script.scope}
                </Badge>,
                <Badge key="version" variant="outline" size="tag" className="font-mono">
                  v{script.version}
                </Badge>,
                script.isScratch ? (
                  <Badge key="scratch" variant="outline" size="tag">
                    SCRATCH
                  </Badge>
                ) : null,
              ]
        }
        status={
          isPhone ? (
            <span className="flex min-w-0 items-center gap-2">
              <Badge variant="outline" size="tag">
                {script.scope}
              </Badge>
              <Badge variant="outline" size="tag" className="font-mono">
                v{script.version}
              </Badge>
              <SavingsHeaderAmount
                target={{ scriptName: script.name }}
                onOpen={() => setParam("tab", "savings", { defaultValue: "source" })}
              />
            </span>
          ) : (
            <SavingsHeaderAmount
              target={{ scriptName: script.name }}
              onOpen={() => setParam("tab", "savings", { defaultValue: "source" })}
            />
          )
        }
        more={
          <>
            <ActionSheetItem icon={Copy} label="Copy name" onSelect={() => copy(script.name)} />
            <ActionSheetItem icon={Copy} label="Copy source" onSelect={() => copy(script.source)} />
          </>
        }
        description={script.description || undefined}
      />

      <Tabs
        value={activeTab}
        onValueChange={(value) => setParam("tab", value, { defaultValue: "source" })}
        className="flex flex-col flex-1 min-h-0 gap-2 max-md:flex-none"
      >
        {/* Desktop: the Runs filter shares the tab row instead of taking its own. */}
        <div className="flex items-center gap-3 max-md:contents">
          <TabsList sticky>
            <TabsTrigger value="source">Source</TabsTrigger>
            <TabsTrigger value="runs">Runs{runs.length ? ` ${runs.length}` : ""}</TabsTrigger>
            <TabsTrigger value="savings">Savings</TabsTrigger>
            <TabsTrigger value="versions">
              Versions{versions?.length ? ` ${versions.length}` : ""}
            </TabsTrigger>
            <TabsTrigger value="api">API</TabsTrigger>
          </TabsList>
          {activeTab === "runs" && !isPhone ? (
            <ScriptRunsStatusFilter paginationQueryKey="scriptRuns" />
          ) : null}
        </div>

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
            hideToolbar={!isPhone}
            paginationQueryKey="scriptRuns"
          />
        </TabsContent>

        <TabsContent
          value="versions"
          className="flex flex-col flex-1 min-h-0 mt-2 gap-4 lg:flex-row"
        >
          {isPhone ? (
            <MobileList
              label="Versions"
              loading={versionsLoading}
              emptyMessage="No versions recorded"
              className="flex-none"
            >
              {(versions ?? []).map((v) => (
                <MobileListRow
                  key={v.id}
                  onClick={() => setSelectedVersionId(v.id)}
                  selected={selectedVersion?.id === v.id}
                  title={<span className="font-mono">v{v.version}</span>}
                  titleLines={1}
                  meta={[
                    v.changedAt ? formatSmartTime(v.changedAt) : null,
                    v.changeReason || null,
                    <span key="h" className="font-mono">
                      {v.contentHash?.slice(0, 8)}
                    </span>,
                  ]}
                />
              ))}
            </MobileList>
          ) : (
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
          )}
          <ScriptSourceEditor
            label={selectedVersion ? `v${selectedVersion.version}` : undefined}
            source={selectedVersion?.source ?? ""}
            typeDefs={typeDefs}
            className="min-h-[320px] flex-1 lg:min-h-0 lg:flex-[3]"
          />
        </TabsContent>

        <TabsContent value="savings" className="flex flex-col flex-1 min-h-0 mt-2">
          <SavingsTab target={{ scriptName: script.name }} />
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
