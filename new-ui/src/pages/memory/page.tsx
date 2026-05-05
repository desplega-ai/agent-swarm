import type { ColDef, ICellRendererParams, RowClickedEvent } from "ag-grid-community";
import { Brain, FileText, Loader2, Search, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Streamdown } from "streamdown";
import { useAgents } from "@/api/hooks/use-agents";
import { useDeleteMemory, useMemoryList } from "@/api/hooks/use-memory";
import type { MemoryEntry, MemoryListRequest, MemoryScopeFilter, MemorySource } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
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
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { formatSmartTime } from "@/lib/utils";

const ANY_AGENT = "__all__";
const ANY_SCOPE: MemoryScopeFilter = "all";
const ANY_SOURCE = "__any__";

const SOURCE_OPTIONS: { value: MemorySource; label: string }[] = [
  { value: "manual", label: "manual" },
  { value: "file_index", label: "file_index" },
  { value: "session_summary", label: "session_summary" },
  { value: "task_completion", label: "task_completion" },
];

function truncate(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export default function MemoryPage() {
  const { data: agents } = useAgents();

  // Form state — what the user is editing
  const [draftQuery, setDraftQuery] = useState("");
  const [draftPath, setDraftPath] = useState("");
  const [draftAgentId, setDraftAgentId] = useState<string>(ANY_AGENT);
  const [draftScope, setDraftScope] = useState<MemoryScopeFilter>(ANY_SCOPE);
  const [draftSource, setDraftSource] = useState<string>(ANY_SOURCE);

  // Submitted params — what's actually being queried
  const [submitted, setSubmitted] = useState<MemoryListRequest>({ limit: 50, scope: ANY_SCOPE });

  const { data, isLoading, isFetching, error } = useMemoryList(submitted);

  const [selected, setSelected] = useState<MemoryEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MemoryEntry | null>(null);
  const deleteMemory = useDeleteMemory();

  const submit = useCallback(() => {
    setSubmitted({
      query: draftQuery.trim() || undefined,
      sourcePath: draftPath.trim() || undefined,
      agentId: draftAgentId === ANY_AGENT ? undefined : draftAgentId,
      scope: draftScope,
      source: draftSource === ANY_SOURCE ? undefined : (draftSource as MemorySource),
      limit: 50,
    });
  }, [draftQuery, draftPath, draftAgentId, draftScope, draftSource]);

  const clear = useCallback(() => {
    setDraftQuery("");
    setDraftPath("");
    setDraftAgentId(ANY_AGENT);
    setDraftScope(ANY_SCOPE);
    setDraftSource(ANY_SOURCE);
    setSubmitted({ limit: 50, scope: ANY_SCOPE });
  }, []);

  const handleConfirmDelete = useCallback(() => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    deleteMemory.mutate(id, {
      onSettled: () => {
        setDeleteTarget(null);
        if (selected?.id === id) setSelected(null);
      },
    });
  }, [deleteMemory, deleteTarget, selected]);

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
        minWidth: 180,
        cellRenderer: (p: ICellRendererParams<MemoryEntry, string>) => (
          <span className="font-medium">{p.value}</span>
        ),
      },
      {
        field: "agentId",
        headerName: "Agent",
        width: 160,
        valueFormatter: (p) => agentName(p.value as string | null),
      },
      {
        field: "scope",
        headerName: "Scope",
        width: 100,
        cellRenderer: (p: ICellRendererParams<MemoryEntry, string>) => (
          <Badge variant="outline" size="tag">
            {p.value}
          </Badge>
        ),
      },
      {
        field: "source",
        headerName: "Source",
        width: 160,
        cellRenderer: (p: ICellRendererParams<MemoryEntry, string>) => (
          <Badge variant="outline" size="tag">
            {p.value}
          </Badge>
        ),
      },
      {
        field: "sourcePath",
        headerName: "File",
        width: 220,
        cellRenderer: (p: ICellRendererParams<MemoryEntry, string | null>) =>
          p.value ? (
            <span className="font-mono text-xs text-muted-foreground" title={p.value}>
              {p.value}
            </span>
          ) : (
            <span className="text-muted-foreground/40">—</span>
          ),
      },
      {
        field: "createdAt",
        headerName: "Created",
        width: 140,
        valueFormatter: (p) => (p.value ? formatSmartTime(p.value as string) : ""),
      },
      {
        field: "content",
        headerName: "Preview",
        flex: 2,
        minWidth: 240,
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
              onClick={(e) => {
                e.stopPropagation();
                setDeleteTarget(row);
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

  const onRowClicked = useCallback((event: RowClickedEvent<MemoryEntry>) => {
    const target = event.event?.target as HTMLElement | undefined;
    if (target?.closest("button")) return;
    if (event.data) setSelected(event.data);
  }, []);

  const results = data?.results ?? [];

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <div className="flex items-center gap-2">
        <Brain className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Memory</h1>
        <span className="text-sm text-muted-foreground ml-2">
          Inspect and search the agent memory store
        </span>
      </div>

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
          {isFetching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Search className="h-3.5 w-3.5" />
          )}
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
                {results.length} {results.length === 1 ? "result" : "results"}
              </Badge>
            </>
          )}
          {error && (
            <span className="text-sm text-red-400 truncate max-w-[280px]">
              {error instanceof Error ? error.message : "Search failed"}
            </span>
          )}
        </div>
      </div>

      <DataGrid
        rowData={results}
        columnDefs={columnDefs}
        loading={isLoading}
        emptyMessage={
          submitted.query ? "No matches for this query" : "No memories — try a different filter"
        }
        onRowClicked={onRowClicked}
        getRowId={(p) => p.data.id}
      />

      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-[640px] sm:max-w-[640px] p-0">
          {selected && (
            <div className="flex flex-col h-full">
              <SheetHeader className="px-6 py-4 border-b border-border">
                <SheetTitle className="flex items-center gap-2">
                  <Brain className="h-4 w-4 text-muted-foreground" />
                  {selected.name}
                </SheetTitle>
                <SheetDescription className="font-mono text-xs">{selected.id}</SheetDescription>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <Badge variant="outline" size="tag">
                    {selected.scope}
                  </Badge>
                  <Badge variant="outline" size="tag">
                    {selected.source}
                  </Badge>
                  {typeof selected.similarity === "number" && (
                    <Badge variant="outline" size="tag">
                      sim {selected.similarity.toFixed(3)}
                    </Badge>
                  )}
                  {selected.tags.map((t) => (
                    <Badge key={t} variant="outline" size="tag">
                      {t}
                    </Badge>
                  ))}
                </div>
              </SheetHeader>

              <ScrollArea className="flex-1 min-h-0">
                <div className="px-6 py-4 space-y-4">
                  <DetailRow label="Agent" value={agentName(selected.agentId)} />
                  <DetailRow label="Created" value={formatSmartTime(selected.createdAt)} />
                  <DetailRow label="Accessed" value={formatSmartTime(selected.accessedAt)} />
                  <DetailRow label="Access count" value={String(selected.accessCount)} />
                  {selected.expiresAt && (
                    <DetailRow label="Expires" value={formatSmartTime(selected.expiresAt)} />
                  )}
                  {selected.embeddingModel && (
                    <DetailRow label="Embedding model" value={selected.embeddingModel} />
                  )}
                  {selected.sourceTaskId && (
                    <DetailRow label="Source task" value={selected.sourceTaskId} mono />
                  )}
                  {selected.sourcePath && (
                    <DetailRow label="Source path" value={selected.sourcePath} mono />
                  )}
                  {selected.totalChunks > 1 && (
                    <DetailRow
                      label="Chunk"
                      value={`${selected.chunkIndex + 1} of ${selected.totalChunks}`}
                    />
                  )}

                  <div>
                    <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                      Content
                    </div>
                    <div className="rounded-md border border-border bg-muted/30 px-3 py-2 prose prose-sm dark:prose-invert max-w-none">
                      <Streamdown>{selected.content}</Streamdown>
                    </div>
                  </div>
                </div>
              </ScrollArea>

              <div className="border-t border-border px-6 py-3 flex justify-end">
                <Button
                  variant="destructive-outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setDeleteTarget(selected)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete memory
                </Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Memory</AlertDialogTitle>
            <AlertDialogDescription>
              Delete <strong>{deleteTarget?.name}</strong>? This removes the memory and its
              embedding. This action cannot be undone.
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

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={mono ? "font-mono text-xs break-all" : "text-sm"}>{value}</div>
    </div>
  );
}
