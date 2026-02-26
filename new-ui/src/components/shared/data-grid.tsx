import { useCallback, useMemo, useRef } from "react";
import { AgGridReact } from "ag-grid-react";
import {
  ClientSideRowModelModule,
  ModuleRegistry,
  PaginationModule,
  TextFilterModule,
  NumberFilterModule,
  QuickFilterModule,
  ColumnAutoSizeModule,
  CsvExportModule,
  ValidationModule,
  type ColDef,
  type RowClickedEvent,
} from "ag-grid-community";
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
  className?: string;
  domLayout?: "normal" | "autoHeight";
}

export function DataGrid<TData>({
  rowData,
  columnDefs,
  quickFilterText,
  onRowClicked,
  loading,
  emptyMessage = "No data to display",
  paginationPageSize = 20,
  className,
  domLayout = "normal",
}: DataGridProps<TData>) {
  const gridRef = useRef<AgGridReact<TData>>(null);

  const defaultColDef = useMemo<ColDef>(
    () => ({
      resizable: true,
      sortable: true,
      suppressMovable: true,
    }),
    [],
  );

  const overlayNoRowsTemplate = useMemo(
    () => `<div class="flex items-center justify-center p-8 text-muted-foreground">${emptyMessage}</div>`,
    [emptyMessage],
  );

  const onGridReady = useCallback(() => {
    if (loading) {
      gridRef.current?.api?.showLoadingOverlay();
    }
    gridRef.current?.api?.sizeColumnsToFit();
  }, [loading]);

  return (
    <div
      className={cn(
        "ag-theme-quartz w-full",
        domLayout === "normal" && "flex-1 min-h-[500px]",
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
        pagination
        paginationPageSize={paginationPageSize}
        paginationPageSizeSelector={[10, 20, 50, 100]}
        domLayout={domLayout}
        loading={loading}
        overlayNoRowsTemplate={overlayNoRowsTemplate}
        onGridReady={onGridReady}
        animateRows={false}
        suppressCellFocus
      />
    </div>
  );
}
