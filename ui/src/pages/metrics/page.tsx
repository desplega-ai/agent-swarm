import Editor from "@monaco-editor/react";
import type { ColDef } from "ag-grid-community";
import {
  BarChart3,
  ChevronDown,
  ChevronRight,
  Code2,
  Expand,
  LayoutDashboard,
  LineChart as LineChartIcon,
  Maximize2,
  Minimize2,
  Plus,
  RefreshCw,
  Save,
  Table2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  useCreateMetric,
  useMetricDefinition,
  useMetricDefinitions,
  useMetricRun,
  useUpdateMetric,
} from "@/api/hooks/use-metric-definitions";
import type {
  MetricDefinition,
  MetricFormat,
  MetricListItem,
  MetricParam,
  MetricVariable,
  MetricVisualization,
  MetricVizColumn,
  MetricWidget,
} from "@/api/types";
import { SharedBarChart, SharedLineChart } from "@/components/shared/charts/nivo-charts";
import { DataGrid } from "@/components/shared/data-grid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn, formatSmartTime } from "@/lib/utils";

const NEW_METRIC_DEFINITION: MetricDefinition = {
  version: 1,
  refreshSeconds: 60,
  layout: { columns: 2 },
  variables: [
    {
      key: "rangeModifier",
      label: "Time range",
      type: "select",
      defaultValue: "-30 days",
      options: [
        { label: "Last 7 days", value: "-7 days" },
        { label: "Last 30 days", value: "-30 days" },
        { label: "Last 90 days", value: "-90 days" },
      ],
    },
    {
      key: "userFilter",
      label: "Requester user ID",
      type: "text",
      defaultValue: "",
    },
    {
      key: "agentFilter",
      label: "Agent ID",
      type: "text",
      defaultValue: "",
    },
  ],
  widgets: [
    {
      id: "task-statuses",
      title: "Task statuses",
      description: "Tasks grouped by current status.",
      query: {
        sql: "SELECT status, COUNT(*) AS tasks FROM agent_tasks WHERE createdAt >= datetime('now', ?) AND (? = '' OR COALESCE(requestedByUserId, '') = ?) AND (? = '' OR COALESCE(agentId, '') = ?) GROUP BY status ORDER BY tasks DESC",
        params: [
          "{{rangeModifier}}",
          "{{userFilter}}",
          "{{userFilter}}",
          "{{agentFilter}}",
          "{{agentFilter}}",
        ],
        maxRows: 100,
      },
      viz: {
        type: "bar",
        x: "status",
        y: "tasks",
        format: "integer",
        columns: [
          { key: "status", label: "Status" },
          { key: "tasks", label: "Tasks", format: "integer" },
        ],
      },
    },
  ],
};

function formatValue(value: unknown, format?: MetricFormat): string {
  if (value == null) return "-";
  const n = typeof value === "number" ? value : Number(value);
  if (format === "currency" && Number.isFinite(n)) {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 4,
    }).format(n);
  }
  if (format === "percent" && Number.isFinite(n)) return `${(n * 100).toFixed(1)}%`;
  if (format === "integer" && Number.isFinite(n)) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n);
  }
  if (format === "duration" && Number.isFinite(n)) {
    return `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })} min`;
  }
  if (format === "number" && Number.isFinite(n)) {
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return String(value);
}

function inferColumns(rows: Record<string, unknown>[], columns?: MetricVizColumn[]) {
  return (
    columns ??
    Object.keys(rows[0] ?? {}).map((key) => ({
      key,
      label: key,
      format: undefined,
    }))
  );
}

function getDefaultVariableValue(variable: MetricVariable): MetricParam {
  if (variable.defaultValue !== undefined) return variable.defaultValue;
  return variable.options?.[0]?.value ?? "";
}

function readVariableValues(
  variables: MetricVariable[] | undefined,
  searchParams: URLSearchParams,
): Record<string, MetricParam> {
  const values: Record<string, MetricParam> = {};
  for (const variable of variables ?? []) {
    const raw = searchParams.get(`var_${variable.key}`);
    const fallback = getDefaultVariableValue(variable);
    if (raw == null) {
      values[variable.key] = fallback;
      continue;
    }
    values[variable.key] = variable.type === "number" ? Number(raw) : raw;
  }
  return values;
}

function variableParamValue(value: MetricParam): string {
  return value == null ? "" : String(value);
}

function MetricTable({
  rows,
  columns,
  loading,
  paginationQueryKey,
  collapsedByDefault = true,
}: {
  rows: Record<string, unknown>[];
  columns?: MetricVizColumn[];
  loading?: boolean;
  paginationQueryKey?: string;
  collapsedByDefault?: boolean;
}) {
  const [expanded, setExpanded] = useState(!collapsedByDefault);
  const columnDefs = useMemo<ColDef<Record<string, unknown>>[]>(
    () =>
      inferColumns(rows, columns).map((column) => ({
        field: column.key,
        headerName: column.label ?? column.key,
        minWidth: 120,
        valueFormatter: (params) => formatValue(params.value, column.format),
      })),
    [columns, rows],
  );

  return (
    <div className="space-y-2">
      <div
        className={cn(
          "overflow-hidden rounded-md border",
          !expanded && rows.length > 6 && "max-h-[260px]",
        )}
      >
        <DataGrid
          rowData={rows}
          columnDefs={columnDefs}
          loading={loading}
          emptyMessage="No rows"
          pagination={expanded && rows.length > 20}
          paginationPageSize={20}
          domLayout="autoHeight"
          enableCellTextSelection
          className="min-h-[180px] border-0"
          paginationQueryKey={paginationQueryKey}
        />
      </div>
      {rows.length > 6 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          {expanded ? "Collapse table" : `Expand table (${rows.length} rows)`}
        </Button>
      )}
    </div>
  );
}

function MetricChart({ rows, widget }: { rows: Record<string, unknown>[]; widget: MetricWidget }) {
  const xKey = widget.viz.x ?? Object.keys(rows[0] ?? {})[0] ?? "x";
  const yKey = widget.viz.y ?? Object.keys(rows[0] ?? {})[1] ?? "y";
  const seriesKeys = widget.viz.series && widget.viz.series.length > 0 ? widget.viz.series : [yKey];

  if (widget.viz.type === "line" || widget.viz.type === "multi-line") {
    return (
      <SharedLineChart
        data={rows}
        xKey={xKey}
        keys={seriesKeys}
        valueFormatter={(value) => formatValue(value, widget.viz.format)}
      />
    );
  }

  return (
    <SharedBarChart
      data={rows}
      indexBy={xKey}
      keys={seriesKeys}
      valueFormatter={(value) => formatValue(value, widget.viz.format)}
    />
  );
}

function WidgetViz({
  widget,
  rows,
  loading,
}: {
  widget: MetricWidget;
  rows: Record<string, unknown>[];
  loading?: boolean;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-8 text-sm text-muted-foreground">
        No rows
      </div>
    );
  }

  if (widget.viz.type === "stat") {
    const valueKey = widget.viz.value ?? Object.keys(rows[0] ?? {})[0] ?? "value";
    const labelKey = widget.viz.label;
    return (
      <div className="rounded-md border p-4">
        <div className="text-sm text-muted-foreground">
          {labelKey ? String(rows[0]?.[labelKey] ?? widget.title) : widget.title}
        </div>
        <div className="mt-2 font-mono text-4xl tabular-nums">
          {formatValue(rows[0]?.[valueKey], widget.viz.format)}
        </div>
      </div>
    );
  }

  if (
    widget.viz.type === "line" ||
    widget.viz.type === "multi-line" ||
    widget.viz.type === "bar" ||
    widget.viz.type === "multi-bar"
  ) {
    return (
      <div className="space-y-4">
        <MetricChart rows={rows} widget={widget} />
        <MetricTable
          rows={rows}
          columns={widget.viz.columns}
          loading={loading}
          paginationQueryKey={`metric${widget.id}`}
        />
      </div>
    );
  }

  return (
    <MetricTable
      rows={rows}
      columns={widget.viz.columns}
      loading={loading}
      paginationQueryKey={`metric${widget.id}`}
    />
  );
}

function widgetIcon(type: MetricVisualization) {
  if (type === "table") return Table2;
  if (type === "line" || type === "multi-line") return LineChartIcon;
  return BarChart3;
}

function widgetSpanClass(widget: MetricWidget): string {
  const colSpan = Math.min(Math.max(widget.colSpan ?? 1, 1), 4);
  const rowSpan = Math.min(Math.max(widget.rowSpan ?? 1, 1), 4);
  return cn(
    colSpan === 2 && "md:col-span-2",
    colSpan === 3 && "xl:col-span-3",
    colSpan === 4 && "2xl:col-span-4",
    rowSpan === 2 && "md:row-span-2",
    rowSpan === 3 && "xl:row-span-3",
    rowSpan === 4 && "2xl:row-span-4",
  );
}

function layoutGridClass(columns: number | undefined): string {
  const columnCount = Math.min(Math.max(columns ?? 2, 1), 4);
  return cn(
    "grid grid-cols-1 gap-4 auto-rows-[minmax(280px,auto)]",
    columnCount >= 2 && "md:grid-cols-2",
    columnCount >= 3 && "xl:grid-cols-3",
    columnCount >= 4 && "2xl:grid-cols-4",
  );
}

function WidgetCard({
  widget,
  rows,
  total,
  elapsed,
  truncated,
  loading,
  onExpand,
}: {
  widget: MetricWidget;
  rows: Record<string, unknown>[];
  total?: number;
  elapsed?: number;
  truncated?: boolean;
  loading?: boolean;
  onExpand: () => void;
}) {
  const Icon = widgetIcon(widget.viz.type);
  return (
    <Card className={cn("h-full min-w-0 rounded-md", widgetSpanClass(widget))}>
      <CardHeader className="border-b">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex min-w-0 items-center gap-2 text-base">
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{widget.title}</span>
            </CardTitle>
            {widget.description && (
              <CardDescription className="line-clamp-2 break-words">
                {widget.description}
              </CardDescription>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant="outline" size="tag">
              {widget.viz.type}
            </Badge>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={onExpand}
              title="Expand metric"
            >
              <Expand className="size-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <Skeleton className="h-[280px] w-full" />
        ) : (
          <WidgetViz widget={widget} rows={rows} loading={loading} />
        )}
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          {typeof total === "number" && (
            <span>
              {total} rows{typeof elapsed === "number" ? ` in ${elapsed}ms` : ""}
            </span>
          )}
          {truncated && <span>Result truncated</span>}
        </div>
      </CardContent>
    </Card>
  );
}

function VariableControls({
  variables,
  values,
  onChange,
}: {
  variables: MetricVariable[];
  values: Record<string, MetricParam>;
  onChange: (key: string, value: MetricParam) => void;
}) {
  if (variables.length === 0) return null;
  return (
    <div className="flex flex-wrap items-end gap-3">
      {variables.map((variable) => {
        const value = values[variable.key] ?? getDefaultVariableValue(variable);
        const label = variable.label ?? variable.key;
        if (variable.type === "select" && variable.options?.length) {
          return (
            <div key={variable.key} className="space-y-1.5">
              <Label className="text-xs">{label}</Label>
              <Select
                value={variableParamValue(value)}
                onValueChange={(next) => onChange(variable.key, next)}
              >
                <SelectTrigger className="w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {variable.options.map((option) => (
                    <SelectItem
                      key={variableParamValue(option.value)}
                      value={variableParamValue(option.value)}
                    >
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        }
        return (
          <div key={variable.key} className="space-y-1.5">
            <Label className="text-xs">{label}</Label>
            <Input
              className="w-[180px]"
              type={variable.type === "number" ? "number" : "text"}
              value={variableParamValue(value)}
              onChange={(event) =>
                onChange(
                  variable.key,
                  variable.type === "number" ? Number(event.target.value) : event.target.value,
                )
              }
            />
          </div>
        );
      })}
    </div>
  );
}

function MetricEditorDialog({
  metric,
  open,
  onOpenChange,
}: {
  metric?: MetricListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createMetric = useCreateMetric();
  const updateMetric = useUpdateMetric();
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [definitionText, setDefinitionText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(metric?.title ?? "New dashboard");
    setSlug(metric?.slug ?? "");
    setDescription(metric?.description ?? "");
    setDefinitionText(JSON.stringify(metric?.definition ?? NEW_METRIC_DEFINITION, null, 2));
    setError(null);
  }, [metric, open]);

  async function handleSave() {
    setError(null);
    let definition: MetricDefinition;
    try {
      definition = JSON.parse(definitionText) as MetricDefinition;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid JSON");
      return;
    }

    try {
      if (metric?.id) {
        await updateMetric.mutateAsync({
          id: metric.id,
          input: { title, slug: slug || undefined, description: description || null, definition },
        });
        toast.success("Dashboard updated");
      } else {
        await createMetric.mutateAsync({
          title,
          slug: slug || undefined,
          description: description || null,
          definition,
        });
        toast.success("Dashboard created");
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save dashboard");
    }
  }

  const pending = createMetric.isPending || updateMetric.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[90vw] max-w-[90vw]">
        <DialogHeader>
          <DialogTitle>{metric ? "Edit dashboard" : "Add dashboard"}</DialogTitle>
          <DialogDescription>{metric?.slug ?? "JSON dashboard definition"}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-[280px_1fr]">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="metric-title">Dashboard name</Label>
              <Input
                id="metric-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="metric-slug">Slug</Label>
              <Input
                id="metric-slug"
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="metric-description">Description</Label>
              <Input
                id="metric-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            {error && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}
          </div>

          <div className="min-h-[60vh] overflow-hidden rounded-md border">
            <Editor
              height="60vh"
              defaultLanguage="json"
              value={definitionText}
              onChange={(value) => setDefinitionText(value ?? "")}
              options={{
                minimap: { enabled: false },
                wordWrap: "on",
                scrollBeyondLastLine: false,
                fontSize: 12,
                tabSize: 2,
              }}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={pending || !title.trim()}>
            <Save className="size-4" />
            {pending ? "Saving" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MetricsListPage() {
  const { data, isLoading } = useMetricDefinitions({ fields: "full", limit: 100 });
  const metrics = data?.metrics ?? [];
  const [editorOpen, setEditorOpen] = useState(false);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-4">
      <PageHeader
        icon={BarChart3}
        title="Metrics"
        description="Available SQL-backed dashboards. Open one to inspect dashboard widgets, raw JSON, and shareable variable state."
        action={
          <Button onClick={() => setEditorOpen(true)}>
            <Plus className="size-4" />
            Add dashboard
          </Button>
        }
      />

      {isLoading ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-36" />
          ))}
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {metrics.map((metric) => (
            <Link key={metric.id} to={`/usage/metrics/${metric.id}`}>
              <Card className="h-full rounded-md transition-colors hover:border-primary/60">
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="truncate text-base">{metric.title}</CardTitle>
                      <CardDescription className="line-clamp-2 break-words">
                        {metric.description ?? metric.slug}
                      </CardDescription>
                    </div>
                    <LayoutDashboard className="size-4 shrink-0 text-muted-foreground" />
                  </div>
                </CardHeader>
                <CardContent className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline" size="tag">
                    {metric.definition?.widgets?.length ?? 0} widgets
                  </Badge>
                  {(metric.definition?.variables?.length ?? 0) > 0 && (
                    <Badge variant="outline" size="tag">
                      {metric.definition?.variables?.length} variables
                    </Badge>
                  )}
                  <span>Updated {formatSmartTime(metric.updatedAt)}</span>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <MetricEditorDialog open={editorOpen} onOpenChange={setEditorOpen} />
    </div>
  );
}

function MetricsDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: selected, isLoading } = useMetricDefinition(id);
  const tab = searchParams.get("tab") === "json" ? "json" : "dashboard";
  const fullMode = searchParams.get("mode") === "full";
  const expandedWidgetId = searchParams.get("widget");
  const variables = selected?.definition?.variables ?? [];
  const variableValues = useMemo(
    () => readVariableValues(variables, searchParams),
    [variables, searchParams],
  );
  const run = useMetricRun(selected?.id, selected?.definition?.refreshSeconds, variableValues);
  const resolvedVariables = run.data?.metric.definition.variables ?? variables;
  const controlValues = run.data?.variables ?? variableValues;
  const [editorOpen, setEditorOpen] = useState(false);

  const widgetResults = run.data?.widgets ?? [];
  const widgetResultById = new Map(widgetResults.map((item) => [item.widget.id, item.result]));
  const expandedWidget = run.data?.metric.definition.widgets.find(
    (widget) => widget.id === expandedWidgetId,
  );
  const expandedResult = expandedWidget ? widgetResultById.get(expandedWidget.id) : undefined;

  function updateSearch(updates: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) {
      if (value == null || value === "") next.delete(key);
      else next.set(key, value);
    }
    setSearchParams(next, { replace: false });
  }

  function setVariable(key: string, value: MetricParam) {
    updateSearch({ [`var_${key}`]: variableParamValue(value) });
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-16" />
        <Skeleton className="h-[420px]" />
      </div>
    );
  }

  if (!selected) {
    return (
      <div className="space-y-4">
        <PageHeader title="Metric not found" />
        <Button variant="outline" onClick={() => navigate("/usage/metrics")}>
          Back to metrics
        </Button>
      </div>
    );
  }

  const content = (
    <Tabs
      value={tab}
      onValueChange={(next) => updateSearch({ tab: next === "dashboard" ? null : next })}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <TabsList>
          <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
          <TabsTrigger value="json">JSON</TabsTrigger>
        </TabsList>
        <div className="flex flex-wrap items-center gap-2">
          {run.data && (
            <span className="text-xs text-muted-foreground">
              {run.data.result?.total ?? 0} rows in {run.data.result?.elapsed ?? 0}ms
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => run.refetch()}
            disabled={run.isFetching}
          >
            <RefreshCw className={cn("size-4", run.isFetching && "animate-spin")} />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={() => setEditorOpen(true)}>
            <Code2 className="size-4" />
            Edit JSON
          </Button>
          {!fullMode && (
            <Button variant="outline" size="sm" onClick={() => updateSearch({ mode: "full" })}>
              <Maximize2 className="size-4" />
              Full
            </Button>
          )}
        </div>
      </div>

      <TabsContent value="dashboard" className="mt-4 space-y-4">
        <VariableControls
          variables={resolvedVariables}
          values={controlValues}
          onChange={setVariable}
        />
        {run.isError ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            {run.error instanceof Error ? run.error.message : "Failed to run metric"}
          </div>
        ) : run.isLoading || !run.data ? (
          <div className="space-y-3">
            <Skeleton className="h-[280px] w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className={layoutGridClass(run.data.metric.definition.layout?.columns)}>
              {run.data.metric.definition.widgets.map((widget) => {
                const result = widgetResultById.get(widget.id);
                return (
                  <WidgetCard
                    key={widget.id}
                    widget={widget}
                    rows={result?.rows ?? []}
                    total={result?.total}
                    elapsed={result?.elapsed}
                    truncated={result?.truncated}
                    loading={run.isFetching}
                    onExpand={() => updateSearch({ widget: widget.id })}
                  />
                );
              })}
            </div>
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span>Updated {formatSmartTime(selected.updatedAt)}</span>
              {selected.definition.refreshSeconds && (
                <span>Auto-reloads every {selected.definition.refreshSeconds}s</span>
              )}
            </div>
          </div>
        )}
      </TabsContent>

      <TabsContent value="json" className="mt-4">
        <div className="overflow-hidden rounded-md border">
          <Editor
            height="640px"
            defaultLanguage="json"
            value={JSON.stringify(selected.definition, null, 2)}
            options={{ readOnly: true, minimap: { enabled: false }, wordWrap: "on", fontSize: 12 }}
          />
        </div>
      </TabsContent>
    </Tabs>
  );
  const expandedDialog = (
    <Dialog
      open={!!expandedWidget}
      onOpenChange={(open) => !open && updateSearch({ widget: null })}
    >
      <DialogContent className="w-[90vw] max-w-[90vw]">
        <DialogHeader>
          <DialogTitle>{expandedWidget?.title}</DialogTitle>
          <DialogDescription>
            {expandedWidget?.description ?? expandedWidget?.viz.type}
          </DialogDescription>
        </DialogHeader>
        {expandedWidget && (
          <WidgetViz
            widget={expandedWidget}
            rows={expandedResult?.rows ?? []}
            loading={run.isFetching}
          />
        )}
      </DialogContent>
    </Dialog>
  );

  if (fullMode) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-background">
        <div className="flex items-center justify-between gap-3 border-b bg-card px-4 py-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{selected.title}</div>
            <div className="truncate font-mono text-[10px] text-muted-foreground">
              {selected.slug}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => updateSearch({ mode: null })}>
            <Minimize2 className="size-3.5" />
            Exit full
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">{content}</div>
        {expandedDialog}
        <MetricEditorDialog metric={selected} open={editorOpen} onOpenChange={setEditorOpen} />
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-4">
      <PageHeader
        icon={LayoutDashboard}
        title={selected.title}
        description={selected.description ?? selected.slug}
        action={
          <Button asChild variant="outline">
            <Link to="/usage/metrics">Back to metrics</Link>
          </Button>
        }
      />
      {content}
      {expandedDialog}
      <MetricEditorDialog metric={selected} open={editorOpen} onOpenChange={setEditorOpen} />
    </div>
  );
}

export default function MetricsPage() {
  const { id } = useParams<{ id: string }>();
  return id ? <MetricsDetailPage /> : <MetricsListPage />;
}
