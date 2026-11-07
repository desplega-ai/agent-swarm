/**
 * The list layer on top of `DataGrid`: row click, the phone card list, an
 * `EmptyState` instead of overlay text, a table-shaped skeleton while the
 * first load is in flight, a slim progress bar for a refetch (rows stay put),
 * a highlight for the open row, and a short flash on rows that arrive after
 * the first paint.
 *
 * Dashboard list pages build this by hand around `DataGrid` + `MobileList`;
 * the swarm-apps `Table` renders through it, so app tables look and behave
 * like the native lists.
 */

import type { ColDef, RowClassParams, RowClickedEvent } from "ag-grid-community";
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import { DataGrid, type DataGridProps } from "@/components/shared/data-grid";
import {
  MobileList,
  MobileListRow,
  type MobileListTitleLines,
} from "@/components/shared/mobile-list";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobile } from "@/hooks/use-mobile";
import { isRowNavigationSuppressed } from "@/lib/grid-row-click";
import { cn } from "@/lib/utils";

export interface ListViewMobileRow {
  title: ReactNode;
  /** Title line limit (see `MobileListRow`). Defaults to 2. */
  titleLines?: MobileListTitleLines;
  status?: ReactNode;
  meta?: ReactNode[];
  leading?: ReactNode;
  /** Selection checkbox beside the row (see `MobileListRow`). */
  check?: {
    checked: boolean | "indeterminate";
    onChange: () => void;
    label: string;
    disabled?: boolean;
  };
  /** Inline controls (checkbox, switch) beside the row, each in its own 44px tap target. */
  controls?: ReactNode[];
  /** Links and buttons shown under the row. Kept outside the row, which is a button when `onRowClick` is set. */
  extras?: ReactNode;
}

export interface ListViewProps<TData>
  extends Omit<
    DataGridProps<TData>,
    | "rowData"
    | "onRowClicked"
    | "getRowId"
    | "getRowClass"
    | "rowClassKey"
    | "loading"
    | "emptyMessage"
  > {
  rows: TData[];
  /** Accessible name of the phone list. */
  label: string;
  /** First load: no rows to show yet. Renders the skeleton (only while `rows` is empty). */
  loading?: boolean;
  /**
   * Rows are showing and a refetch is in flight: a slim progress bar runs along
   * the top edge. The rows are never dimmed, covered or blanked.
   */
  refreshing?: boolean;
  emptyMessage: string;
  /** Rendered instead of the grid (and the phone list) when there are no rows. */
  empty?: ReactNode;
  /**
   * Grid layout only: with no rows, keep the grid mounted (its header, and any
   * filter input open in it) and render `empty` under it instead of in its
   * place. Needed while a header filter narrows to nothing: unmounting the grid
   * would drop the input the user is typing in.
   */
  keepGridWhenEmpty?: boolean;
  /** Stable id per row. Drives selection, the new-row flash and grid updates. */
  rowId: (row: TData) => string;
  onRowClick?: (row: TData, index: number) => void;
  /** Id of the row whose detail is open; that row is highlighted. */
  selectedId?: string | null;
  /** Phone layout. Omit to keep the grid (horizontal scroll) on phones. */
  mobileRow?: (row: TData, index: number) => ListViewMobileRow;
  /** Skeleton rows shown while the first load is in flight. */
  skeletonRows?: number;
}

/** Rows that appear after the first paint flash for this long (see ag-grid.css). */
export const LIST_VIEW_NEW_ROW_MS = 1400;

export function ListView<TData>({
  rows,
  label,
  loading = false,
  refreshing = false,
  emptyMessage,
  empty,
  keepGridWhenEmpty = false,
  rowId,
  onRowClick,
  selectedId,
  mobileRow,
  skeletonRows = 5,
  className,
  ...gridProps
}: ListViewProps<TData>) {
  const isMobile = useIsMobile();

  // Ids rendered so far. The first non-empty load primes the set, so only
  // rows that arrive later (a create, a poll) flash.
  const seenRef = useRef<Set<string> | null>(null);
  // Arrival time per id that was new at render. Recorded during render, not
  // in an effect: AG Grid draws (and asks `getRowClass`) before effects run.
  const freshRef = useRef(new Map<string, number>());
  const ids = useMemo(() => rows.map(rowId), [rows, rowId]);
  if (seenRef.current !== null) {
    const now = Date.now();
    for (const id of ids) {
      if (!seenRef.current.has(id) && !freshRef.current.has(id)) freshRef.current.set(id, now);
    }
  }
  useEffect(() => {
    if (ids.length === 0 && seenRef.current === null) return;
    const seen = seenRef.current ?? new Set<string>();
    for (const id of ids) seen.add(id);
    seenRef.current = seen;
    const now = Date.now();
    for (const [id, arrived] of freshRef.current) {
      if (now - arrived >= LIST_VIEW_NEW_ROW_MS) freshRef.current.delete(id);
    }
  }, [ids]);

  const rowIdRef = useRef(rowId);
  rowIdRef.current = rowId;
  const getRowId = useCallback((params: { data: TData }) => rowIdRef.current(params.data), []);
  const getRowClass = useCallback(
    (params: RowClassParams<TData>) => {
      if (!params.data) return undefined;
      const id = rowIdRef.current(params.data);
      const classes: string[] = [];
      if (selectedId !== undefined && selectedId !== null && id === selectedId) {
        classes.push("list-view-row-selected");
      }
      const arrived = freshRef.current.get(id);
      if (arrived !== undefined && Date.now() - arrived < LIST_VIEW_NEW_ROW_MS) {
        classes.push("list-view-row-new");
      }
      return classes;
    },
    // Drawn rows keep their classes; `rowClassKey` below redraws them when
    // the selection moves.
    [selectedId],
  );

  const onRowClickRef = useRef(onRowClick);
  onRowClickRef.current = onRowClick;
  const onRowClicked = useCallback((event: RowClickedEvent<TData>) => {
    if (!event.data || isRowNavigationSuppressed(event.event?.target)) return;
    onRowClickRef.current?.(event.data, event.rowIndex ?? 0);
  }, []);

  const firstLoad = loading && rows.length === 0;

  if (firstLoad) {
    if (isMobile && mobileRow) {
      return (
        <output
          className={cn("flex flex-col gap-2", className)}
          data-testid="list-view-skeleton"
          aria-label="Loading rows"
        >
          {Array.from({ length: skeletonRows }, (_, index) => (
            // Placeholder rows have no identity beyond their position.
            <Skeleton key={index} className="h-14 rounded-lg" />
          ))}
        </output>
      );
    }
    return (
      <ListSkeleton
        columnDefs={gridProps.columnDefs}
        rowCount={skeletonRows}
        rowHeight={gridProps.rowHeight}
        className={className}
      />
    );
  }

  const phoneRow = isMobile ? mobileRow : undefined;
  const keepGrid = keepGridWhenEmpty && phoneRow === undefined;

  if (rows.length === 0 && empty && !keepGrid) {
    return (
      <div className="relative min-w-0">
        {refreshing ? <RefreshBar /> : null}
        {empty}
      </div>
    );
  }

  if (phoneRow) {
    return (
      <div className="relative min-w-0">
        {refreshing ? <RefreshBar /> : null}
        <MobileList label={label} emptyMessage={emptyMessage} className={className}>
          {rows.map((row, index) => {
            const id = rowId(row);
            const mobile = phoneRow(row, index);
            return (
              <MobileListRow
                key={id}
                title={mobile.title}
                titleLines={mobile.titleLines}
                status={mobile.status}
                meta={mobile.meta}
                leading={mobile.leading}
                check={mobile.check}
                controls={mobile.controls}
                extras={mobile.extras}
                selected={selectedId !== undefined && selectedId !== null && id === selectedId}
                onClick={onRowClick ? () => onRowClick(row, index) : undefined}
              />
            );
          })}
        </MobileList>
      </div>
    );
  }

  return (
    <div className="relative min-w-0">
      {refreshing ? <RefreshBar /> : null}
      <DataGrid
        {...gridProps}
        className={className}
        rowData={rows}
        // Loading is the skeleton's job (first load) and the refresh bar's
        // (refetch). AG Grid's own overlay would cover the rows.
        loading={false}
        emptyMessage={emptyMessage}
        getRowId={getRowId}
        getRowClass={getRowClass}
        rowClassKey={selectedId ?? null}
        onRowClicked={onRowClick ? onRowClicked : undefined}
      />
      {rows.length === 0 ? empty : null}
    </div>
  );
}

/** Slim indeterminate bar on the top edge of the list; announces the refetch to screen readers. */
function RefreshBar() {
  return (
    <output
      aria-label="Refreshing"
      data-testid="list-view-refreshing"
      className="pointer-events-none absolute inset-x-0 top-0 z-10 block h-[3px] overflow-hidden rounded-t-xl"
    >
      <span className="list-view-refresh-bar block h-full w-1/3 rounded-full bg-primary" />
    </output>
  );
}

/** Cell widths cycle through these so the placeholder rows do not read as a grid of equal bars. */
const SKELETON_WIDTHS = ["72%", "56%", "84%", "48%", "64%", "78%"];

/**
 * The shape of the table while it loads: its header labels over placeholder
 * rows, one cell per visible column, so nothing jumps when the rows arrive.
 */
function ListSkeleton<TData>({
  columnDefs,
  rowCount,
  rowHeight,
  className,
}: {
  columnDefs: ColDef<TData>[];
  rowCount: number;
  rowHeight?: number;
  className?: string;
}) {
  const columns = columnDefs.filter((column) => !column.hide);
  const template = columns
    .map((column) =>
      column.width && !column.flex
        ? `${column.width}px`
        : `minmax(${column.minWidth ?? 80}px, 1fr)`,
    )
    .join(" ");
  const height = rowHeight ?? 42;
  return (
    <output
      aria-label="Loading rows"
      data-testid="list-view-skeleton"
      className={cn("block min-w-0 overflow-hidden rounded-xl border border-border", className)}
    >
      <div className="overflow-hidden">
        <div
          className="grid items-center border-b border-border bg-muted/30 px-1"
          style={{ gridTemplateColumns: template, height: 48 }}
        >
          {columns.map((column, index) => (
            <span
              key={column.colId ?? column.field ?? index}
              className="truncate px-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
            >
              {typeof column.headerName === "string" ? column.headerName : ""}
            </span>
          ))}
        </div>
        {Array.from({ length: rowCount }, (_, row) => (
          <div
            // Placeholder rows have no identity beyond their position.
            key={row}
            className="grid items-center border-b border-border-subtle px-1 last:border-b-0"
            style={{ gridTemplateColumns: template, height }}
          >
            {columns.map((column, index) => (
              <span key={column.colId ?? column.field ?? index} className="px-3">
                <Skeleton
                  className="h-3.5"
                  style={{ width: SKELETON_WIDTHS[(row + index) % SKELETON_WIDTHS.length] }}
                />
              </span>
            ))}
          </div>
        ))}
      </div>
    </output>
  );
}
