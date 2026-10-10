import type { ColDef, ICellRendererParams, RowClickedEvent } from "ag-grid-community";
import { AlertTriangle, ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMemoryKeys } from "@/api/hooks/use-memory";
import type { MemoryKeySummary } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatTokens } from "@/lib/format-tokens";
import {
  ancestorFolderPaths,
  buildKeyTree,
  type KeyFolder,
  normalizeFolderPath,
} from "@/lib/memory-key-tree";
import { cn, formatSmartTime } from "@/lib/utils";
import { formatRating } from "./memory-detail-sheet";

export const LONGTERM_ROOT = "/longterm/";

function hasRatingSignal(row: MemoryKeySummary): boolean {
  return row.usefulRatings + row.notUsefulRatings > 0 || row.alpha !== row.beta;
}

/**
 * Keyed memories under /longterm: a folder tree of key paths on the left,
 * one row per memory (chunks grouped) for the selected folder on the right.
 */
export function LongtermView({
  folder,
  onFolderChange,
  onOpenMemory,
  agentName,
}: {
  folder: string;
  onFolderChange: (folder: string) => void;
  onOpenMemory: (memoryId: string) => void;
  agentName: (id: string | null) => string;
}) {
  const { data, isLoading, error } = useMemoryKeys(LONGTERM_ROOT);
  const keys = data?.keys ?? [];
  const tree = useMemo(() => buildKeyTree(keys, LONGTERM_ROOT), [keys]);
  const selectedFolder = normalizeFolderPath(folder || LONGTERM_ROOT);

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(ancestorFolderPaths(LONGTERM_ROOT, selectedFolder)),
  );
  useEffect(() => {
    const open = ancestorFolderPaths(LONGTERM_ROOT, selectedFolder);
    setExpanded((prev) => (open.every((f) => prev.has(f)) ? prev : new Set([...prev, ...open])));
  }, [selectedFolder]);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const rows = useMemo(
    () => keys.filter((k) => k.key.startsWith(selectedFolder)),
    [keys, selectedFolder],
  );
  const neverUsed = rows.filter((r) => r.accessCount === 0).length;
  const incomplete = rows.filter((r) => !r.complete).length;
  const tokens = rows.reduce((sum, r) => sum + r.estTokens, 0);

  const columnDefs = useMemo<ColDef<MemoryKeySummary>[]>(
    () => [
      {
        field: "key",
        headerName: "Key",
        flex: 2,
        minWidth: 260,
        cellRenderer: (p: ICellRendererParams<MemoryKeySummary, string>) => (
          <span className="block truncate font-mono text-xs" title={p.value ?? ""}>
            {(p.value ?? "").slice(selectedFolder.length)}
          </span>
        ),
      },
      {
        field: "name",
        headerName: "Name",
        flex: 1,
        minWidth: 180,
        cellRenderer: (p: ICellRendererParams<MemoryKeySummary, string>) => (
          <span className="font-medium">{p.value}</span>
        ),
      },
      {
        field: "accessCount",
        headerName: "Usage",
        width: 110,
        type: "rightAligned",
        sort: "desc",
        headerTooltip: "accessCount summed over chunks: memory-get, search hits, prompt injection",
      },
      {
        field: "rating",
        headerName: "Rating",
        width: 100,
        type: "rightAligned",
        headerTooltip: "Usefulness posterior mean alpha / (alpha + beta). Muted = no ratings yet",
        cellRenderer: (p: ICellRendererParams<MemoryKeySummary, number>) => (
          <span
            className={cn(
              "tabular-nums",
              p.data && !hasRatingSignal(p.data) && "text-muted-foreground/60",
            )}
          >
            {formatRating(p.value ?? undefined)}
          </span>
        ),
      },
      {
        field: "estTokens",
        headerName: "Tokens",
        width: 100,
        type: "rightAligned",
        headerTooltip: "Estimated tokens: ceil(chars / 4) over all chunks",
        valueFormatter: (p) => (typeof p.value === "number" ? formatTokens(p.value) : ""),
      },
      {
        field: "chunkRows",
        headerName: "Chunks",
        width: 100,
        type: "rightAligned",
        cellRenderer: (p: ICellRendererParams<MemoryKeySummary, number>) =>
          p.data && !p.data.complete ? (
            <span
              className="inline-flex items-center gap-1 text-status-warning-strong"
              title={`${p.data.chunkRows} rows present, rows claim up to ${p.data.totalChunks}`}
            >
              <AlertTriangle className="h-3 w-3" />
              {p.value}/{p.data.totalChunks}
            </span>
          ) : (
            <span className="tabular-nums">{p.value}</span>
          ),
      },
      {
        field: "agentId",
        headerName: "Scope",
        width: 160,
        valueGetter: (p) =>
          p.data ? (p.data.scope === "swarm" ? "swarm" : agentName(p.data.agentId)) : "",
      },
      {
        field: "updatedAt",
        headerName: "Updated",
        width: 130,
        valueFormatter: (p) => (p.value ? formatSmartTime(p.value as string) : ""),
      },
    ],
    [agentName, selectedFolder],
  );

  const onRowClicked = useCallback(
    (event: RowClickedEvent<MemoryKeySummary>) => {
      if (event.data) onOpenMemory(event.data.memoryId);
    },
    [onOpenMemory],
  );

  return (
    <div className="flex flex-1 min-h-0 gap-4">
      <aside
        aria-label="Longterm memory folders"
        className="hidden md:flex w-[280px] shrink-0 flex-col rounded-md border border-border"
      >
        <div className="px-3 py-2 border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
          Key tree
        </div>
        <ScrollArea className="flex-1 min-h-0">
          <ul className="py-1 text-sm">
            <FolderRow
              folder={tree}
              level={0}
              expanded={expanded}
              selectedFolder={selectedFolder}
              onToggle={toggle}
              onSelect={onFolderChange}
              onOpenMemory={onOpenMemory}
            />
          </ul>
        </ScrollArea>
      </aside>

      <div className="flex flex-1 min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm break-all">{selectedFolder}</span>
          <Badge variant="outline" size="tag">
            {rows.length} {rows.length === 1 ? "memory" : "memories"}
          </Badge>
          <Badge variant="outline" size="tag">
            {neverUsed} never used
          </Badge>
          <Badge variant="outline" size="tag">
            {formatTokens(tokens)} tokens
          </Badge>
          {incomplete > 0 && (
            <Badge variant="outline" size="tag" className="text-status-warning-strong">
              {incomplete} with chunk mismatch
            </Badge>
          )}
          {data?.truncated && (
            <Badge variant="outline" size="tag">
              truncated
            </Badge>
          )}
          {error && (
            <span className="text-sm text-status-error-strong">
              {error instanceof Error ? error.message : "Could not load keys"}
            </span>
          )}
        </div>
        <DataGrid
          rowData={rows}
          columnDefs={columnDefs}
          loading={isLoading}
          emptyMessage="No memories under this folder"
          onRowClicked={onRowClicked}
          getRowId={(p) => p.data.memoryId}
          pagination={false}
        />
      </div>
    </div>
  );
}

function FolderRow({
  folder,
  level,
  expanded,
  selectedFolder,
  onToggle,
  onSelect,
  onOpenMemory,
}: {
  folder: KeyFolder<MemoryKeySummary>;
  level: number;
  expanded: ReadonlySet<string>;
  selectedFolder: string;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onOpenMemory: (memoryId: string) => void;
}) {
  const isOpen = expanded.has(folder.path);
  const isSelected = selectedFolder === folder.path;
  const Icon = isOpen ? FolderOpen : Folder;
  const pad = { paddingLeft: `${0.5 + level * 0.75}rem` };

  return (
    <li>
      <button
        type="button"
        aria-expanded={isOpen}
        aria-current={isSelected ? "true" : undefined}
        onClick={() => {
          onSelect(folder.path);
          if (!isOpen || isSelected) onToggle(folder.path);
        }}
        className={cn(
          "flex w-full items-center gap-1.5 py-1 pr-2 text-left hover:bg-muted/50",
          isSelected && "bg-muted font-medium",
        )}
        style={pad}
      >
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform", {
            "rotate-90": isOpen,
          })}
        />
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate flex-1">{level === 0 ? folder.path : folder.name}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{folder.count}</span>
      </button>
      {isOpen && (
        <ul>
          {folder.folders.map((child) => (
            <FolderRow
              key={child.path}
              folder={child}
              level={level + 1}
              expanded={expanded}
              selectedFolder={selectedFolder}
              onToggle={onToggle}
              onSelect={onSelect}
              onOpenMemory={onOpenMemory}
            />
          ))}
          {folder.leaves.map((leaf) => (
            <li key={leaf.item.memoryId}>
              <button
                type="button"
                onClick={() => onOpenMemory(leaf.item.memoryId)}
                title={leaf.item.key}
                className="flex w-full items-center gap-1.5 py-1 pr-2 text-left hover:bg-muted/50"
                style={{ paddingLeft: `${0.5 + (level + 1) * 0.75 + 0.95}rem` }}
              >
                <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate flex-1 font-mono text-xs">{leaf.name}</span>
                {!leaf.item.complete && (
                  <AlertTriangle
                    className="h-3 w-3 shrink-0 text-status-warning-strong"
                    aria-label="Chunk mismatch"
                  />
                )}
                <span className="text-xs tabular-nums text-muted-foreground">
                  {leaf.item.accessCount}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
