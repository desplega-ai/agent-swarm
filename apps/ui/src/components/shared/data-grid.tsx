import {
  ClientSideRowModelModule,
  type ColDef,
  ColumnAutoSizeModule,
  CsvExportModule,
  type GetRowIdParams,
  type GridReadyEvent,
  ModuleRegistry,
  NumberFilterModule,
  type PaginationChangedEvent,
  PaginationModule,
  QuickFilterModule,
  type RowClickedEvent,
  TextFilterModule,
  ValidationModule,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { cn } from "@/lib/utils";

ModuleRegistry.registerModules([
  ClientSideRowModelModule,
  PaginationModule,
  TextFilterModule,
  NumberFilterModule,
  QuickFilterModule,
  ColumnAutoSizeModule,
  CsvExportModule,
  ValidationModule,
]);

const DEFAULT_PAGE_SIZE_SELECTOR = [10, 20, 50, 100];

interface DataGridProps<TData> {
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
  domLayout?: "normal" | "autoHeight";
  enableCellTextSelection?: boolean;
  getRowId?: (params: GetRowIdParams<TData>) => string;
  /**
   * Override the AG-Grid default row height (~42px on the quartz theme).
   * Set when a table renders multi-line cells and needs extra vertical
   * breathing room — e.g. the identity events table (56) so the Change
   * column can fit a richer two-line diff alongside the Time cell.
   */
  rowHeight?: number;
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
  domLayout = "normal",
  enableCellTextSelection = false,
  getRowId,
  rowHeight,
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
      if (loading) {
        event.api.showLoadingOverlay();
      }
      event.api.sizeColumnsToFit();
      syncGridPaginationFromUrl(event);
    },
    [loading, syncGridPaginationFromUrl],
  );

  const onPaginationChanged = useCallback(
    (event: PaginationChangedEvent<TData>) => {
      if (!paginationEnabled || !paginationQueryKey) return;
      writePaginationParams(
        event.api.paginationGetCurrentPage(),
        event.api.paginationGetPageSize(),
      );
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
  }, []);

  return (
    <div
      ref={containerRef}
      className={cn(
        "ag-theme-quartz w-full",
        domLayout === "normal" && "h-[500px] flex-1",
        onRowClicked && "[&_.ag-row]:cursor-pointer",
        className,
      )}
    >
      <AgGridReact<TData>
        ref={gridRef}
        rowData={rowData ?? []}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        quickFilterText={quickFilterText}
        onRowClicked={onRowClicked}
        pagination={paginationEnabled}
        paginationPageSize={urlPageSize}
        paginationPageSizeSelector={paginationEnabled ? paginationPageSizeSelector : undefined}
        domLayout={domLayout}
        loading={loading}
        overlayNoRowsTemplate={overlayNoRowsTemplate}
        overlayComponentParams={overlayComponentParams}
        onGridReady={onGridReady}
        onPaginationChanged={onPaginationChanged}
        getRowId={getRowId ?? defaultGetRowId}
        animateRows={false}
        suppressCellFocus={!hasEditableColumn}
        enableCellTextSelection={enableCellTextSelection}
        ensureDomOrder={enableCellTextSelection}
        rowHeight={rowHeight}
      />
    </div>
  );
}
