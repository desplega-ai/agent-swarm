import type { ColDef } from "ag-grid-community";
import { Table2 } from "lucide-react";
import { useMemo, useState } from "react";
import { DataGrid } from "@/components/shared/data-grid";
import { EmptyState } from "@/components/shared/empty-state";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  CSV_MAX_COLUMNS,
  CSV_MAX_ROWS,
  compareCells,
  delimiterFor,
  parseDelimited,
} from "@/lib/comb/csv";
import type { DrivePath } from "@/lib/comb/paths";
import type { ViewerProps } from "./file-viewer";
import { TextGate } from "./text-gate";
import { TextLines } from "./text-viewer";

type TableView = "table" | "source";

const VIEW_OPTIONS = [
  { value: "table", label: "Table" },
  { value: "source", label: "Source" },
] as const;

interface TableRow {
  index: number;
  cells: string[];
}

/**
 * CSV and TSV files as a grid, with a Source view that shows the text rows
 * (so line comments work on the source too).
 */
export default function TableViewer({ file, stat }: ViewerProps) {
  return (
    <TextGate file={file} stat={stat}>
      {(text) => <TableBody file={file} text={text} />}
    </TextGate>
  );
}

function TableBody({ file, text }: { file: DrivePath; text: string }) {
  const [view, setView] = useState<TableView>("table");
  const table = useMemo(
    () => parseDelimited(text, { delimiter: delimiterFor(file.path, text) }),
    [text, file.path],
  );

  const { columnDefs, rowData, columnsTruncated } = useMemo(() => {
    // Ragged rows can be longer than the header: they get extra columns.
    const width = Math.max(table.header.length, ...table.rows.map((row) => row.length));
    const shown = Math.min(width, CSV_MAX_COLUMNS);
    const columnDefs: ColDef<TableRow>[] = Array.from({ length: shown }, (_, column) => ({
      colId: String(column),
      headerName: table.header[column] || `Column ${column + 1}`,
      valueGetter: ({ data }) => data?.cells[column] ?? "",
      comparator: compareCells,
      minWidth: 120,
    }));
    const rowData = table.rows.map((cells, index) => ({ index, cells }));
    return { columnDefs, rowData, columnsTruncated: width > shown };
  }, [table]);
  const cut = [
    table.truncated && `${CSV_MAX_ROWS.toLocaleString()} rows`,
    columnsTruncated && `${CSV_MAX_COLUMNS} columns`,
  ]
    .filter(Boolean)
    .join(" and ");

  return (
    <div className="flex h-full min-h-[32rem] flex-col">
      <div
        data-comb-skip
        className="sticky top-0 left-0 z-10 flex shrink-0 flex-wrap items-center gap-3 border-b border-border-subtle bg-card px-3 py-2"
      >
        <SegmentedControl
          size="sm"
          aria-label="View"
          value={view}
          onValueChange={setView}
          options={VIEW_OPTIONS}
        />
        {view === "table" && cut ? (
          <p className="text-xs text-muted-foreground">
            Showing the first {cut}. Download the file to see all of them.
          </p>
        ) : null}
      </div>
      {view === "source" ? (
        <TextLines text={text} />
      ) : columnDefs.length === 0 ? (
        <EmptyState icon={Table2} title="This file is empty" />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col p-3">
          <DataGrid
            rowData={rowData}
            columnDefs={columnDefs}
            getRowId={({ data }) => String(data.index)}
            paginationPageSize={100}
            enableCellTextSelection
            emptyMessage="This file has a header and no rows."
          />
        </div>
      )}
    </div>
  );
}
