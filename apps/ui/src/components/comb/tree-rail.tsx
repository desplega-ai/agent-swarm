import { useQueries } from "@tanstack/react-query";
import { ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { agentFsLsQuery, useAgentFsAccess } from "@/api/hooks/use-agent-fs";
import { PinnedList } from "@/components/comb/pinned-list";
import { ancestorFolders, type CombLocation, combPath, parentFolder } from "@/lib/comb/paths";
import { type FolderListing, flattenTree, visibleFolders } from "@/lib/comb/tree";
import { cn } from "@/lib/utils";

const STATUS_TEXT = { loading: "Loading…", error: "Could not load", empty: "Empty" } as const;

/** The folders that lead to `location` (and the folder itself), without the root. */
function foldersToOpen(location: CombLocation): string[] {
  return ancestorFolders(location.path).filter((folder) => folder !== "/");
}

function indent(level: number): string {
  return `${0.25 + (level - 1) * 0.75}rem`;
}

/**
 * The drive as a lazy tree. A folder lists its children only while it is
 * open. The folders on the way to the current path open on their own.
 * Keyboard: Up/Down move, Right opens or enters a folder, Left closes it or
 * goes to the parent, Home/End jump, Enter opens the row.
 */
function DriveTree({
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
  const rows = flattenTree((folder): FolderListing => {
    const result = byFolder.get(folder);
    if (result?.data) return result.data.entries;
    return result?.error ? "error" : "loading";
  }, expanded);
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
        if (!expanded.has(row.path)) setOpen(row.path, true);
        else if ((entries[index + 1]?.level ?? 0) > row.level) focusRow(entries[index + 1]?.path);
        break;
      case "ArrowLeft":
        if (row.isFolder && expanded.has(row.path)) setOpen(row.path, false);
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

  if (rows.length === 0) {
    return <p className="px-3 py-2 text-sm text-muted-foreground">The drive is empty.</p>;
  }
  // The root is not listed yet (a root status row is the only row).
  const [first] = rows;
  if (first?.kind === "status") {
    return <p className="px-3 py-2 text-sm text-muted-foreground">{STATUS_TEXT[first.status]}</p>;
  }

  return (
    <div
      role="tree"
      aria-label="Drive files"
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
        const open = row.isFolder && expanded.has(row.path);
        const selected = row.path === currentPath;
        const Icon = row.isFolder ? (open ? FolderOpen : Folder) : File;
        return (
          <div
            key={row.path}
            role="none"
            className={cn(
              "hover-linger flex items-center rounded-md pr-2 transition-colors hover:bg-accent/50",
              selected && "bg-accent font-medium text-foreground",
            )}
            style={{ paddingLeft: indent(row.level) }}
          >
            {row.isFolder ? (
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
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{row.name}</span>
            </Link>
          </div>
        );
      })}
    </div>
  );
}

/** The Comb side rail: the pinned list (step-12) on top of the drive tree. */
export function TreeRail(props: Parameters<typeof DriveTree>[0]) {
  return (
    <>
      <PinnedList location={props.location} onNavigate={props.onNavigate} />
      <DriveTree {...props} />
    </>
  );
}
