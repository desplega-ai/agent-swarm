/**
 * Catalog `Chart` and the `Metric` sparkline, on the recharts stack the
 * dashboard usage charts already use (shared tooltip style, theme color vars).
 */

import { AlertCircle, ChartNoAxesColumn } from "lucide-react";
import { useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Skeleton } from "@/components/ui/skeleton";
import { rechartsTooltipStyle } from "@/lib/recharts-tooltip-style";
import type { ChartProps } from "./catalog";
import {
  chartValueFormatter,
  type PieSlice,
  pieShareLabel,
  seriesColor,
  sparklineValues,
  timeLabelFormatter,
  timeTickFormatter,
  toChartPoints,
  toPieSlices,
} from "./chart-model";

const AXIS_TICK = { fontSize: 10, fill: "var(--color-muted-foreground)" };
const DEFAULT_HEIGHT = 240;

export function ChartComponent({ props }: { props: ChartProps }) {
  const height = props.height ?? DEFAULT_HEIGHT;
  const xType = props.xType ?? "category";
  const series = props.series ?? [];
  const seriesKeys = useMemo(() => series.map((entry) => entry.key), [series]);
  const radial = props.kind === "pie" || props.kind === "donut";
  const points = useMemo(
    () =>
      radial
        ? []
        : toChartPoints(Array.isArray(props.data) ? props.data : [], props.x, xType, seriesKeys),
    [radial, props.data, props.x, xType, seriesKeys],
  );
  // Pie and donut plot the first series only (the validator requires exactly one).
  const slices = useMemo(
    () =>
      radial && seriesKeys[0]
        ? toPieSlices(Array.isArray(props.data) ? props.data : [], props.x, seriesKeys[0])
        : [],
    [radial, props.data, props.x, seriesKeys],
  );
  const empty = radial ? slices.length === 0 : points.length === 0;

  if (props.error) {
    return (
      <div data-testid="json-render-chart">
        <AlertCallout tone="error" icon={AlertCircle} title="Query failed">
          {props.error}
        </AlertCallout>
      </div>
    );
  }
  if (props.loading && empty) {
    return (
      <div data-testid="json-render-chart">
        <Skeleton className="w-full" style={{ height }} />
      </div>
    );
  }
  if (empty) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border text-sm text-muted-foreground"
        style={{ height }}
        data-testid="json-render-chart"
      >
        <ChartNoAxesColumn aria-hidden className="size-5" />
        {props.emptyMessage ?? "No data yet"}
      </div>
    );
  }

  const tickValue = chartValueFormatter(props.format, props.currency, true);
  const tooltipValue = chartValueFormatter(props.format, props.currency);
  if (radial) {
    return (
      <PieView
        slices={slices}
        donut={props.kind === "donut"}
        height={height}
        legend={props.legend ?? true}
        formatValue={tooltipValue}
      />
    );
  }
  const timeAxis = xType === "time";
  // Bars need a band axis; lines and areas get a true time scale (gaps stay gaps).
  const numericTime = timeAxis && props.kind !== "bar";
  const tickX = timeAxis ? timeTickFormatter(points) : undefined;
  const labelX = timeAxis ? timeLabelFormatter(points) : undefined;
  const stackId = props.stacked ? "stack" : undefined;
  const showLegend = props.legend ?? series.length > 1;

  const axes = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
      <XAxis
        dataKey="__x"
        type={numericTime ? "number" : "category"}
        scale={numericTime ? "time" : "auto"}
        domain={numericTime ? ["dataMin", "dataMax"] : undefined}
        tickFormatter={tickX ? (value: number) => tickX(value) : undefined}
        tick={AXIS_TICK}
        tickLine={false}
        interval="preserveStartEnd"
        minTickGap={24}
      />
      <YAxis
        tickFormatter={(value: number) => tickValue(value)}
        tick={AXIS_TICK}
        tickLine={false}
        axisLine={false}
        width={52}
      />
      <Tooltip
        contentStyle={rechartsTooltipStyle}
        cursor={props.kind === "bar" ? { fill: "var(--color-muted)", opacity: 0.6 } : undefined}
        labelFormatter={(label) =>
          labelX && typeof label === "number" ? labelX(label) : String(label)
        }
        formatter={(value) => (typeof value === "number" ? tooltipValue(value) : String(value))}
      />
      {showLegend ? (
        <Legend
          iconSize={10}
          wrapperStyle={{ fontSize: 12 }}
          formatter={(value) => <span className="text-muted-foreground">{value}</span>}
        />
      ) : null}
    </>
  );
  const margin = { top: 4, right: 8, bottom: 0, left: 0 };

  let chart: React.ReactElement;
  if (props.kind === "bar") {
    chart = (
      <BarChart data={points} margin={margin}>
        {axes}
        {series.map((entry, index) => (
          <Bar
            key={entry.key}
            dataKey={entry.key}
            name={entry.label ?? entry.key}
            stackId={stackId}
            fill={seriesColor(entry.color, index)}
            radius={stackId && index < series.length - 1 ? 0 : [2, 2, 0, 0]}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    );
  } else if (props.kind === "area") {
    chart = (
      <AreaChart data={points} margin={margin}>
        {axes}
        {series.map((entry, index) => (
          <Area
            key={entry.key}
            dataKey={entry.key}
            name={entry.label ?? entry.key}
            stackId={stackId}
            type="monotone"
            stroke={seriesColor(entry.color, index)}
            fill={seriesColor(entry.color, index)}
            fillOpacity={0.2}
            strokeWidth={2}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    );
  } else {
    chart = (
      <LineChart data={points} margin={margin}>
        {axes}
        {series.map((entry, index) => (
          <Line
            key={entry.key}
            dataKey={entry.key}
            name={entry.label ?? entry.key}
            type="monotone"
            stroke={seriesColor(entry.color, index)}
            strokeWidth={2}
            dot={points.length <= 31}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    );
  }

  return (
    <div className="min-w-0" data-testid="json-render-chart">
      <ResponsiveContainer width="100%" height={height}>
        {chart}
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Pie or donut over the slices. Each slice is labelled with its share; the
 * tooltip shows the value in the Chart's `format`, plus the share.
 */
function PieView({
  slices,
  donut,
  height,
  legend,
  formatValue,
}: {
  slices: PieSlice[];
  donut: boolean;
  height: number;
  legend: boolean;
  formatValue: (value: number) => string;
}) {
  const data = slices.map((slice) => ({ ...slice, fill: slice.color }));
  return (
    <div
      className="min-w-0"
      data-testid="json-render-chart"
      data-chart-kind={donut ? "donut" : "pie"}
    >
      <ResponsiveContainer width="100%" height={height}>
        <PieChart margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
          <Pie
            data={data}
            dataKey="value"
            nameKey="label"
            // Share labels sit outside the ring; 70% leaves them room at the top and bottom.
            innerRadius={donut ? "48%" : 0}
            outerRadius="70%"
            stroke="var(--color-card)"
            strokeWidth={1}
            label={({ payload }: { payload?: PieSlice }) =>
              payload ? pieShareLabel(payload.percent) : ""
            }
            labelLine={false}
            isAnimationActive={false}
          />
          <Tooltip
            contentStyle={rechartsTooltipStyle}
            formatter={(value, _name, item) => {
              const slice = (item as { payload?: PieSlice } | undefined)?.payload;
              const text = typeof value === "number" ? formatValue(value) : String(value);
              return slice ? `${text} (${pieShareLabel(slice.percent)})` : text;
            }}
          />
          {legend ? (
            <Legend
              iconSize={10}
              wrapperStyle={{ fontSize: 12 }}
              formatter={(value) => <span className="text-muted-foreground">{value}</span>}
            />
          ) : null}
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Metric tones → the same status color tokens the stat tile's icon uses. */
const SPARKLINE_COLORS: Record<string, string> = {
  neutral: "var(--color-primary)",
  success: "var(--color-status-success)",
  active: "var(--color-status-active)",
  error: "var(--color-status-error)",
  info: "var(--color-status-info)",
  pending: "var(--color-status-pending)",
  warning: "var(--color-status-warning)",
  paused: "var(--color-status-paused)",
};

export function Sparkline({
  data,
  dataKey,
  tone,
}: {
  data: unknown;
  dataKey: string | undefined;
  tone: string | undefined;
}) {
  const values = useMemo(() => sparklineValues(data, dataKey), [data, dataKey]);
  if (values.length === 0) return null;
  const color = SPARKLINE_COLORS[tone ?? "neutral"] ?? SPARKLINE_COLORS.neutral;
  return (
    <div className="h-8 w-full" data-testid="json-render-metric-sparkline" aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={values.map((v) => ({ v }))}
          margin={{ top: 2, right: 0, bottom: 2, left: 0 }}
        >
          <Area
            dataKey="v"
            type="monotone"
            stroke={color}
            fill={color}
            fillOpacity={0.15}
            strokeWidth={1.5}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
