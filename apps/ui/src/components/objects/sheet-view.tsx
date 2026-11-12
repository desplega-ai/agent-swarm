import {
  type CellFocusedEvent,
  type ColDef,
  HighlightChangesModule,
  ModuleRegistry,
  TextEditorModule,
} from "ag-grid-community";
import { type ClipboardEvent, useCallback, useMemo, useRef, useState } from "react";
import { DataGrid } from "@/components/shared/data-grid";
import { Button } from "@/components/ui/button";
import {
  colName,
  defaultWindow,
  displayOf,
  inputOf,
  parseInput,
  parseRange,
  parseTsv,
  qualify,
  type SheetCell,
  type SheetTab,
  type SheetValue,
} from "./sheet-model";
import { type ObjectFetch, type ObjectSnapshot, objectCall } from "./use-object";

// Editing and change flashes; registered here so the dashboard's main bundle skips them.
ModuleRegistry.registerModules([TextEditorModule, HighlightChangesModule]);

type Row = { id: string; row: number; cells: Record<string, SheetCell> };

const ROW_HEADER = "__row";

export type SheetViewProps = {
  snapshot: ObjectSnapshot;
  fetchFn: ObjectFetch;
  refetch: () => Promise<unknown>;
  readOnly?: boolean;
  tab?: string;
  range?: string;
};

/**
 * A `swarm-sheet/1` workbook on the shared data grid. The browser never
 * recalculates: an edit or a TSV paste goes to `sheet-ops` as a cell patch,
 * then the view refetches, because the route answers with counts, not cells.
 * A formula cell shows its result and opens its formula in the editor.
 */
export default function SheetView({
  snapshot,
  fetchFn,
  refetch,
  readOnly,
  tab,
  range,
}: SheetViewProps) {
  const tabs = ((snapshot.content as { tabs?: SheetTab[] } | null)?.tabs ?? []).filter(
    (t) => t && typeof t.name === "string" && t.cells && typeof t.cells === "object",
  );
  const pinned = range ? parseRange(range) : null;
  const [picked, setPicked] = useState(pinned?.tab ?? tab);
  const active = tabs.find((t) => t.name === (pinned?.tab ?? picked)) ?? tabs[0];
  const [saveError, setSaveError] = useState<string | null>(null);
  const focused = useRef<string | null>(null);

  const area = active ? (pinned?.window ?? defaultWindow(active)) : null;
  const tabName = active?.name;

  const write = useCallback(
    async (ref: string, values: SheetValue[][]) => {
      if (!tabName) return;
      setSaveError(null);
      try {
        await objectCall(
          fetchFn,
          `/api/objects/${encodeURIComponent(snapshot.object.id)}/sheet-ops`,
          {
            method: "POST",
            body: { op: "setRange", range: qualify(tabName, ref), values },
          },
        );
      } catch (err) {
        setSaveError(`Could not save ${ref}: ${err instanceof Error ? err.message : String(err)}`);
      }
      await refetch();
    },
    [fetchFn, refetch, snapshot.object.id, tabName],
  );

  // Keyed on the window's bounds, not its object: a poll must not rebuild the columns.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the bounds are the triggers
  const columnDefs = useMemo<ColDef<Row>[]>(() => {
    if (!area) return [];
    const flash =
      typeof window !== "undefined" &&
      !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const header: ColDef<Row> = {
      colId: ROW_HEADER,
      headerName: "",
      width: 56,
      minWidth: 48,
      sortable: false,
      resizable: false,
      valueGetter: (p) => p.data?.row,
      cellClass: "text-muted-foreground tabular-nums",
    };
    const cols: ColDef<Row>[] = [];
    for (let c = area.c1; c <= area.c2; c++) {
      const name = colName(c);
      cols.push({
        colId: name,
        headerName: name,
        width: 120,
        sortable: false,
        editable: !readOnly,
        enableCellChangeFlash: flash,
        // The editor opens with the getter's value (the formula); the cell paints the formatter's.
        valueGetter: (p) => (p.data ? inputOf(p.data.cells[`${name}${p.data.row}`]) : ""),
        valueFormatter: (p) => (p.data ? displayOf(p.data.cells[`${name}${p.data.row}`]) : ""),
        cellClass: (p) =>
          p.data?.cells[`${name}${p.data.row}`]?.e ? "text-destructive" : undefined,
        valueSetter: (p) => {
          const ref = `${name}${p.data.row}`;
          const text = typeof p.newValue === "string" ? p.newValue : String(p.newValue ?? "");
          if (text === inputOf(p.data.cells[ref])) return false;
          const value = parseInput(text);
          // Paint the typed value until the refetch brings the recalculated cell.
          p.data.cells = { ...p.data.cells, [ref]: { v: value } };
          void write(ref, [[value]]);
          return true;
        },
      });
    }
    return [header, ...cols];
  }, [area?.r1, area?.c1, area?.r2, area?.c2, readOnly, write]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the bounds are the triggers
  const rowData = useMemo<Row[]>(() => {
    if (!area || !active) return [];
    const rows: Row[] = [];
    for (let r = area.r1; r <= area.r2; r++)
      rows.push({ id: String(r), row: r, cells: active.cells });
    return rows;
  }, [area?.r1, area?.r2, active]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the first row is the trigger
  const onCellFocused = useCallback(
    (event: CellFocusedEvent<Row>) => {
      const colId = typeof event.column === "string" ? event.column : event.column?.getColId();
      focused.current =
        area && event.rowIndex !== null && colId && colId !== ROW_HEADER
          ? `${colId}${area.r1 + event.rowIndex}`
          : null;
    },
    [area?.r1],
  );

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    // A cell being edited takes the paste into its own input.
    if (readOnly || !focused.current || event.target instanceof HTMLInputElement) return;
    const values = parseTsv(event.clipboardData.getData("text/plain"));
    if (values.length === 0) return;
    event.preventDefault();
    void write(focused.current, values);
  };

  if (!active || !area) {
    return <p className="p-4 text-sm text-muted-foreground">This sheet has no tabs.</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col" onPaste={onPaste}>
      {tabs.length > 1 && !pinned?.tab ? (
        <div className="flex gap-1 overflow-x-auto border-b px-2 py-1" role="tablist">
          {tabs.map((t) => (
            <Button
              key={t.name}
              role="tab"
              aria-selected={t.name === active.name}
              size="sm"
              variant={t.name === active.name ? "secondary" : "ghost"}
              onClick={() => setPicked(t.name)}
            >
              {t.name}
            </Button>
          ))}
        </div>
      ) : null}
      <DataGrid<Row>
        rowData={rowData}
        columnDefs={columnDefs}
        pagination={false}
        columnSizing="flex"
        cellFocus
        onCellFocused={onCellFocused}
        className="h-0 min-h-0 flex-1 gap-0"
      />
      {saveError ? (
        <p role="alert" className="border-t px-3 py-1.5 text-xs text-destructive">
          {saveError}
        </p>
      ) : null}
    </div>
  );
}
