import { ResponsiveBar } from "@nivo/bar";
import { ResponsiveLine } from "@nivo/line";
import { useMemo } from "react";

// Categorical palette sourced from semantic design tokens (theme-aware via the
// CSS custom properties; nivo applies these strings as SVG `fill`). Keeps the
// `check:tokens` gate happy — no raw hex literals in src/.
const CHART_COLORS = [
  "var(--color-action-default)",
  "var(--color-status-success)",
  "var(--color-status-error)",
  "var(--color-action-delegate-to-agent)",
  "var(--color-status-warning)",
  "var(--color-action-script)",
];

export interface CategoricalChartProps {
  data: Record<string, unknown>[];
  indexBy: string;
  keys: string[];
  height?: number;
  valueFormatter?: (value: unknown, key?: string) => string;
}

export function SharedBarChart({
  data,
  indexBy,
  keys,
  height = 280,
  valueFormatter,
}: CategoricalChartProps) {
  const chartData = useMemo(
    () =>
      data.map((row) => {
        const next: Record<string, string | number> = {};
        next[indexBy] = String(row[indexBy] ?? "");
        for (const key of keys) {
          const value = row[key];
          const numeric = typeof value === "number" ? value : Number(value);
          next[key] = Number.isFinite(numeric) ? numeric : 0;
        }
        return next;
      }),
    [data, indexBy, keys],
  );

  return (
    <div style={{ height }} className="w-full min-w-0">
      <ResponsiveBar
        data={chartData}
        keys={keys}
        indexBy={indexBy}
        margin={{ top: 12, right: 20, bottom: 52, left: 56 }}
        padding={0.24}
        groupMode={keys.length > 1 ? "grouped" : "stacked"}
        colors={CHART_COLORS}
        borderRadius={3}
        enableLabel={false}
        axisTop={null}
        axisRight={null}
        axisBottom={{
          tickSize: 0,
          tickPadding: 10,
          tickRotation: data.length > 8 ? -28 : 0,
        }}
        axisLeft={{
          tickSize: 0,
          tickPadding: 8,
          format: (value) => valueFormatter?.(value) ?? String(value),
        }}
        labelSkipWidth={12}
        labelSkipHeight={12}
        tooltip={({ id, value, indexValue }) => (
          <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
            <div className="font-medium text-popover-foreground">{String(indexValue)}</div>
            <div className="text-muted-foreground">
              {String(id)}: {valueFormatter?.(value, String(id)) ?? String(value)}
            </div>
          </div>
        )}
        theme={nivoTheme}
      />
    </div>
  );
}

export interface LineSeries {
  id: string;
  data: Array<{ x: string | number; y: number | null }>;
}

export interface SharedLineChartProps {
  data: Record<string, unknown>[];
  xKey: string;
  keys: string[];
  height?: number;
  valueFormatter?: (value: unknown, key?: string) => string;
}

export function SharedLineChart({
  data,
  xKey,
  keys,
  height = 280,
  valueFormatter,
}: SharedLineChartProps) {
  const series = useMemo<LineSeries[]>(
    () =>
      keys.map((key) => ({
        id: key,
        data: data.map((row) => {
          const rawY = row[key];
          const y = typeof rawY === "number" ? rawY : Number(rawY);
          return {
            x: String(row[xKey] ?? ""),
            y: Number.isFinite(y) ? y : null,
          };
        }),
      })),
    [data, keys, xKey],
  );

  return (
    <div style={{ height }} className="w-full min-w-0">
      <ResponsiveLine
        data={series}
        margin={{ top: 12, right: 24, bottom: 52, left: 56 }}
        xScale={{ type: "point" }}
        yScale={{ type: "linear", min: "auto", max: "auto", stacked: false, reverse: false }}
        curve="monotoneX"
        colors={CHART_COLORS}
        lineWidth={2}
        pointSize={5}
        pointBorderWidth={1}
        enableGridX={false}
        axisTop={null}
        axisRight={null}
        axisBottom={{
          tickSize: 0,
          tickPadding: 10,
          tickRotation: data.length > 8 ? -28 : 0,
        }}
        axisLeft={{
          tickSize: 0,
          tickPadding: 8,
          format: (value) => valueFormatter?.(value) ?? String(value),
        }}
        useMesh
        tooltip={({ point }) => (
          <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
            <div className="font-medium text-popover-foreground">
              {String(point.data.xFormatted)}
            </div>
            <div className="text-muted-foreground">
              {point.seriesId}:{" "}
              {valueFormatter?.(point.data.y, String(point.seriesId)) ?? point.data.yFormatted}
            </div>
          </div>
        )}
        theme={nivoTheme}
      />
    </div>
  );
}

const nivoTheme = {
  text: {
    fill: "var(--color-muted-foreground)",
    fontSize: 11,
  },
  axis: {
    ticks: {
      text: {
        fill: "var(--color-muted-foreground)",
        fontSize: 11,
      },
    },
    legend: {
      text: {
        fill: "var(--color-muted-foreground)",
        fontSize: 11,
      },
    },
  },
  grid: {
    line: {
      stroke: "var(--color-border)",
      strokeDasharray: "3 3",
    },
  },
};
