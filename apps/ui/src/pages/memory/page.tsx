import type { ColDef, ICellRendererParams, RowClickedEvent } from "ag-grid-community";
import {
  Activity,
  BarChart3,
  FileText,
  Quote,
  Search,
  Target,
  Trash2,
  TrendingUp,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useAgents } from "@/api/hooks/use-agents";
import { useDeleteMemory, useMemoryList } from "@/api/hooks/use-memory";
import { useMemoryUsefulness } from "@/api/hooks/use-memory-usefulness";
import type { MemoryEntry, MemoryListRequest, MemoryScopeFilter, MemorySource } from "@/api/types";
import { Spinner } from "@/components/kibo-ui/spinner";
import { SharedBarChart } from "@/components/shared/charts/nivo-charts";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { DataGrid } from "@/components/shared/data-grid";
import { ListPager, resolveListPage } from "@/components/shared/list-pager";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatPanel } from "@/components/ui/stat-panel";
import { readNumberParam, readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { formatTokens } from "@/lib/format-tokens";
import { cn, formatSmartTime } from "@/lib/utils";
import { LONGTERM_ROOT, LongtermView } from "./longterm-view";
import { formatRating, type MemoryDeleteTarget, MemoryDetailSheet } from "./memory-detail-sheet";

const ANY_AGENT = "__all__";
const ANY_SCOPE: MemoryScopeFilter = "all";
const ANY_SOURCE = "__any__";

type MemoryView = "longterm" | "all";
const DEFAULT_VIEW: MemoryView = "longterm";
const VIEW_OPTIONS = [
  { value: "longterm", label: "Longterm", tooltip: "Keyed memories under /longterm, by folder" },
  { value: "all", label: "All memories", tooltip: "Every memory row, with search and filters" },
] as const;

const SOURCE_OPTIONS: { value: MemorySource; label: string }[] = [
  { value: "manual", label: "manual" },
  { value: "file_index", label: "file_index" },
  { value: "session_summary", label: "session_summary" },
  { value: "task_completion", label: "task_completion" },
];
const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 50;

function coerceMemoryScope(value: string | null): MemoryScopeFilter {
  return value === "agent" || value === "swarm" ? value : ANY_SCOPE;
}

function coerceMemorySource(value: string | null): string {
  return value && SOURCE_OPTIONS.some((option) => option.value === value) ? value : ANY_SOURCE;
}

function coerceMemoryView(value: string | null): MemoryView {
  return value === "all" || value === "longterm" ? value : DEFAULT_VIEW;
}

function truncate(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export default function MemoryPage() {
  const { data: agents } = useAgents();
  const { searchParams, setParam, setParams } = useUrlSearchState();
  const view = coerceMemoryView(searchParams.get("view"));
  const folderParam = readStringParam(searchParams, "folder", LONGTERM_ROOT);
  const queryParam = readStringParam(searchParams, "query");
  const pathParam = readStringParam(searchParams, "path");
  const agentIdParam = readStringParam(searchParams, "agentId", ANY_AGENT);
  const scopeParam = coerceMemoryScope(searchParams.get("scope"));
  const sourceParam = coerceMemorySource(searchParams.get("source"));
  const page = readNumberParam(searchParams, "page", 0, { min: 0 });
  const pageSize = readNumberParam(searchParams, "pageSize", DEFAULT_PAGE_SIZE, {
    allowed: PAGE_SIZE_OPTIONS,
  });

  // Form state — what the user is editing
  const [draftQuery, setDraftQuery] = useState(queryParam);
  const [draftPath, setDraftPath] = useState(pathParam);
  const [draftAgentId, setDraftAgentId] = useState<string>(agentIdParam);
  const [draftScope, setDraftScope] = useState<MemoryScopeFilter>(scopeParam);
  const [draftSource, setDraftSource] = useState<string>(sourceParam);

  const submitted = useMemo<MemoryListRequest>(
    () => ({
      query: queryParam.trim() || undefined,
      sourcePath: pathParam.trim() || undefined,
      agentId: agentIdParam === ANY_AGENT ? undefined : agentIdParam,
      scope: scopeParam,
      source: sourceParam === ANY_SOURCE ? undefined : (sourceParam as MemorySource),
      limit: pageSize,
      offset: page * pageSize,
    }),
    [agentIdParam, page, pageSize, pathParam, queryParam, scopeParam, sourceParam],
  );

  const { data, isLoading, isFetching, error } = useMemoryList(submitted, view === "all");

  // The detail sheet loads the memory by id, so a ?memoryId= deep link opens
  // whether or not the row is on the current page or view.
  const selectedId = searchParams.get("memoryId");
  const [deleteTarget, setDeleteTarget] = useState<MemoryDeleteTarget | null>(null);
  const deleteMemory = useDeleteMemory();

  const openMemory = useCallback(
    (memoryId: string | null) => setParam("memoryId", memoryId),
    [setParam],
  );

  useEffect(() => {
    setDraftQuery(queryParam);
    setDraftPath(pathParam);
    setDraftAgentId(agentIdParam);
    setDraftScope(scopeParam);
    setDraftSource(sourceParam);
  }, [agentIdParam, pathParam, queryParam, scopeParam, sourceParam]);

  const submit = useCallback(() => {
    setParams(
      {
        query: draftQuery.trim(),
        path: draftPath.trim(),
        agentId: draftAgentId,
        scope: draftScope,
        source: draftSource,
      },
      {
        defaultValues: {
          agentId: ANY_AGENT,
          scope: ANY_SCOPE,
          source: ANY_SOURCE,
        },
        reset: ["page"],
      },
    );
  }, [draftAgentId, draftPath, draftQuery, draftScope, draftSource, setParams]);

  const clear = useCallback(() => {
    setDraftQuery("");
    setDraftPath("");
    setDraftAgentId(ANY_AGENT);
    setDraftScope(ANY_SCOPE);
    setDraftSource(ANY_SOURCE);
    setParams(
      {
        query: "",
        path: "",
        agentId: ANY_AGENT,
        scope: ANY_SCOPE,
        source: ANY_SOURCE,
        page: "0",
        pageSize: String(DEFAULT_PAGE_SIZE),
      },
      {
        defaultValues: {
          agentId: ANY_AGENT,
          scope: ANY_SCOPE,
          source: ANY_SOURCE,
          page: "0",
          pageSize: String(DEFAULT_PAGE_SIZE),
        },
      },
    );
  }, [setParams]);

  const handleConfirmDelete = useCallback(() => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    deleteMemory.mutate(id, {
      onSettled: () => {
        setDeleteTarget(null);
        if (selectedId === id) openMemory(null);
      },
    });
  }, [deleteMemory, deleteTarget, openMemory, selectedId]);

  const agentName = useCallback(
    (id: string | null) => {
      if (!id) return "—";
      const a = agents?.find((x) => x.id === id);
      return a?.name ?? `${id.slice(0, 8)}…`;
    },
    [agents],
  );

  const isSemantic = data?.mode === "semantic";

  const columnDefs = useMemo<ColDef<MemoryEntry>[]>(() => {
    const cols: ColDef<MemoryEntry>[] = [];

    if (isSemantic) {
      cols.push({
        field: "similarity",
        headerName: "Sim",
        width: 80,
        sort: "desc",
        valueFormatter: (p) => (typeof p.value === "number" ? p.value.toFixed(3) : ""),
      });
    }

    cols.push(
      {
        field: "name",
        headerName: "Name",
        flex: 1,
        minWidth: 200,
        cellRenderer: (p: ICellRendererParams<MemoryEntry, string>) => (
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="font-medium truncate">{p.value}</span>
            {p.data && p.data.totalChunks > 1 && (
              <Badge variant="outline" size="tag" className="shrink-0 font-mono">
                chunk {p.data.chunkIndex + 1}/{p.data.totalChunks}
              </Badge>
            )}
          </span>
        ),
      },
      {
        field: "key",
        headerName: "Key",
        width: 220,
        cellRenderer: (p: ICellRendererParams<MemoryEntry, string | null | undefined>) =>
          p.value ? (
            <span className="block truncate font-mono text-xs" title={p.value}>
              {p.value}
            </span>
          ) : (
            <span className="text-muted-foreground/40">—</span>
          ),
      },
      {
        field: "agentId",
        headerName: "Agent",
        width: 140,
        valueFormatter: (p) => agentName(p.value as string | null),
      },
      {
        field: "scope",
        headerName: "Scope",
        width: 90,
        cellRenderer: (p: ICellRendererParams<MemoryEntry, string>) => (
          <Badge variant="outline" size="tag">
            {p.value}
          </Badge>
        ),
      },
      {
        field: "source",
        headerName: "Source",
        width: 150,
        cellRenderer: (p: ICellRendererParams<MemoryEntry, string>) => (
          <Badge variant="outline" size="tag">
            {p.value}
          </Badge>
        ),
      },
      {
        field: "accessCount",
        headerName: "Usage",
        width: 100,
        type: "rightAligned",
      },
      {
        field: "rating",
        headerName: "Rating",
        width: 90,
        type: "rightAligned",
        headerTooltip: "Usefulness posterior mean alpha / (alpha + beta). Muted = 0.5 prior",
        cellRenderer: (p: ICellRendererParams<MemoryEntry, number | undefined>) => (
          <span className={cn("tabular-nums", p.value === 0.5 && "text-muted-foreground/60")}>
            {formatRating(p.value ?? undefined)}
          </span>
        ),
      },
      {
        colId: "tokens",
        headerName: "Tokens",
        width: 90,
        type: "rightAligned",
        headerTooltip: "Estimated tokens of this row: ceil(chars / 4)",
        valueGetter: (p) => (p.data ? Math.ceil(p.data.content.length / 4) : 0),
        valueFormatter: (p) => (typeof p.value === "number" ? formatTokens(p.value) : ""),
      },
      {
        colId: "updated",
        headerName: "Updated",
        width: 120,
        valueGetter: (p) => p.data?.updatedAt ?? p.data?.createdAt ?? "",
        valueFormatter: (p) => (p.value ? formatSmartTime(p.value as string) : ""),
      },
      {
        field: "content",
        headerName: "Preview",
        flex: 1,
        minWidth: 200,
        cellRenderer: (p: ICellRendererParams<MemoryEntry, string>) => (
          <span className="text-muted-foreground">{truncate(p.value ?? "")}</span>
        ),
      },
      {
        headerName: "",
        width: 60,
        sortable: false,
        cellRenderer: (p: ICellRendererParams<MemoryEntry>) => {
          const row = p.data;
          if (!row) return null;
          return (
            <Button
              size="icon"
              variant="destructive-outline"
              className="h-7 w-7"
              aria-label={`Delete memory ${row.name}`}
              onClick={(e) => {
                e.stopPropagation();
                setDeleteTarget({ id: row.id, name: row.name, chunked: row.totalChunks > 1 });
              }}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          );
        },
      },
    );

    return cols;
  }, [agentName, isSemantic]);

  const onRowClicked = useCallback(
    (event: RowClickedEvent<MemoryEntry>) => {
      const target = event.event?.target as HTMLElement | undefined;
      if (target?.closest("button")) return;
      if (event.data) openMemory(event.data.id);
    },
    [openMemory],
  );

  const results = data?.results ?? [];
  const total = data?.total ?? 0;

  // Same stale-page correction as Tasks. Waits for the total, so a deep link
  // to page 3 is not reset to page 0 before the first response lands.
  const { page: listPage, stale: pageStale } = resolveListPage(page, pageSize, data?.total);
  useEffect(() => {
    if (view === "all" && pageStale) setParam("page", listPage, { defaultValue: "0" });
  }, [listPage, pageStale, setParam, view]);

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader
        title="Memory"
        action={
          <SegmentedControl
            aria-label="Memory view"
            size="sm"
            value={view}
            options={VIEW_OPTIONS}
            onValueChange={(next) => setParam("view", next, { defaultValue: DEFAULT_VIEW })}
          />
        }
      />

      <UsefulnessSection />

      {view === "longterm" ? (
        <LongtermView
          folder={folderParam}
          onFolderChange={(next) => setParam("folder", next, { defaultValue: LONGTERM_ROOT })}
          onOpenMemory={openMemory}
          agentName={agentName}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[260px] max-w-md">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Natural-language query (leave empty to browse)"
                value={draftQuery}
                onChange={(e) => setDraftQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
                className="pl-9"
              />
            </div>

            <div className="relative w-[240px]">
              <FileText className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="File path contains…"
                value={draftPath}
                onChange={(e) => setDraftPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
                className="pl-9"
              />
            </div>

            <Select value={draftAgentId} onValueChange={setDraftAgentId}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Agent" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY_AGENT}>All agents</SelectItem>
                {agents?.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={draftScope} onValueChange={(v) => setDraftScope(v as MemoryScopeFilter)}>
              <SelectTrigger className="w-[130px]">
                <SelectValue placeholder="Scope" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All scopes</SelectItem>
                <SelectItem value="agent">Agent</SelectItem>
                <SelectItem value="swarm">Swarm</SelectItem>
              </SelectContent>
            </Select>

            <Select value={draftSource} onValueChange={setDraftSource}>
              <SelectTrigger className="w-[170px]">
                <SelectValue placeholder="Source" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY_SOURCE}>All sources</SelectItem>
                {SOURCE_OPTIONS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              size="sm"
              className="gap-1.5 bg-primary hover:bg-primary/90"
              onClick={submit}
              disabled={isFetching}
            >
              {isFetching ? <Spinner className="size-3.5" /> : <Search className="h-3.5 w-3.5" />}
              Search
            </Button>
            <Button size="sm" variant="outline" onClick={clear}>
              Clear
            </Button>

            <div className="flex items-center gap-2 ml-auto">
              {data && (
                <>
                  <Badge variant="outline" size="tag">
                    {data.mode}
                  </Badge>
                  <Badge variant="outline" size="tag">
                    {total} {data.mode === "semantic" ? "matches" : "memories"}
                  </Badge>
                  <Badge variant="outline" size="tag">
                    {results.length} shown
                  </Badge>
                </>
              )}
              {error && (
                <span className="text-sm text-status-error-strong truncate max-w-[280px]">
                  {error instanceof Error ? error.message : "Search failed"}
                </span>
              )}
            </div>
          </div>

          <DataGrid
            rowData={results}
            columnDefs={columnDefs}
            loading={isLoading || pageStale}
            emptyMessage={
              submitted.query ? "No matches for this query" : "No memories — try a different filter"
            }
            onRowClicked={onRowClicked}
            getRowId={(p) => p.data.id}
            pagination={false}
          />

          <ListPager
            page={listPage}
            pageSize={pageSize}
            total={total}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            onPageChange={(next) => setParam("page", next, { defaultValue: "0" })}
            onPageSizeChange={(size) =>
              setParam("pageSize", String(size), {
                defaultValue: String(DEFAULT_PAGE_SIZE),
                reset: ["page"],
              })
            }
            emptyLabel={data?.mode === "semantic" ? "0 matches" : "0 memories"}
          />
        </>
      )}

      <MemoryDetailSheet
        memoryId={selectedId}
        onClose={() => openMemory(null)}
        agentName={agentName}
        onDelete={setDeleteTarget}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Memory</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.chunked ? (
                <>
                  Delete this chunk of <strong>{deleteTarget?.name}</strong>? This removes one chunk
                  row and its embedding. The other chunks of the memory stay. This action cannot be
                  undone.
                </>
              ) : (
                <>
                  Delete <strong>{deleteTarget?.name}</strong>? This removes the memory and its
                  embedding. This action cannot be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleConfirmDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Windowed usefulness readout from `GET /api/memory/usefulness` — summary
 * tiles (retrieval volume, overall citation rate, posterior movement) plus
 * per-source citation-rate and per-arm retrieval charts. Hidden entirely
 * while loading and on older API servers (the hook resolves to `null`).
 */
function UsefulnessSection() {
  const { data: stats } = useMemoryUsefulness();

  if (!stats) return null;

  const totalRetrievals = stats.byArm.reduce((sum, arm) => sum + arm.retrievals, 0);
  const citedRetrievals = stats.byArm.reduce((sum, arm) => sum + arm.citedRetrievals, 0);
  const citationRate = totalRetrievals > 0 ? citedRetrievals / totalRetrievals : 0;

  const armRows = stats.byArm.map((arm) => ({
    arm: prettyLabel(arm.retrievalSource ?? "legacy"),
    retrievals: arm.retrievals,
    cited: arm.citedRetrievals,
  }));
  const sourceRows = stats.citationBySource.map((row) => ({
    source: prettyLabel(row.source),
    "citation rate": row.citationRate,
  }));

  return (
    <CollapsibleSection
      title={`Usefulness — last ${stats.windowDays}d`}
      icon={BarChart3}
      defaultOpen={false}
      persistKey="memory-usefulness-open"
      className="shrink-0"
      badge={
        <Badge variant="outline" size="tag">
          {Math.round(citationRate * 100)}% cited
        </Badge>
      }
    >
      <div className="space-y-3 pt-1">
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <StatPanel
            icon={Activity}
            label={`Retrievals (${stats.volume.distinctMemories} memories, ${stats.volume.retrievalGroups} searches)`}
            info="How many times memories were surfaced to tasks via memory search/get in the window, with distinct memories and search-call counts."
            value={stats.volume.retrievals}
            tone="info"
          />
          <StatPanel
            icon={Quote}
            label="Citation rate"
            info="Share of surfaced memories that the task then actually cited in its evidence (implicit-citation rater)."
            value={`${Math.round(citationRate * 100)}%`}
            tone="success"
          />
          <StatPanel
            icon={TrendingUp}
            label="Posteriors moved"
            info="Memories whose usefulness estimate has moved off the neutral starting prior (i.e. we have at least one real signal for them), out of all memories."
            value={`${stats.posterior.movedFromPrior} / ${stats.posterior.totalMemories}`}
            tone="active"
          />
          <StatPanel
            icon={Target}
            label={`Above ${stats.threshold} posterior mean`}
            info={`Memories whose estimated usefulness is above the ${stats.threshold} threshold — the ones the system currently considers useful.`}
            value={stats.posterior.aboveThreshold}
          />
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <ChartCard
            title="Citation rate by memory source"
            info="Of the memories surfaced in the window, the share that tasks went on to cite — grouped by how the memory was created (manual, file index, session summary, task completion)."
          >
            {sourceRows.length > 0 ? (
              <SharedBarChart
                data={sourceRows}
                indexBy="source"
                keys={["citation rate"]}
                height={190}
                maxValue={1}
                yTickCount={5}
                padding={0.45}
                valueFormatter={formatRateAsPercent}
              />
            ) : (
              <ChartEmpty>No implicit-citation ratings in window</ChartEmpty>
            )}
          </ChartCard>
          <ChartCard
            title="Retrievals by arm"
            info="Search retrievals grouped by which retrieval strategy surfaced them (hybrid, fts, vec, graph; legacy = older rows without provenance) — total vs how many were then cited."
          >
            {armRows.length > 0 ? (
              <SharedBarChart
                data={armRows}
                indexBy="arm"
                keys={["retrievals", "cited"]}
                height={190}
                yTickCount={5}
                padding={0.35}
                showLegend
                valueFormatter={formatCount}
                axisFormatter={formatCompactCount}
              />
            ) : (
              <ChartEmpty>No retrievals in window</ChartEmpty>
            )}
          </ChartCard>
        </div>
      </div>
    </CollapsibleSection>
  );
}

/** "task_completion" → "task completion" — human-readable chart labels. */
function prettyLabel(value: string): string {
  return value.replaceAll("_", " ");
}

/** 0.42 → "42%" — for rate charts on a fixed 0–1 scale. */
function formatRateAsPercent(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : String(value);
}

/** 24012 → "24,012" — full count for tooltips. */
function formatCount(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : String(value);
}

/** 24000 → "24k" for axis ticks; hides fractional ticks on small ranges. */
function formatCompactCount(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return "";
  return new Intl.NumberFormat("en-US", { notation: "compact" }).format(n);
}

function ChartCard({
  title,
  info,
  children,
}: {
  title: string;
  info?: string;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0 gap-2 rounded-md py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-1.5 text-sm">
          {title}
          {info ? <InfoTip content={info} /> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-2">{children}</CardContent>
    </Card>
  );
}

function ChartEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="mx-2 flex h-[190px] items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
      {children}
    </div>
  );
}
