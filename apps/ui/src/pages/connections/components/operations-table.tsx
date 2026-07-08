import type { ColDef } from "ag-grid-community";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { DataGrid } from "@/components/shared/data-grid";
import { Input } from "@/components/ui/input";

export interface ConnectionOperation {
  name: string;
  method: string;
  path: string;
}

/**
 * Operations list for an OpenAPI connection: token-match filter input over
 * name / method / path + a paginated DataGrid (same primitive as the
 * connections list tab). `autoHeight` so the detail page's main column stays
 * the scroll container.
 */
export function OperationsTable({ operations }: { operations: ConnectionOperation[] }) {
  const [filter, setFilter] = useState("");

  const columnDefs = useMemo<ColDef<ConnectionOperation>[]>(
    () => [
      { field: "name", headerName: "Name", flex: 1, minWidth: 160, cellClass: "font-medium" },
      {
        field: "method",
        headerName: "Method",
        width: 110,
        cellClass: "font-mono text-xs uppercase",
      },
      {
        field: "path",
        headerName: "Path",
        flex: 2,
        minWidth: 200,
        cellClass: "font-mono text-xs",
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter operations (name, method, path)..."
          className="pl-8"
          aria-label="Filter operations"
        />
      </div>
      <DataGrid
        rowData={operations}
        columnDefs={columnDefs}
        quickFilterText={filter}
        emptyMessage="No matching operations"
        domLayout="autoHeight"
        paginationPageSize={10}
        paginationPageSizeSelector={[10, 20, 50]}
        paginationQueryKey="operations"
        enableCellTextSelection
        getRowId={(params) => `${params.data.method} ${params.data.path} ${params.data.name}`}
      />
    </div>
  );
}
