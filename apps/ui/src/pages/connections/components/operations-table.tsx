import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { ScriptConnectionOperation } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { Input } from "@/components/ui/input";
import { OperationDetailDialog } from "./operation-detail-dialog";

export type ConnectionOperation = ScriptConnectionOperation;

/**
 * Operations list for an OpenAPI connection: token-match filter input over
 * name / method / path + a paginated DataGrid (same primitive as the
 * connections list tab). `autoHeight` so the detail page's main column stays
 * the scroll container. Clicking a row opens the operation detail dialog
 * (schemas + call snippet).
 */
export function OperationsTable({
  operations,
  slug,
}: {
  operations: ConnectionOperation[];
  slug: string;
}) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<ConnectionOperation | null>(null);

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
        onRowClicked={(event: RowClickedEvent<ConnectionOperation>) => {
          if (event.data) setSelected(event.data);
        }}
      />
      <OperationDetailDialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        slug={slug}
        subject={selected ? { kind: "operation", operation: selected } : null}
      />
    </div>
  );
}
