import {
  type CellKeyDownEvent,
  CellStyleModule,
  ClientSideRowModelModule,
  type ColDef,
  ColumnAutoSizeModule,
  CsvExportModule,
  type FullWidthCellKeyDownEvent,
  type GetRowIdParams,
  type GridReadyEvent,
  ModuleRegistry,
  NumberFilterModule,
  type PaginationChangedEvent,
  PaginationModule,
  QuickFilterModule,
  RowApiModule,
  type RowClassParams,
  type RowClickedEvent,
  RowStyleModule,
  TextFilterModule,
  TooltipModule,
  ValidationModule,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ListPager } from "@/components/shared/list-pager";
import { cn } from "@/lib/utils";

ModuleRegistry.registerModules([
  CellStyleModule,
  ClientSideRowModelModule,
  PaginationModule,
  TextFilterModule,
  NumberFilterModule,
  QuickFilterModule,
  RowApiModule,
  RowStyleModule,
  ColumnAutoSizeModule,
  CsvExportModule,
  TooltipModule,
  ValidationModule,
]);

const DEFAULT_PAGE_SIZE_SELECTOR = [10, 20, 50, 100];
/** The grid fills the wrapper's height minus the pager below it. */
const FILL_CONTAINER_STYLE = { flex: "1 1 0%", minHeight: 0, width: "100%" } as const;

/**
 * Mark a column low-priority with `context: HIDE_WHEN_COMPACT`. When the grid's
 * own width (not the viewport's, so an open sidebar counts) cannot hold every
 * column, marked columns are hidden until the rest fit. Lower `compactHidePriority`
 * values hide first (default 0); ties hide last-to-first. Unmarked
 * columns always stay, so a grid never loses a column on a wide screen.
 */
export const HIDE_WHEN_COMPACT = { hideWhenCompact: true } as const;

const FALLBACK_COLUMN_WIDTH = 80;

function columnWidth(col: ColDef): number {
  // `flex` columns shrink to `minWidth`; fixed columns keep `width`.
  const base = col.flex ? (col.minWidth ?? FALLBACK_COLUMN_WIDTH) : (col.width ?? col.minWidth);
  return Math.max(base ?? FALLBACK_COLUMN_WIDTH, col.minWidth ?? 0);
}

/** A column's stable id for menus and persistence: `colId`, else `field`. */
export function gridColumnId(col: ColDef): string | undefined {
  return col.colId ?? (typeof col.field === "string" ? col.field : undefined);
}

/** User choices from the columns menu, keyed by `gridColumnId`. */
export interface GridColumnOverrides {
  /** Forced visible: never auto-hidden, the grid scrolls instead. */
  show: ReadonlySet<string>;
  /** Hidden by the user. */
  hide: ReadonlySet<string>;
}

const NO_OVERRIDES: GridColumnOverrides = { show: new Set(), hide: new Set() };

/**
 * Hides marked columns by priority until the visible ones fit `containerWidth`.
 * `overrides` only apply to marked columns: `hide` removes one, `show` keeps it
 * visible without evicting another, so the grid scrolls horizontally instead.
 */
export function resolveCompactColumnDefs<TData>(
  columnDefs: ColDef<TData>[],
  containerWidth: number,
  overrides: GridColumnOverrides = NO_OVERRIDES,
): ColDef<TData>[] {
  const overrideOf = (col: ColDef<TData>) => {
    const id = col.context?.hideWhenCompact ? gridColumnId(col) : undefined;
    if (!id) return undefined;
    if (overrides.hide.has(id)) return "hide";
    if (overrides.show.has(id)) return "show";
    return undefined;
  };
  const userHidden = new Set(columnDefs.filter((col) => !col.hide && overrideOf(col) === "hide"));
  const isShown = (col: ColDef<TData>) => !col.hide && !userHidden.has(col);
  const hidden = new Set(userHidden);
  if (containerWidth > 0) {
    // A forced column adds to the width instead of evicting another: the grid scrolls.
    let total = columnDefs.reduce(
      (sum, col) => sum + (isShown(col) && overrideOf(col) !== "show" ? columnWidth(col) : 0),
      0,
    );
    const candidates = columnDefs
      .filter((col) => isShown(col) && col.context?.hideWhenCompact && overrideOf(col) !== "show")
      .reverse()
      .sort(
        (a, b) => (a.context?.compactHidePriority ?? 0) - (b.context?.compactHidePriority ?? 0),
      );
    for (const col of candidates) {
      if (total <= containerWidth) break;
      hidden.add(col);
      total -= columnWidth(col);
    }
  }
  if (hidden.size === 0) return columnDefs;
  return columnDefs.map((col) => (hidden.has(col) ? { ...col, hide: true } : col));
}

export interface DataGridColumnEntry {
  id: string;
  label: string;
  visible: boolean;
  /** Marked `HIDE_WHEN_COMPACT`: the user may show or hide it. */
  toggleable: boolean;
}

/**
 * Menu entries for the columns a grid can show: every column with an id and a
 * label, minus the ones the caller hides outright (`hide: true`).
 */
export function summarizeGridColumns<TData>(
  columnDefs: ColDef<TData>[],
  effectiveColumnDefs: ColDef<TData>[],
): { entries: DataGridColumnEntry[]; hiddenCount: number } {
  const entries: DataGridColumnEntry[] = [];
  columnDefs.forEach((col, i) => {
    const id = gridColumnId(col);
    const label = col.headerName ?? (typeof col.field === "string" ? col.field : "");
    if (!id || !label || col.hide) return;
    entries.push({
      id,
      label,
      visible: !effectiveColumnDefs[i]?.hide,
      toggleable: Boolean(col.context?.hideWhenCompact),
    });
  });
  return { entries, hiddenCount: entries.filter((entry) => !entry.visible).length };
}

export interface DataGridColumnsState {
  entries: DataGridColumnEntry[];
  hiddenCount: number;
  overrides: GridColumnOverrides;
  setVisible: (id: string, visible: boolean) => void;
  /** Called by `DataGrid` with its resolved columns; not for page code. */
  report: (summary: { entries: DataGridColumnEntry[]; hiddenCount: number }) => void;
}

const COLUMNS_STORAGE_PREFIX = "data-grid:columns:";

function toIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

function loadOverrides(storageKey: string): GridColumnOverrides {
  if (typeof window === "undefined") return NO_OVERRIDES;
  try {
    const raw = window.localStorage.getItem(COLUMNS_STORAGE_PREFIX + storageKey);
    if (!raw) return NO_OVERRIDES;
    const parsed = JSON.parse(raw) as { show?: unknown; hide?: unknown } | null;
    return { show: new Set(toIds(parsed?.show)), hide: new Set(toIds(parsed?.hide)) };
  } catch {
    return NO_OVERRIDES;
  }
}

function saveOverrides(storageKey: string, overrides: GridColumnOverrides) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      COLUMNS_STORAGE_PREFIX + storageKey,
      JSON.stringify({ show: [...overrides.show], hide: [...overrides.hide] }),
    );
  } catch {
    // Quota / private-mode failures: keep the choice in memory only.
  }
}

function sameEntries(a: DataGridColumnEntry[], b: DataGridColumnEntry[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (entry, i) =>
        entry.id === b[i].id &&
        entry.label === b[i].label &&
        entry.visible === b[i].visible &&
        entry.toggleable === b[i].toggleable,
    )
  );
}

/**
 * Column visibility for one `DataGrid`, persisted per `storageKey`. Pass the
 * result to the grid's `columns` prop and to `DataGridColumnsMenu`.
 */
export function useDataGridColumns(storageKey: string): DataGridColumnsState {
  const [overrides, setOverrides] = useState(() => loadOverrides(storageKey));
  const [summary, setSummary] = useState<{ entries: DataGridColumnEntry[]; hiddenCount: number }>({
    entries: [],
    hiddenCount: 0,
  });

  const setVisible = useCallback(
    (id: string, visible: boolean) => {
      setOverrides((prev) => {
        const show = new Set(prev.show);
        const hide = new Set(prev.hide);
        if (visible) {
          show.add(id);
          hide.delete(id);
        } else {
          hide.add(id);
          show.delete(id);
        }
        const next = { show, hide };
        saveOverrides(storageKey, next);
        return next;
      });
    },
    [storageKey],
  );

  const report = useCallback((next: { entries: DataGridColumnEntry[]; hiddenCount: number }) => {
    setSummary((prev) => (sameEntries(prev.entries, next.entries) ? prev : next));
  }, []);

  return useMemo(
    () => ({ ...summary, overrides, setVisible, report }),
    [summary, overrides, setVisible, report],
  );
}

export interface DataGridProps<TData> {
  rowData: TData[] | undefined;
  columnDefs: ColDef<TData>[];
  quickFilterText?: string;
  onRowClicked?: (event: RowClickedEvent<TData>) => void;
  loading?: boolean;
  emptyMessage?: string;
  paginationPageSize?: number;
  paginationPageSizeSelector?: number[];
  pagination?: boolean;
  paginationQueryKey?: string;
  className?: string;
  /** Extra classes for the pager row, e.g. padding when the grid sits flush in a panel. */
  pagerClassName?: string;
  domLayout?: "normal" | "autoHeight";
  enableCellTextSelection?: boolean;
  getRowId?: (params: GetRowIdParams<TData>) => string;
  /** Extra class per row, e.g. a highlight for the row whose detail is open. */
  getRowClass?: (params: RowClassParams<TData>) => string | string[] | undefined;
  /**
   * Row classes are computed when a row is drawn. Change this value to redraw
   * the rows so `getRowClass` runs again (e.g. when the selected row changes).
   */
  rowClassKey?: string | number | null;
  /**
   * Override the AG-Grid default row height (~42px on the quartz theme).
   * Set when a table renders multi-line cells and needs extra vertical
   * breathing room — e.g. the identity events table (56) so the Change
   * column can fit a richer two-line diff alongside the Time cell.
   */
  rowHeight?: number;
  /**
   * How columns claim horizontal space.
   *
   * - `"fit"` (default): imperative `sizeColumnsToFit()` on grid-ready and on
   *   real container resizes — the dashboard-wide behaviour.
   * - `"flex"`: hands sizing to AG Grid's native `flex` / `minWidth` and never
   *   calls `sizeColumnsToFit()`. Use this whenever the grid can mount at zero
   *   width (inside a hidden tab panel, a collapsed pane, a lazily revealed
   *   card): `sizeColumnsToFit()` measured against a 0px body pins every column
   *   to its `minWidth` permanently, whereas flex re-solves itself the moment
   *   the body has a width.
   */
  columnSizing?: "fit" | "flex";
  /**
   * Force AG Grid cell focus (arrow-key navigation) on for a read-only grid.
   * By default only grids with editable columns get cell focus; set this when
   * cell renderers hold interactive elements a keyboard user should reach via
   * arrow keys + Enter (pair with `onCellKeyDown` to hand focus into the cell).
   */
  cellFocus?: boolean;
  /** Grid-level cell keydown hook — see `cellFocus`. */
  onCellKeyDown?: (event: CellKeyDownEvent<TData> | FullWidthCellKeyDownEvent<TData>) => void;
  /**
   * Column visibility from `useDataGridColumns`. Render `DataGridColumnsMenu`
   * with the same state above the grid so users can reach auto-hidden columns.
   */
  columns?: DataGridColumnsState;
}

export function DataGrid<TData>({
  rowData,
  columnDefs,
  quickFilterText,
  onRowClicked,
  loading,
  emptyMessage = "No data to display",
  paginationPageSize = 20,
  paginationPageSizeSelector = DEFAULT_PAGE_SIZE_SELECTOR,
  pagination: paginationEnabled = true,
  paginationQueryKey,
  className,
  pagerClassName,
  domLayout = "normal",
  enableCellTextSelection = false,
  getRowId,
  getRowClass,
  rowClassKey,
  rowHeight,
  columnSizing = "fit",
  cellFocus,
  onCellKeyDown,
  columns,
}: DataGridProps<TData>) {
  // AG Grid's edit-on-click only works when the cell can take focus. The
  // wrapper defaults to `suppressCellFocus` for the read-only data tables
  // that are common across the dashboard, but ANY editable column needs
  // cell focus enabled or single/double-click edit silently no-ops. Auto-
  // detect by scanning the column defs.
  const hasEditableColumn = useMemo(
    () => columnDefs.some((col) => col.editable === true),
    [columnDefs],
  );
  const gridRef = useRef<AgGridReact<TData>>(null);
  const drawnRowClassKey = useRef(rowClassKey);
  useEffect(() => {
    if (drawnRowClassKey.current === rowClassKey) return;
    drawnRowClassKey.current = rowClassKey;
    gridRef.current?.api?.redrawRows();
  }, [rowClassKey]);
  // AG Grid's own paging panel is suppressed; this mirrors its state so the
  // shared `ListPager` renders the same pager the server-paged lists use.
  const [pager, setPager] = useState({ page: 0, pageSize: paginationPageSize, total: 0 });
  const [searchParams, setSearchParams] = useSearchParams();
  const pageParamName = paginationQueryKey ? `${paginationQueryKey}Page` : null;
  const pageSizeParamName = paginationQueryKey ? `${paginationQueryKey}PageSize` : null;
  const urlPage = useMemo(() => {
    if (!pageParamName) return 0;
    const parsed = Number(searchParams.get(pageParamName));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }, [pageParamName, searchParams]);
  const urlPageSize = useMemo(() => {
    if (!pageSizeParamName) return paginationPageSize;
    const parsed = Number(searchParams.get(pageSizeParamName));
    return paginationPageSizeSelector.includes(parsed) ? parsed : paginationPageSize;
  }, [pageSizeParamName, paginationPageSize, paginationPageSizeSelector, searchParams]);

  const defaultGetRowId = useCallback((params: GetRowIdParams<TData>) => {
    const data = params.data as Record<string, unknown>;
    if (data && typeof data.id === "string") return data.id;
    return JSON.stringify(params.data);
  }, []);

  const [containerWidth, setContainerWidth] = useState(0);
  // A marked column carries an explicit `hide: false` when it fits: AG Grid
  // keeps a column's last `hide` while the def leaves it undefined, so a
  // column hidden in a narrow pane would never come back when it widens.
  const overrides = columns?.overrides;
  const effectiveColumnDefs = useMemo(
    () =>
      resolveCompactColumnDefs(columnDefs, containerWidth, overrides).map((col) =>
        col.context?.hideWhenCompact && col.hide === undefined ? { ...col, hide: false } : col,
      ),
    [columnDefs, containerWidth, overrides],
  );
  // Changes whenever the set of hidden columns does, to trigger a refit.
  const hiddenKey = useMemo(
    () =>
      effectiveColumnDefs
        .map((col, i) => (col.hide && !columnDefs[i].hide ? i : -1))
        .filter((i) => i >= 0)
        .join(","),
    [effectiveColumnDefs, columnDefs],
  );
  const report = columns?.report;
  useEffect(() => {
    report?.(summarizeGridColumns(columnDefs, effectiveColumnDefs));
  }, [report, columnDefs, effectiveColumnDefs]);

  const defaultColDef = useMemo<ColDef>(
    () => ({
      resizable: true,
      sortable: true,
      suppressMovable: true,
      minWidth: 80,
    }),
    [],
  );

  const overlayNoRowsTemplate = useMemo(
    () =>
      `<div class="flex items-center justify-center p-8 text-muted-foreground">${emptyMessage}</div>`,
    [emptyMessage],
  );
  const overlayComponentParams = useMemo(
    () => ({ noMatchingRows: { overlayText: emptyMessage } }),
    [emptyMessage],
  );

  const writePaginationParams = useCallback(
    (page: number, pageSize: number) => {
      if (!pageParamName || !pageSizeParamName) return;
      const nextPageValue = page > 0 ? String(page) : null;
      const nextPageSizeValue = pageSize !== paginationPageSize ? String(pageSize) : null;
      if (
        (searchParams.get(pageParamName) ?? null) === nextPageValue &&
        (searchParams.get(pageSizeParamName) ?? null) === nextPageSizeValue
      ) {
        return;
      }
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (nextPageValue) next.set(pageParamName, nextPageValue);
          else next.delete(pageParamName);
          if (nextPageSizeValue) next.set(pageSizeParamName, nextPageSizeValue);
          else next.delete(pageSizeParamName);
          return next;
        },
        { replace: true },
      );
    },
    [pageParamName, pageSizeParamName, paginationPageSize, searchParams, setSearchParams],
  );

  const syncGridPaginationFromUrl = useCallback(
    (event: GridReadyEvent<TData> | null = null) => {
      if (!paginationEnabled || !paginationQueryKey) return;
      const api = event?.api ?? gridRef.current?.api;
      if (!api) return;
      if (api.paginationGetPageSize() !== urlPageSize) {
        api.setGridOption("paginationPageSize", urlPageSize);
      }
      if (api.paginationGetCurrentPage() !== urlPage) {
        api.paginationGoToPage(urlPage);
      }
    },
    [paginationEnabled, paginationQueryKey, urlPage, urlPageSize],
  );

  const onGridReady = useCallback(
    (event: GridReadyEvent<TData>) => {
      if (columnSizing === "fit") event.api.sizeColumnsToFit();
      syncGridPaginationFromUrl(event);
    },
    [columnSizing, syncGridPaginationFromUrl],
  );

  const onPaginationChanged = useCallback(
    (event: PaginationChangedEvent<TData>) => {
      if (!paginationEnabled) return;
      const page = event.api.paginationGetCurrentPage();
      const pageSize = event.api.paginationGetPageSize();
      const total = event.api.paginationGetRowCount();
      setPager((prev) =>
        prev.page === page && prev.pageSize === pageSize && prev.total === total
          ? prev
          : { page, pageSize, total },
      );
      if (!paginationQueryKey) return;
      writePaginationParams(page, pageSize);
    },
    [paginationEnabled, paginationQueryKey, writePaginationParams],
  );

  useEffect(() => {
    syncGridPaginationFromUrl();
  }, [syncGridPaginationFromUrl]);

  // Track container width to only re-fit columns on real container resizes,
  // not on scrollbar appear/disappear from content changes (e.g. eye icon toggle)
  const containerRef = useRef<HTMLDivElement>(null);
  const lastWidthRef = useRef<number>(0);

  useEffect(() => {
    // `flex` columns are re-solved by AG Grid itself on body resize — refitting
    // would only re-pin them to `minWidth` when the container is momentarily 0px.
    if (columnSizing === "flex") return;
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (Math.abs(width - lastWidthRef.current) > 1) {
        lastWidthRef.current = width;
        gridRef.current?.api?.sizeColumnsToFit();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [columnSizing]);

  // A grid mounted in a hidden pane measures 0px; keep the last real answer.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = (width: number) => {
      if (width > 0) setContainerWidth(Math.round(width));
    };
    update(el.clientWidth);
    const observer = new ResizeObserver((entries) => update(entries[0]?.contentRect.width ?? 0));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Hiding or showing columns changes the total width, so re-fit them. A container resize
  // (e.g. the app sidebar collapsing) re-fits too, but AG Grid has not applied the new body
  // width or column set yet at that point, so refit once more on the next frame.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `hiddenKey` and `containerWidth` are the triggers
  useEffect(() => {
    if (columnSizing !== "fit") return;
    gridRef.current?.api?.sizeColumnsToFit();
    const frame = requestAnimationFrame(() => gridRef.current?.api?.sizeColumnsToFit());
    return () => cancelAnimationFrame(frame);
  }, [hiddenKey, containerWidth, columnSizing]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "ag-theme-quartz flex w-full min-w-0 flex-col gap-3",
        domLayout === "normal" && "h-[500px] flex-1",
        onRowClicked && "[&_.ag-row]:cursor-pointer",
        className,
      )}
    >
      <AgGridReact<TData>
        ref={gridRef}
        containerStyle={domLayout === "normal" ? FILL_CONTAINER_STYLE : undefined}
        rowData={rowData ?? []}
        columnDefs={effectiveColumnDefs}
        defaultColDef={defaultColDef}
        quickFilterText={quickFilterText}
        onRowClicked={onRowClicked}
        pagination={paginationEnabled}
        paginationPageSize={urlPageSize}
        suppressPaginationPanel
        domLayout={domLayout}
        loading={loading}
        overlayNoRowsTemplate={overlayNoRowsTemplate}
        overlayComponentParams={overlayComponentParams}
        onGridReady={onGridReady}
        onPaginationChanged={onPaginationChanged}
        getRowId={getRowId ?? defaultGetRowId}
        getRowClass={getRowClass}
        animateRows={false}
        suppressCellFocus={!(cellFocus ?? hasEditableColumn)}
        onCellKeyDown={onCellKeyDown}
        enableCellTextSelection={enableCellTextSelection}
        ensureDomOrder={enableCellTextSelection}
        rowHeight={rowHeight}
      />
      {paginationEnabled ? (
        <ListPager
          page={pager.page}
          pageSize={pager.pageSize}
          total={pager.total}
          pageSizeOptions={paginationPageSizeSelector}
          className={pagerClassName}
          onPageChange={(page) => gridRef.current?.api?.paginationGoToPage(page)}
          onPageSizeChange={(size) =>
            gridRef.current?.api?.setGridOption("paginationPageSize", size)
          }
        />
      ) : null}
    </div>
  );
}
