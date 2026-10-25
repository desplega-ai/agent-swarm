import type { ColDef, ICellRendererParams, RowClickedEvent } from "ag-grid-community";
import { AlertCircle, FolderOpen } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAgentFsLs, useCombSearch } from "@/api/hooks/use-agent-fs";
import { CombHome } from "@/components/comb/comb-home";
import { OpenInAgentFsButton } from "@/components/comb/file-actions";
import { FileKindIcon } from "@/components/comb/file-icon";
import {
  CopyPathButton,
  FileContextMenu,
  FileMenuButton,
  NewEntryButton,
} from "@/components/comb/file-menu";
import { FilterInput } from "@/components/comb/filter-input";
import { FolderComments } from "@/components/comb/folder-comments";
import { PinButton } from "@/components/comb/pin-button";
import { UploadButton, UploadDropZone, UploadList } from "@/components/comb/upload-zone";
import { useAuthorLabel } from "@/components/comb/use-author-label";
import { useUrlDraft } from "@/components/comb/use-url-draft";
import { DataGrid } from "@/components/shared/data-grid";
import { EmptyState } from "@/components/shared/empty-state";
import { MobileList, MobileListRow } from "@/components/shared/mobile-list";
import { AlertCallout } from "@/components/ui/alert-callout";
import { MiddleTruncation } from "@/components/ui/middle-truncation";
import { PageHeader } from "@/components/ui/page-header";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useIsMobile } from "@/hooks/use-mobile";
import { FILTER_PARAM, matchesName, nestedMatches } from "@/lib/comb/folder-filter";
import { childPath, combPath, type DrivePath } from "@/lib/comb/paths";
import { MIN_NAME_QUERY_LENGTH } from "@/lib/comb/search";
import { sortEntries } from "@/lib/comb/tree";
import { formatBytes } from "@/lib/format-bytes";
import { formatRelative } from "@/lib/relative-time";

interface FolderRow {
  /** Drive path of the entry (folders end with "/"). */
  id: string;
  name: string;
  isFolder: boolean;
  type: string;
  size: number;
  modifiedAt?: string;
  author: string;
  /** A filter match in a subfolder: `name` is its path below this folder. */
  nested?: boolean;
}

function typeLabel(name: string, isFolder: boolean): string {
  if (isFolder) return "Folder";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : "File";
}

function NameCell({ data }: ICellRendererParams<FolderRow>) {
  if (!data) return null;
  // A subfolder match: the file name first, then its subfolder, muted.
  const cut = data.nested ? data.name.lastIndexOf("/") : -1;
  const name = cut === -1 ? data.name : data.name.slice(cut + 1);
  return (
    <span className="flex w-full min-w-0 items-center gap-2">
      <FileKindIcon name={name} isFolder={data.isFolder} />
      {cut === -1 ? (
        <MiddleTruncation>{name}</MiddleTruncation>
      ) : (
        <>
          <span className="max-w-[70%] shrink-0 truncate" title={name}>
            {name}
          </span>
          <MiddleTruncation className="text-xs text-muted-foreground">
            {data.name.slice(0, cut + 1)}
          </MiddleTruncation>
        </>
      )}
    </span>
  );
}

/**
 * One folder of the drive: a grid of its entries (a list on phones). Files
 * upload here with the Upload button or a drop on the view.
 */
export function FolderView({ folder }: { folder: DrivePath }) {
  const listing = useAgentFsLs(folder);
  const authorLabel = useAuthorLabel(folder);
  const isMobile = useIsMobile();
  const navigate = useNavigate();

  // `?filter=`: the folder's own entries whose names hold every typed word,
  // then deeper files from `find` scoped to this folder. The filter is part of
  // the URL, so it can be shared and Back brings it back.
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = searchParams.get(FILTER_PARAM) ?? "";
  const setFilter = useCallback(
    (value: string) =>
      setSearchParams(
        (params) => {
          const next = new URLSearchParams(params);
          if (value) next.set(FILTER_PARAM, value);
          else next.delete(FILTER_PARAM);
          return next;
        },
        { replace: true },
      ),
    [setSearchParams],
  );
  const [draft, setDraft] = useUrlDraft(filter, setFilter);
  const deepQuery = useDebouncedValue(draft.trim(), 200);
  const deep = useCombSearch(
    folder,
    "name",
    deepQuery.length >= MIN_NAME_QUERY_LENGTH ? deepQuery : "",
    folder.path,
  );

  const allRows = useMemo<FolderRow[]>(
    () =>
      sortEntries(listing.data?.entries ?? []).map((entry) => {
        const isFolder = entry.type === "directory";
        return {
          id: childPath(folder.path, entry.name, isFolder),
          name: entry.name,
          isFolder,
          type: typeLabel(entry.name, isFolder),
          size: entry.size,
          modifiedAt: entry.modifiedAt,
          author: authorLabel(entry.author),
        };
      }),
    [listing.data, folder.path, authorLabel],
  );
  const rows = useMemo<FolderRow[]>(() => {
    const query = draft.trim();
    if (!query) return allRows;
    const own = allRows.filter((row) => matchesName(row.name, query));
    const below =
      deepQuery === query && deepQuery.length >= MIN_NAME_QUERY_LENGTH
        ? nestedMatches(deep.data?.hits ?? [], folder.path).map(
            (match): FolderRow => ({
              id: match.path,
              name: match.relative,
              isFolder: false,
              type: typeLabel(match.relative, false),
              size: match.size ?? 0,
              modifiedAt: match.modifiedAt,
              author: "",
              nested: true,
            }),
          )
        : [];
    return [...own, ...below];
  }, [allRows, draft, deepQuery, deep.data, folder.path]);

  const { orgId, driveId } = folder;
  const columnDefs = useMemo<ColDef<FolderRow>[]>(
    () => [
      { field: "name", headerName: "Name", flex: 2, minWidth: 160, cellRenderer: NameCell },
      { field: "type", headerName: "Type", width: 90 },
      {
        field: "size",
        headerName: "Size",
        width: 90,
        valueFormatter: ({ data }) => (data && !data.isFolder ? formatBytes(data.size) : ""),
      },
      {
        field: "modifiedAt",
        headerName: "Modified",
        width: 110,
        valueFormatter: ({ value }) => (value ? formatRelative(value as string) : ""),
      },
      { field: "author", headerName: "Author", flex: 1, minWidth: 120 },
      {
        colId: "menu",
        headerName: "",
        width: 52,
        sortable: false,
        resizable: false,
        cellRenderer: ({ data }: ICellRendererParams<FolderRow>) =>
          data ? (
            <span data-row-menu className="flex h-full items-center">
              <FileMenuButton target={{ orgId, driveId, path: data.id }} />
            </span>
          ) : null,
      },
    ],
    [orgId, driveId],
  );

  const onRowClicked = useCallback(
    (event: RowClickedEvent<FolderRow>) => {
      // The "..." button opens its menu, not the row.
      const target = event.event?.target;
      if (target instanceof Element && target.closest("[data-row-menu]")) return;
      if (event.data) void navigate(combPath({ ...folder, path: event.data.id }));
    },
    [navigate, folder],
  );
  // One right-click menu for the grid: the row under the pointer (AG Grid's `row-id` is the path).
  const pickRow = useCallback(
    (element: Element): DrivePath | null => {
      const id = element.closest("[row-id]")?.getAttribute("row-id");
      return id?.startsWith("/") ? { orgId, driveId, path: id } : null;
    },
    [orgId, driveId],
  );

  if (listing.error) {
    return (
      <AlertCallout tone="error" icon={AlertCircle} title="Could not list this folder">
        {listing.error.message}
      </AlertCallout>
    );
  }

  const items = (count: number) => `${count} ${count === 1 ? "item" : "items"}`;
  const nestedCount = rows.filter((row) => row.nested).length;
  const count = !listing.data
    ? ""
    : draft.trim()
      ? `${rows.length - nestedCount} of ${items(allRows.length)}${nestedCount ? `, ${nestedCount} in subfolders` : ""}`
      : items(allRows.length);

  return (
    <UploadDropZone folder={folder}>
      <PageHeader
        title="Folder"
        description={count}
        action={
          <>
            <FilterInput
              value={draft}
              onChange={setDraft}
              label="Filter this folder"
              className="hidden w-56 sm:flex"
            />
            <NewEntryButton folder={folder} />
            <UploadButton folder={folder} />
            {/* The root is the Comb item, so no pin. */}
            {folder.path === "/" ? null : <PinButton target={folder} className="size-8" />}
            {folder.path === "/" ? null : <CopyPathButton target={folder} />}
            <OpenInAgentFsButton target={folder} iconOnly />
          </>
        }
      />
      {/* Phones: the filter takes its own row under the header. */}
      <FilterInput
        value={draft}
        onChange={setDraft}
        label="Filter this folder"
        className="mb-3 sm:hidden"
      />
      <UploadList />
      {/* The drive root is the Comb home: favorites, recently viewed, recently changed. */}
      {folder.path === "/" ? <CombHome drive={folder} /> : null}
      {listing.data && allRows.length === 0 ? (
        <EmptyState
          icon={FolderOpen}
          title={folder.path === "/" ? "The drive is empty" : "This folder is empty"}
          description="Files that agents write here show up in this list. Drop files here to upload them."
          fullPage
        />
      ) : isMobile ? (
        <MobileList
          label="Folder contents"
          loading={listing.isPending}
          emptyMessage={draft ? "No items match the filter" : "Empty folder"}
          // Full height: the folder scrolls as one page on a phone.
          className="flex-none overflow-visible"
        >
          {rows.map((row) => (
            // A long press opens the file menu.
            <FileContextMenu key={row.id} target={{ ...folder, path: row.id }}>
              <div>
                <MobileListRow
                  to={combPath({ ...folder, path: row.id })}
                  title={row.name}
                  leading={<FileKindIcon name={row.name} isFolder={row.isFolder} />}
                  meta={[
                    row.type,
                    row.isFolder ? null : formatBytes(row.size),
                    row.modifiedAt ? formatRelative(row.modifiedAt) : null,
                    row.author || null,
                  ]}
                />
              </div>
            </FileContextMenu>
          ))}
        </MobileList>
      ) : (
        <FileContextMenu pick={pickRow}>
          {/* `contents`: the grid keeps its place in the page layout. */}
          <div className="contents">
            <DataGrid
              rowData={rows}
              columnDefs={columnDefs}
              onRowClicked={onRowClicked}
              loading={listing.isPending}
              emptyMessage={draft ? "No items match the filter" : "Empty folder"}
              pagination={false}
              // The listing keeps room for about six rows. Below that the folder scrolls.
              className="min-h-72"
            />
          </div>
        </FileContextMenu>
      )}
      {/* Open comments below the folder: send to swarm, resolve in bulk. */}
      <FolderComments folder={folder} />
    </UploadDropZone>
  );
}
