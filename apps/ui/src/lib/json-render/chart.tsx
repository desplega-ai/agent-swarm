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
  seriesColor,
  sparklineValues,
  timeLabelFormatter,
  timeTickFormatter,
  toChartPoints,
} from "./chart-model";

const AXIS_TICK = { fontSize: 10, fill: "var(--color-muted-foreground)" };
const DEFAULT_HEIGHT = 240;

export function ChartComponent({ props }: { props: ChartProps }) {
  const height = props.height ?? DEFAULT_HEIGHT;
  const xType = props.xType ?? "category";
  const series = props.series ?? [];
  const seriesKeys = useMemo(() => series.map((entry) => entry.key), [series]);
  const points = useMemo(
    () => toChartPoints(Array.isArray(props.data) ? props.data : [], props.x, xType, seriesKeys),
    [props.data, props.x, xType, seriesKeys],
  );

  if (props.error) {
    return (
      <div data-testid="json-render-chart">
        <AlertCallout tone="error" icon={AlertCircle} title="Query failed">
          {props.error}
        </AlertCallout>
      </div>
    );
  }
  if (props.loading && points.length === 0) {
    return (
      <div data-testid="json-render-chart">
        <Skeleton className="w-full" style={{ height }} />
      </div>
    );
  }
  if (points.length === 0) {
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
