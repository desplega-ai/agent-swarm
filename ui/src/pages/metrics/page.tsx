import Editor from "@monaco-editor/react";
import type { ColDef } from "ag-grid-community";
import {
  BarChart3,
  Code2,
  LayoutDashboard,
  LineChart as LineChartIcon,
  Plus,
  RefreshCw,
  Save,
  Table2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";
import {
  useCreateMetric,
  useMetricDefinitions,
  useMetricRun,
  useUpdateMetric,
} from "@/api/hooks/use-metric-definitions";
import type {
  MetricDefinition,
  MetricFormat,
  MetricListItem,
  MetricVisualization,
  MetricVizColumn,
  MetricWidget,
} from "@/api/types";
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
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatSmartTime } from "@/lib/utils";

const NEW_METRIC_DEFINITION: MetricDefinition = {
  version: 1,
  refreshSeconds: 60,
  layout: { columns: 2 },
  widgets: [
    {
      id: "task-statuses",
      title: "Task statuses",
      description: "Tasks grouped by current status.",
      query: {
        sql: "SELECT status, COUNT(*) AS tasks FROM agent_tasks GROUP BY status ORDER BY tasks DESC",
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

const CHART_COLORS = ["#f59e0b", "#38bdf8", "#22c55e", "#f43f5e", "#a78bfa"];

function formatValue(value: unknown, format?: MetricFormat): string {
  if (value == null) return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (format === "currency" && Number.isFinite(n)) {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 4,
    }).format(n);
  }
  if (format === "percent" && Number.isFinite(n)) {
    return `${(n * 100).toFixed(1)}%`;
  }
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

function MetricTable({
  rows,
  columns,
  loading,
}: {
  rows: Record<string, unknown>[];
  columns?: MetricVizColumn[];
  loading?: boolean;
}) {
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
    <DataGrid
      rowData={rows}
      columnDefs={columnDefs}
      loading={loading}
      emptyMessage="No rows"
      pagination={rows.length > 20}
      paginationPageSize={20}
      domLayout="autoHeight"
      enableCellTextSelection
      className="min-h-[220px]"
    />
  );
}

function MetricChart({ rows, widget }: { rows: Record<string, unknown>[]; widget: MetricWidget }) {
  const xKey = widget.viz.x ?? Object.keys(rows[0] ?? {})[0] ?? "x";
  const yKey = widget.viz.y ?? Object.keys(rows[0] ?? {})[1] ?? "y";
  const seriesKeys = widget.viz.series && widget.viz.series.length > 0 ? widget.viz.series : [yKey];

  if (widget.viz.type === "line" || widget.viz.type === "multi-line") {
    return (
      <div className="h-[280px] w-full">
        <ResponsiveContainer>
          <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey={xKey} tickLine={false} axisLine={false} minTickGap={20} />
            <YAxis tickLine={false} axisLine={false} width={44} />
            <Tooltip />
            {seriesKeys.map((series, index) => (
              <Line
                key={series}
                type="monotone"
                dataKey={series}
                stroke={CHART_COLORS[index % CHART_COLORS.length]}
                strokeWidth={2}
                dot={widget.viz.type === "line"}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <div className="h-[280px] w-full">
      <ResponsiveContainer>
        <BarChart data={rows} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey={xKey} tickLine={false} axisLine={false} minTickGap={10} />
          <YAxis tickLine={false} axisLine={false} width={44} />
          <Tooltip />
          {seriesKeys.map((series, index) => (
            <Bar
              key={series}
              dataKey={series}
              fill={CHART_COLORS[index % CHART_COLORS.length]}
              radius={[4, 4, 0, 0]}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
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
      <Card className="rounded-md">
        <CardHeader className="py-4">
          <CardDescription>
            {labelKey ? String(rows[0]?.[labelKey] ?? widget.title) : widget.title}
          </CardDescription>
          <CardTitle className="font-mono text-4xl tabular-nums">
            {formatValue(rows[0]?.[valueKey], widget.viz.format)}
          </CardTitle>
        </CardHeader>
      </Card>
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
        <MetricTable rows={rows} columns={widget.viz.columns} loading={loading} />
      </div>
    );
  }

  return <MetricTable rows={rows} columns={widget.viz.columns} loading={loading} />;
}

function widgetIcon(type: MetricVisualization) {
  if (type === "table") return Table2;
  if (type === "line" || type === "multi-line") return LineChartIcon;
  return BarChart3;
}

function WidgetCard({
  widget,
  rows,
  total,
  elapsed,
  truncated,
  loading,
}: {
  widget: MetricWidget;
  rows: Record<string, unknown>[];
  total?: number;
  elapsed?: number;
  truncated?: boolean;
  loading?: boolean;
}) {
  const Icon = widgetIcon(widget.viz.type);
  return (
    <Card className="min-w-0 rounded-md">
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
          <Badge variant="outline" size="tag" className="shrink-0">
            {widget.viz.type}
          </Badge>
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
    setTitle(metric?.title ?? "New metric");
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
        toast.success("Metric updated");
      } else {
        await createMetric.mutateAsync({
          title,
          slug: slug || undefined,
          description: description || null,
          definition,
        });
        toast.success("Metric created");
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save metric");
    }
  }

  const pending = createMetric.isPending || updateMetric.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>{metric ? "Edit dashboard" : "Add dashboard"}</DialogTitle>
          <DialogDescription>{metric?.slug ?? "JSON dashboard definition"}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-[280px_1fr]">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="metric-title">Dashboard name</Label>
              <Input id="metric-title" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="metric-slug">Slug</Label>
              <Input id="metric-slug" value={slug} onChange={(e) => setSlug(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="metric-description">Description</Label>
              <Input
                id="metric-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            {error && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}
          </div>

          <div className="min-h-[420px] overflow-hidden rounded-md border">
            <Editor
              height="420px"
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

export default function MetricsPage() {
  const { data, isLoading } = useMetricDefinitions({ fields: "full", limit: 100 });
  const metrics = useMemo(() => data?.metrics ?? [], [data]);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [editorMetric, setEditorMetric] = useState<MetricListItem | undefined>();
  const [editorOpen, setEditorOpen] = useState(false);

  useEffect(() => {
    if (!selectedId && metrics[0]) setSelectedId(metrics[0].id);
  }, [metrics, selectedId]);

  const selected = metrics.find((metric) => metric.id === selectedId) ?? metrics[0];
  const refreshSeconds = selected?.definition?.refreshSeconds;
  const run = useMetricRun(selected?.id, refreshSeconds);

  function openEditor(metric?: MetricListItem) {
    setEditorMetric(metric);
    setEditorOpen(true);
  }

  const runMetric = run.data?.metric;
  const widgetResults = run.data?.widgets ?? [];
  const widgetResultById = new Map(widgetResults.map((item) => [item.widget.id, item.result]));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader
        icon={BarChart3}
        title="Dashboards"
        description="Editable JSON dashboards composed from SQL query widgets and viz configs."
        action={
          <Button onClick={() => openEditor()}>
            <Plus className="size-4" />
            Add dashboard
          </Button>
        }
      />

      <div className="grid min-h-0 min-w-0 flex-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <Card className="min-h-0 min-w-0 rounded-md py-0">
          <CardHeader className="border-b py-4">
            <CardTitle className="text-base">Dashboards</CardTitle>
            <CardDescription>{data?.total ?? 0} saved dashboards</CardDescription>
          </CardHeader>
          <CardContent className="min-h-0 overflow-y-auto p-2">
            {isLoading ? (
              <div className="space-y-2 p-2">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : (
              <div className="space-y-1">
                {metrics.map((metric) => {
                  const widgetCount = metric.definition?.widgets?.length ?? 0;
                  return (
                    <button
                      key={metric.id}
                      type="button"
                      onClick={() => setSelectedId(metric.id)}
                      className={cn(
                        "w-full min-w-0 rounded-md border p-3 text-left transition-colors hover:bg-muted/60",
                        metric.id === selected?.id
                          ? "border-primary bg-primary/5"
                          : "border-transparent",
                      )}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <LayoutDashboard className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {metric.title}
                        </span>
                        <Badge variant="outline" size="tag" className="shrink-0">
                          {widgetCount} widgets
                        </Badge>
                      </div>
                      <div className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">
                        {metric.description ?? metric.slug}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="min-h-0 min-w-0 rounded-md">
          <CardHeader className="border-b">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle>{selected?.title ?? "Metrics"}</CardTitle>
                <CardDescription className="break-words">
                  {selected?.description ?? selected?.slug ?? "No metric selected"}
                </CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {run.data && (
                  <span className="text-xs text-muted-foreground">
                    {run.data.result.total} rows in {run.data.result.elapsed}ms
                  </span>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => run.refetch()}
                  disabled={!selected || run.isFetching}
                >
                  <RefreshCw className={cn("size-4", run.isFetching && "animate-spin")} />
                  Refresh
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => selected && openEditor(selected)}
                  disabled={!selected}
                >
                  <Code2 className="size-4" />
                  Edit JSON
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="min-h-0 overflow-y-auto">
            {run.isLoading || !runMetric ? (
              <div className="space-y-3">
                <Skeleton className="h-[280px] w-full" />
                <Skeleton className="h-28 w-full" />
              </div>
            ) : run.isError ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
                {run.error instanceof Error ? run.error.message : "Failed to run metric"}
              </div>
            ) : (
              <div className="space-y-4">
                <div
                  className={cn(
                    "grid gap-4",
                    (runMetric.definition.layout?.columns ?? 2) > 1 && "xl:grid-cols-2",
                  )}
                >
                  {runMetric.definition.widgets.map((widget) => {
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
                      />
                    );
                  })}
                </div>
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span>
                    Updated {selected?.updatedAt ? formatSmartTime(selected.updatedAt) : "—"}
                  </span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <MetricEditorDialog metric={editorMetric} open={editorOpen} onOpenChange={setEditorOpen} />
    </div>
  );
}
