import { ResponsiveBar } from "@nivo/bar";
import { ResponsiveLine } from "@nivo/line";
import { useMemo } from "react";
import { useElementWidth } from "@/hooks/use-element-width";

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

/** Left + right plot margins shared by both charts, in px. */
const PLOT_X_MARGIN = 56 + 24;

/**
 * The x labels to draw: every k-th one, so neighbours keep their distance in
 * a plot `widthPx` wide. Upright labels need their own width apart; labels
 * rotated -28deg need ~28px, or their baselines stack into one smear.
 */
function thinXTicks(labels: string[], widthPx: number, rotated: boolean): string[] | undefined {
  if (widthPx <= 0 || labels.length === 0) return undefined;
  const longest = labels.reduce((max, label) => Math.max(max, label.length), 0);
  const minGapPx = rotated ? 28 : longest * 6.5 + 12;
  const slotPx = (widthPx - PLOT_X_MARGIN) / labels.length;
  const every = Math.max(1, Math.ceil(minGapPx / Math.max(slotPx, 1)));
  return every === 1 ? undefined : labels.filter((_, index) => index % every === 0);
}

export interface CategoricalChartProps {
  data: Record<string, unknown>[];
  indexBy: string;
  keys: string[];
  height?: number;
  valueFormatter?: (value: unknown, key?: string) => string;
  /** Y-axis tick formatter; falls back to `valueFormatter` when omitted. */
  axisFormatter?: (value: unknown) => string;
  /** Fixed y-axis max (e.g. 1 for rate charts); defaults to nivo's auto. */
  maxValue?: number;
  /** Approximate y-axis tick count (d3 snaps to round values). */
  yTickCount?: number;
  /** Render a legend row above the plot — use whenever `keys.length >= 2`. */
  showLegend?: boolean;
  /** Bar padding override in [0, 1] (nivo default here is 0.24). */
  padding?: number;
}

export function SharedBarChart({
  data,
  indexBy,
  keys,
  height = 280,
  valueFormatter,
  axisFormatter,
  maxValue,
  yTickCount,
  showLegend = false,
  padding = 0.24,
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

  const [plotRef, plotWidth] = useElementWidth<HTMLDivElement>();
  const rotated = data.length > 8;
  const xTicks = thinXTicks(
    chartData.map((row) => String(row[indexBy])),
    plotWidth,
    rotated,
  );

  return (
    <div ref={plotRef} style={{ height }} className="w-full min-w-0">
      <ResponsiveBar
        data={chartData}
        keys={keys}
        indexBy={indexBy}
        margin={{ top: showLegend ? 30 : 12, right: 20, bottom: 52, left: 56 }}
        padding={padding}
        innerPadding={keys.length > 1 ? 2 : 0}
        groupMode={keys.length > 1 ? "grouped" : "stacked"}
        colors={CHART_COLORS}
        valueScale={{ type: "linear", min: 0, max: maxValue ?? "auto" }}
        borderRadius={3}
        enableLabel={false}
        axisTop={null}
        axisRight={null}
        axisBottom={{
          tickSize: 0,
          tickPadding: 10,
          tickRotation: rotated ? -28 : 0,
          tickValues: xTicks,
        }}
        axisLeft={{
          tickSize: 0,
          tickPadding: 8,
          tickValues: yTickCount,
          format: (value) => (axisFormatter ?? valueFormatter)?.(value) ?? String(value),
        }}
        gridYValues={yTickCount}
        labelSkipWidth={12}
        labelSkipHeight={12}
        legends={
          showLegend
            ? [
                {
                  dataFrom: "keys",
                  anchor: "top-right",
                  direction: "row",
                  translateY: -26,
                  itemsSpacing: 12,
                  itemWidth: 84,
                  itemHeight: 14,
                  symbolSize: 8,
                  symbolShape: "circle",
                },
              ]
            : undefined
        }
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

  const [plotRef, plotWidth] = useElementWidth<HTMLDivElement>();
  const rotated = data.length > 8;
  const xTicks = thinXTicks(
    data.map((row) => String(row[xKey] ?? "")),
    plotWidth,
    rotated,
  );

  return (
    <div ref={plotRef} style={{ height }} className="w-full min-w-0">
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
          tickRotation: rotated ? -28 : 0,
          tickValues: xTicks,
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
  legends: {
    text: {
      fill: "var(--color-muted-foreground)",
      fontSize: 11,
    },
  },
};
