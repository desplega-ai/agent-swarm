import {
  ClientSideRowModelModule,
  type ColDef,
  ColumnAutoSizeModule,
  CsvExportModule,
  type GetRowIdParams,
  ModuleRegistry,
  NumberFilterModule,
  PaginationModule,
  QuickFilterModule,
  type RowClickedEvent,
  TextFilterModule,
  ValidationModule,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
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

interface DataGridProps<TData> {
  rowData: TData[] | undefined;
  columnDefs: ColDef<TData>[];
  quickFilterText?: string;
  onRowClicked?: (event: RowClickedEvent<TData>) => void;
  loading?: boolean;
  emptyMessage?: string;
  paginationPageSize?: number;
  pagination?: boolean;
  className?: string;
  domLayout?: "normal" | "autoHeight";
  enableCellTextSelection?: boolean;
  getRowId?: (params: GetRowIdParams<TData>) => string;
}

export function DataGrid<TData>({
  rowData,
  columnDefs,
  quickFilterText,
  onRowClicked,
  loading,
  emptyMessage = "No data to display",
  paginationPageSize = 20,
  pagination: paginationEnabled = true,
  className,
  domLayout = "normal",
  enableCellTextSelection = false,
  getRowId,
}: DataGridProps<TData>) {
  const gridRef = useRef<AgGridReact<TData>>(null);

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

  const onGridReady = useCallback(() => {
    if (loading) {
      gridRef.current?.api?.showLoadingOverlay();
    }
    gridRef.current?.api?.sizeColumnsToFit();
  }, [loading]);

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
        paginationPageSize={paginationPageSize}
        paginationPageSizeSelector={paginationEnabled ? [10, 20, 50, 100] : undefined}
        domLayout={domLayout}
        loading={loading}
        overlayNoRowsTemplate={overlayNoRowsTemplate}
        onGridReady={onGridReady}
        getRowId={getRowId ?? defaultGetRowId}
        animateRows={false}
        suppressCellFocus
        enableCellTextSelection={enableCellTextSelection}
        ensureDomOrder={enableCellTextSelection}
      />
    </div>
  );
}
