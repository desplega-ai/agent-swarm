import Editor from "@monaco-editor/react";
import type { ColDef, GetRowIdParams } from "ag-grid-community";
import { Bug, ChevronDown, ChevronRight, Loader2, Play, Table2 } from "lucide-react";
import { useCallback, useMemo, useRef } from "react";
import { useDbQuery, useTableColumns, useTableList } from "@/api/hooks";
import { DataGrid } from "@/components/shared/data-grid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useTheme } from "@/hooks/use-theme";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";

const DEFAULT_SQL = "SELECT name, type FROM sqlite_master WHERE type='table' ORDER BY name";

// ── Table Browser Sidebar ──────────────────────────────────────────────────

function TableBrowser({
  expandedTable,
  onSelectTable,
  onToggleTable,
}: {
  expandedTable: string;
  onSelectTable: (tableName: string) => void;
  onToggleTable: (tableName: string) => void;
}) {
  const { data: tablesResult, isLoading } = useTableList();

  const tables = useMemo(() => {
    if (!tablesResult?.rows) return [];
    return tablesResult.rows.map((row) => String(row[0]));
  }, [tablesResult]);

  return (
    <div className="w-[220px] shrink-0 border-r border-border flex flex-col min-h-0 overflow-hidden">
      <div className="px-3 py-2 border-b border-border shrink-0">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Tables
        </span>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="py-1">
          {isLoading && (
            <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground text-sm">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading...
            </div>
          )}
          {tables.map((name) => (
            <TableItem
              key={name}
              name={name}
              expanded={expandedTable === name}
              onToggle={() => onToggleTable(name)}
              onSelect={() => onSelectTable(name)}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function TableItem({
  name,
  expanded,
  onToggle,
  onSelect,
}: {
  name: string;
  expanded: boolean;
  onToggle: () => void;
  onSelect: () => void;
}) {
  const { data: columnsResult } = useTableColumns(expanded ? name : null);

  const columns = useMemo(() => {
    if (!columnsResult?.rows) return [];
    // PRAGMA table_info returns: cid, name, type, notnull, dflt_value, pk
    return columnsResult.rows.map((row) => ({
      name: String(row[1]),
      type: String(row[2] || ""),
      pk: Boolean(row[5]),
    }));
  }, [columnsResult]);

  return (
    <div>
      <div className="flex items-center gap-1 px-2 py-1 hover:bg-muted/50 group">
        <button
          type="button"
          className="p-0.5 text-muted-foreground hover:text-foreground"
          onClick={onToggle}
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
        <button
          type="button"
          className="flex items-center gap-1.5 text-sm text-foreground hover:text-primary truncate"
          onClick={onSelect}
        >
          <Table2 className="h-3 w-3 text-muted-foreground shrink-0" />
          <span className="truncate font-mono text-xs">{name}</span>
        </button>
      </div>
      {expanded && columns.length > 0 && (
        <div className="ml-6 pb-1">
          {columns.map((col) => (
            <div
              key={col.name}
              className="flex items-center gap-1.5 px-2 py-0.5 text-xs text-muted-foreground"
            >
              <span className="font-mono truncate">
                {col.pk ? <span className="text-primary">*</span> : null}
                {col.name}
              </span>
              <span className="text-muted-foreground/60 uppercase text-[10px]">{col.type}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Debug Page ────────────────────────────────────────────────────────

export default function DebugPage() {
  const { theme } = useTheme();
  const { searchParams, setParam, setParams } = useUrlSearchState();
  const dbQuery = useDbQuery();
  const sql = readStringParam(searchParams, "sql", DEFAULT_SQL);
  const expandedTable = readStringParam(searchParams, "table");
  const editorRef = useRef<{ getValue: () => string } | null>(null);

  const executeQuery = useCallback(() => {
    const currentSql = editorRef.current?.getValue() ?? sql;
    if (currentSql.trim()) {
      dbQuery.mutate({ sql: currentSql.trim() });
    }
  }, [sql, dbQuery]);

  function handleSelectTable(tableName: string) {
    const newSql = `SELECT * FROM ${tableName} LIMIT 50`;
    setParams({ table: tableName, sql: newSql }, { defaultValues: { sql: DEFAULT_SQL } });
    dbQuery.mutate({ sql: newSql });
  }

  function handleToggleTable(tableName: string) {
    setParam("table", expandedTable === tableName ? "" : tableName);
  }

  function handleEditorMount(editor: { getValue: () => string }) {
    editorRef.current = editor;
    // Add Cmd/Ctrl+Enter keybinding
    // Monaco editor instance has addCommand at runtime but the onMount type is minimal
    const monacoEditor = editor as unknown as {
      addCommand: (keybinding: number, handler: () => void) => void;
    };
    monacoEditor.addCommand(
      // Monaco KeyMod.CtrlCmd | KeyCode.Enter = 2048 | 3
      2048 | 3,
      () => executeQuery(),
    );
  }

  // Dynamic columns from query result
  const columnDefs = useMemo<ColDef[]>(() => {
    if (!dbQuery.data?.columns) return [];
    return dbQuery.data.columns.map((col) => ({
      field: col,
      headerName: col,
      flex: 1,
      minWidth: 120,
    }));
  }, [dbQuery.data?.columns]);

  // Convert row arrays to objects for AG Grid
  const rowData = useMemo(() => {
    if (!dbQuery.data) return [];
    return dbQuery.data.rows.map((row) =>
      Object.fromEntries(dbQuery.data.columns.map((col, i) => [col, row[i]])),
    );
  }, [dbQuery.data]);

  const getRowId = useCallback(
    (params: GetRowIdParams) => String(params.data?.id ?? JSON.stringify(params.data)),
    [],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-0">
      {/* Header */}
      <PageHeader icon={Bug} title="Debug — Database Explorer" className="pb-3" />

      {/* Main content: sidebar + editor/results */}
      <div className="flex flex-1 min-h-0 border border-border rounded-md overflow-hidden">
        {/* Table browser sidebar */}
        <TableBrowser
          expandedTable={expandedTable}
          onSelectTable={handleSelectTable}
          onToggleTable={handleToggleTable}
        />

        {/* Right panel: editor + results */}
        <div className="flex flex-col flex-1 min-h-0 min-w-0">
          {/* Monaco editor */}
          <div className="border-b border-border h-[200px]">
            <Editor
              language="sql"
              theme={theme === "dark" ? "vs-dark" : "vs"}
              value={sql}
              onChange={(value) => setParam("sql", value ?? "", { defaultValue: DEFAULT_SQL })}
              onMount={handleEditorMount}
              options={{
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                fontSize: 13,
                lineNumbers: "on",
                wordWrap: "on",
                automaticLayout: true,
                padding: { top: 8 },
              }}
            />
          </div>

          {/* Toolbar */}
          <div className="flex items-center gap-3 px-3 py-2 border-b border-border bg-muted/30">
            <Button
              size="sm"
              className="gap-1.5 bg-primary hover:bg-primary/90"
              onClick={executeQuery}
              disabled={dbQuery.isPending}
            >
              {dbQuery.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              Execute
            </Button>

            <span className="text-xs text-muted-foreground">
              {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Enter
            </span>

            {dbQuery.data && (
              <div className="flex items-center gap-2 ml-auto">
                <Badge variant="outline" size="tag">
                  {dbQuery.data.total} rows
                </Badge>
                <Badge variant="outline" size="tag">
                  {dbQuery.data.elapsed}ms
                </Badge>
              </div>
            )}

            {dbQuery.error && (
              <span className="text-sm text-status-error ml-auto truncate">
                {dbQuery.error instanceof Error ? dbQuery.error.message : "Query failed"}
              </span>
            )}
          </div>

          {/* Results grid */}
          <div className="flex-1 min-h-0">
            <DataGrid
              rowData={rowData}
              columnDefs={columnDefs}
              loading={dbQuery.isPending}
              emptyMessage="Run a query to see results"
              enableCellTextSelection
              getRowId={getRowId}
              pagination
              paginationPageSize={50}
              paginationQueryKey="debugResults"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
