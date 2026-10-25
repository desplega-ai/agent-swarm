import { useQueries } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { agentFsLsQuery, useAgentFsAccess, useCombSearch } from "@/api/hooks/use-agent-fs";
import { FileKindIcon } from "@/components/comb/file-icon";
import { FileContextMenu, FileMenuButton } from "@/components/comb/file-menu";
import { FilterInput } from "@/components/comb/filter-input";
import { PresenceDots } from "@/components/comb/presence-avatars";
import { MiddleTruncation } from "@/components/ui/middle-truncation";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { AgentFsError } from "@/lib/agent-fs/client";
import { matchesName } from "@/lib/comb/folder-filter";
import { ancestorFolders, type CombLocation, combPath, parentFolder } from "@/lib/comb/paths";
import { isUnknownOpError, MIN_NAME_QUERY_LENGTH } from "@/lib/comb/search";
import {
  type FolderListing,
  flattenTree,
  matchTree,
  nameParts,
  type TreeRow,
  visibleFolders,
} from "@/lib/comb/tree";
import { cn } from "@/lib/utils";

const STATUS_TEXT = { loading: "Loading…", error: "Could not load", empty: "Empty" } as const;

/** The folders that lead to `location` (and the folder itself), without the root. */
function foldersToOpen(location: CombLocation): string[] {
  return ancestorFolders(location.path).filter((folder) => folder !== "/");
}

function indent(level: number): string {
  return `${0.25 + (level - 1) * 0.75}rem`;
}

/** A row name, cut in the middle to fit. A cut name shows in full in a tooltip on hover. */
function RowName({ name }: { name: string }) {
  const [cut, setCut] = useState(false);
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open && cut} onOpenChange={setOpen} disableHoverableContent>
      <TooltipTrigger asChild>
        <span className="flex min-w-0 flex-1">
          <MiddleTruncation title={undefined} onTruncatedChange={setCut}>
            {name}
          </MiddleTruncation>
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-96 break-all">
        {name}
      </TooltipContent>
    </Tooltip>
  );
}

/** A filtered row's name: the query words marked, cut at the end to fit. */
function MatchName({ name, query }: { name: string; query: string }) {
  return (
    <span className="min-w-0 flex-1 truncate" title={name}>
      {nameParts(name, query).map((part, index) =>
        part.hit ? (
          <mark key={index} className="rounded-xs bg-primary/25 text-inherit">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </span>
  );
}

/** What a filter found, for the line under the box. */
interface FilterResult {
  /** The matched files as a tree (every folder open). */
  rows: TreeRow[];
  /** A line under the box: the count, a wait, or why the list is short. */
  note: string;
}

/**
 * The tree filter: drive-wide file names through `find` (2 characters at
 * least, the best 50). An agent-fs without `find` filters the folders the
 * tree has loaded.
 */
function useTreeFilter(
  drive: { orgId: string; driveId: string },
  query: string,
  loaded: readonly TreeRow[],
): FilterResult | null {
  const trimmed = query.trim();
  const active = trimmed.length >= MIN_NAME_QUERY_LENGTH;
  const found = useCombSearch(drive, "name", active ? trimmed : "");
  if (!active) return null;
  if (found.error && isUnknownOpError(found.error, "find")) {
    // Every typed word, like the folder filter.
    const paths = loaded
      .filter(
        (row): row is Extract<TreeRow, { kind: "entry" }> =>
          row.kind === "entry" && !row.isFolder && matchesName(row.name, trimmed),
      )
      .map((row) => row.path);
    return {
      rows: matchTree(paths),
      note: "Open folders only. Update agent-fs to filter the whole drive.",
    };
  }
  if (found.error) {
    // A server error can name storage internals: say only that it failed.
    const status = found.error instanceof AgentFsError ? found.error.status : 0;
    const note =
      status >= 400 && status < 500 ? found.error.message : "The filter failed. Try again.";
    return { rows: [], note };
  }
  if (!found.data || found.isPlaceholderData) {
    return {
      rows: found.data ? matchTree(found.data.hits.map((hit) => hit.path)) : [],
      note: "Filtering…",
    };
  }
  const { hits, total } = found.data;
  const note =
    hits.length === 0
      ? `No files match “${trimmed}”.`
      : total > hits.length
        ? `${hits.length} of ${total} files. Type more to narrow it.`
        : `${hits.length} ${hits.length === 1 ? "file" : "files"}`;
  return { rows: matchTree(hits.map((hit) => hit.path)), note };
}

/**
 * The Files tab: the drive as a lazy tree. A folder lists its children only
 * while it is open. The folders on the way to the current path open on their
 * own. Keyboard: Up/Down move, Right opens or enters a folder, Left closes it
 * or goes to the parent, Home/End jump, Enter opens the row.
 *
 * The filter box on top narrows the tree to matching file names across the
 * drive (`useTreeFilter`). It stays while the person opens the matches.
 */
export function TreeRail({
  location,
  onNavigate,
}: {
  location: CombLocation;
  /** Called when a row opens a file or folder (the phone sheet closes on it). */
  onNavigate?: () => void;
}) {
  const access = useAgentFsAccess();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(foldersToOpen(location)),
  );
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const itemRefs = useRef(new Map<string, HTMLAnchorElement>());

  const { orgId, driveId, path: currentPath, isFolder } = location;
  useEffect(() => {
    const open = foldersToOpen({ orgId, driveId, path: currentPath, isFolder });
    setExpanded((prev) => (open.every((f) => prev.has(f)) ? prev : new Set([...prev, ...open])));
  }, [orgId, driveId, currentPath, isFolder]);

  // Only the folder in view polls. Other open folders refetch when they open
  // and on window focus.
  const currentFolder = isFolder ? currentPath : parentFolder(currentPath);
  const folders = visibleFolders(expanded);
  const listings = useQueries({
    queries: folders.map((path) => {
      const query = agentFsLsQuery(access, { orgId, driveId, path });
      return path === currentFolder ? query : { ...query, refetchInterval: false as const };
    }),
  });
  const byFolder = new Map(folders.map((folder, index) => [folder, listings[index]]));
  const driveRows = flattenTree((folder): FolderListing => {
    const result = byFolder.get(folder);
    if (result?.data) return result.data.entries;
    return result?.error ? "error" : "loading";
  }, expanded);

  const [filter, setFilter] = useState("");
  const debouncedFilter = useDebouncedValue(filter, 200);
  const filtered = useTreeFilter({ orgId, driveId }, debouncedFilter, driveRows);
  const rows = filtered ? filtered.rows : driveRows;
  // A filtered tree shows every folder open, and the arrows never close one.
  const isOpen = (path: string) => (filtered ? true : expanded.has(path));
  const entries = rows.filter((row) => row.kind === "entry");

  const tabStop =
    entries.find((row) => row.path === focusPath)?.path ??
    entries.find((row) => row.path === currentPath)?.path ??
    entries[0]?.path;

  // Scroll the current row into view once per navigation, as soon as the row
  // exists. Opening or loading another folder does not move the rail.
  const scrolledTo = useRef<string | null>(null);
  const rowCount = rows.length;
  useEffect(() => {
    if (rowCount === 0 || scrolledTo.current === currentPath) return;
    const row = itemRefs.current.get(currentPath);
    if (!row) return;
    row.scrollIntoView({ block: "nearest" });
    scrolledTo.current = currentPath;
  }, [currentPath, rowCount]);

  // Status rows are visual only. Each one describes its folder's treeitem.
  const idPrefix = useId();
  const statusIds = new Map<string, string>();
  for (const [index, row] of rows.entries()) {
    if (row.kind === "status") statusIds.set(row.folder, `${idPrefix}-status-${index}`);
  }
  const busy = rows.some((row) => row.kind === "status" && row.status === "loading");

  const setOpen = (path: string, open: boolean) =>
    setExpanded((prev) => {
      if (prev.has(path) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(path);
      else next.delete(path);
      return next;
    });

  const focusRow = (path: string | undefined) => {
    if (!path) return;
    setFocusPath(path);
    itemRefs.current.get(path)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    const index = entries.findIndex((row) => row.path === target?.dataset.path);
    const row = entries[index];
    if (!row) return;
    switch (event.key) {
      case "ArrowDown":
        focusRow(entries[index + 1]?.path);
        break;
      case "ArrowUp":
        focusRow(entries[index - 1]?.path);
        break;
      case "Home":
        focusRow(entries[0]?.path);
        break;
      case "End":
        focusRow(entries[entries.length - 1]?.path);
        break;
      case "ArrowRight":
        if (!row.isFolder) return;
        if (!isOpen(row.path)) setOpen(row.path, true);
        else if ((entries[index + 1]?.level ?? 0) > row.level) focusRow(entries[index + 1]?.path);
        break;
      case "ArrowLeft":
        if (row.isFolder && !filtered && expanded.has(row.path)) setOpen(row.path, false);
        else
          focusRow(
            entries
              .slice(0, index)
              .reverse()
              .find((r) => r.level < row.level)?.path,
          );
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const filterBox = (
    <div className="sticky top-0 z-10 flex flex-col gap-1 border-b border-border-subtle bg-card px-1.5 py-1.5">
      <FilterInput value={filter} onChange={setFilter} label="Filter files" compact />
      {/* The count, a wait, or a hint, read out as it changes. */}
      <p aria-live="polite" className="px-1 text-xs text-muted-foreground empty:hidden">
        {filtered?.note ?? null}
      </p>
    </div>
  );
  // The root is not listed yet (a root status row is the only row).
  const [first] = rows;
  if (rows.length === 0 || first?.kind === "status") {
    const empty =
      first?.kind === "status"
        ? STATUS_TEXT[first.status]
        : filtered
          ? null
          : "The drive is empty.";
    return (
      <>
        {filterBox}
        {empty ? <p className="px-3 py-2 text-sm text-muted-foreground">{empty}</p> : null}
      </>
    );
  }

  return (
    <>
      {filterBox}
      <div
        role="tree"
        aria-label={filtered ? "Matching files" : "Drive files"}
        aria-busy={busy}
        className="flex flex-col gap-px p-1.5 text-sm"
        onKeyDown={onKeyDown}
      >
        {rows.map((row) => {
          if (row.kind === "status") {
            return (
              <div
                key={row.key}
                id={statusIds.get(row.folder)}
                aria-hidden="true"
                className="py-1 text-xs text-muted-foreground"
                style={{ paddingLeft: `calc(${indent(row.level)} + 1.25rem)` }}
              >
                {STATUS_TEXT[row.status]}
              </div>
            );
          }
          const open = row.isFolder && isOpen(row.path);
          const selected = row.path === currentPath;
          const target = { orgId, driveId, path: row.path };
          return (
            <FileContextMenu key={row.path} target={target}>
              <div
                role="none"
                className={cn(
                  "group/row hover-linger relative flex items-center rounded-md pr-1 transition-colors hover:bg-accent/50",
                  selected && "bg-accent font-medium text-foreground",
                )}
                style={{ paddingLeft: indent(row.level) }}
              >
                {row.isFolder && !filtered ? (
                  // Mouse only: the treeitem opens and closes with the arrow keys.
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-hidden="true"
                    onClick={() => setOpen(row.path, !open)}
                    className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                  >
                    <ChevronRight className={cn("size-3.5", open && "rotate-90")} />
                  </button>
                ) : (
                  <span className="size-5 shrink-0" aria-hidden />
                )}
                <Link
                  ref={(el) => {
                    if (el) itemRefs.current.set(row.path, el);
                    else itemRefs.current.delete(row.path);
                  }}
                  to={combPath({ orgId, driveId, path: row.path })}
                  role="treeitem"
                  data-path={row.path}
                  // The visible name can be cut in the middle. The full name stays the item's name.
                  aria-label={row.name}
                  aria-level={row.level}
                  aria-setsize={row.setsize}
                  aria-posinset={row.posinset}
                  aria-expanded={row.isFolder ? open : undefined}
                  aria-describedby={statusIds.get(row.path)}
                  aria-selected={selected}
                  tabIndex={row.path === tabStop ? 0 : -1}
                  onFocus={() => setFocusPath(row.path)}
                  onClick={() => {
                    if (row.isFolder) setOpen(row.path, true);
                    onNavigate?.();
                  }}
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <FileKindIcon name={row.name} isFolder={row.isFolder} open={open} />
                  {filtered ? (
                    <MatchName name={row.name} query={debouncedFilter} />
                  ) : (
                    <RowName name={row.name} />
                  )}
                  {row.isFolder ? null : <PresenceDots path={row.path} />}
                </Link>
                {/* From md up the button shows on hover, over the end of the name, so a
                  hidden button takes no room. Touch screens have no hover: below md it
                  stays visible in the row. */}
                <FileMenuButton
                  target={target}
                  className="md:absolute md:right-1 md:bg-accent md:opacity-0 md:group-hover/row:opacity-100 md:hover:bg-accent"
                />
              </div>
            </FileContextMenu>
          );
        })}
      </div>
    </>
  );
}
