import type { ColDef, ICellRendererParams, RowClickedEvent } from "ag-grid-community";
import { AlertCircle, File, Folder, FolderOpen } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAgentFsLs } from "@/api/hooks/use-agent-fs";
import { OpenInAgentFsButton } from "@/components/comb/file-actions";
import { FolderComments } from "@/components/comb/folder-comments";
import { PinButton } from "@/components/comb/pin-button";
import { useAuthorLabel } from "@/components/comb/use-author-label";
import { DataGrid } from "@/components/shared/data-grid";
import { EmptyState } from "@/components/shared/empty-state";
import { MobileList, MobileListRow } from "@/components/shared/mobile-list";
import { AlertCallout } from "@/components/ui/alert-callout";
import { PageHeader } from "@/components/ui/page-header";
import { useIsMobile } from "@/hooks/use-mobile";
import { childPath, combPath, type DrivePath } from "@/lib/comb/paths";
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
}

function typeLabel(name: string, isFolder: boolean): string {
  if (isFolder) return "Folder";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : "File";
}

function NameCell({ data }: ICellRendererParams<FolderRow>) {
  if (!data) return null;
  const Icon = data.isFolder ? Folder : File;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">{data.name}</span>
    </span>
  );
}

/** One folder of the drive: a grid of its entries (a list on phones). */
export function FolderView({ folder }: { folder: DrivePath }) {
  const listing = useAgentFsLs(folder);
  const authorLabel = useAuthorLabel(folder);
  const isMobile = useIsMobile();
  const navigate = useNavigate();

  const rows = useMemo<FolderRow[]>(
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
    ],
    [],
  );

  const onRowClicked = useCallback(
    (event: RowClickedEvent<FolderRow>) => {
      if (event.data) void navigate(combPath({ ...folder, path: event.data.id }));
    },
    [navigate, folder],
  );

  if (listing.error) {
    return (
      <AlertCallout tone="error" icon={AlertCircle} title="Could not list this folder">
        {listing.error.message}
      </AlertCallout>
    );
  }

  const count = listing.data ? `${rows.length} ${rows.length === 1 ? "item" : "items"}` : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PageHeader
        title="Folder"
        description={count}
        action={
          <>
            {/* Folder actions: later steps add buttons here. The root is the Comb item, so no pin. */}
            {folder.path === "/" ? null : <PinButton target={folder} />}
            <OpenInAgentFsButton target={folder} />
          </>
        }
      />
      {listing.data && rows.length === 0 ? (
        <EmptyState
          icon={FolderOpen}
          title={folder.path === "/" ? "The drive is empty" : "This folder is empty"}
          description="Files that agents write here show up in this list."
          fullPage
        />
      ) : isMobile ? (
        <MobileList label="Folder contents" loading={listing.isPending} emptyMessage="Empty folder">
          {rows.map((row) => (
            <MobileListRow
              key={row.id}
              to={combPath({ ...folder, path: row.id })}
              title={row.name}
              leading={
                row.isFolder ? (
                  <Folder className="size-4 text-muted-foreground" aria-hidden />
                ) : (
                  <File className="size-4 text-muted-foreground" aria-hidden />
                )
              }
              meta={[
                row.type,
                row.isFolder ? null : formatBytes(row.size),
                row.modifiedAt ? formatRelative(row.modifiedAt) : null,
                row.author || null,
              ]}
            />
          ))}
        </MobileList>
      ) : (
        <DataGrid
          rowData={rows}
          columnDefs={columnDefs}
          onRowClicked={onRowClicked}
          loading={listing.isPending}
          emptyMessage="Empty folder"
          pagination={false}
        />
      )}
      {/* Open comments below the folder, with "Send N to swarm" (step-9). */}
      <FolderComments folder={folder} />
    </div>
  );
}
