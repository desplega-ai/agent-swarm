/**
 * The list layer on top of `DataGrid`: row click, the phone card list, an
 * `EmptyState` instead of overlay text, skeleton rows while the first load is
 * in flight, a highlight for the open row, and a short flash on rows that
 * arrive after the first paint.
 *
 * Dashboard list pages build this by hand around `DataGrid` + `MobileList`;
 * the swarm-apps `Table` renders through it, so app tables look and behave
 * like the native lists.
 */

import type { RowClassParams, RowClickedEvent } from "ag-grid-community";
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import { DataGrid, type DataGridProps } from "@/components/shared/data-grid";
import { MobileList, MobileListRow } from "@/components/shared/mobile-list";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobile } from "@/hooks/use-mobile";
import { isRowNavigationSuppressed } from "@/lib/grid-row-click";
import { cn } from "@/lib/utils";

export interface ListViewMobileRow {
  title: ReactNode;
  status?: ReactNode;
  meta?: ReactNode[];
  leading?: ReactNode;
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
  loading?: boolean;
  emptyMessage: string;
  /** Rendered instead of the grid (and the phone list) when there are no rows. */
  empty?: ReactNode;
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
  emptyMessage,
  empty,
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
    return (
      <div className={cn("flex flex-col gap-2", className)} data-testid="list-view-skeleton">
        {Array.from({ length: skeletonRows }, (_, index) => (
          // Placeholder rows have no identity beyond their position.
          <Skeleton key={index} className="h-9 w-full" />
        ))}
      </div>
    );
  }

  if (rows.length === 0 && empty) return <>{empty}</>;

  if (isMobile && mobileRow) {
    return (
      <MobileList label={label} emptyMessage={emptyMessage} className={className}>
        {rows.map((row, index) => {
          const id = rowId(row);
          const mobile = mobileRow(row, index);
          return (
            <MobileListRow
              key={id}
              title={mobile.title}
              status={mobile.status}
              meta={mobile.meta}
              leading={mobile.leading}
              selected={selectedId !== undefined && selectedId !== null && id === selectedId}
              onClick={onRowClick ? () => onRowClick(row, index) : undefined}
            />
          );
        })}
      </MobileList>
    );
  }

  return (
    <DataGrid
      {...gridProps}
      className={className}
      rowData={rows}
      loading={loading}
      emptyMessage={emptyMessage}
      getRowId={getRowId}
      getRowClass={getRowClass}
      rowClassKey={selectedId ?? null}
      onRowClicked={onRowClick ? onRowClicked : undefined}
    />
  );
}
