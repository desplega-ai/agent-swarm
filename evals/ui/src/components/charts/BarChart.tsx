import { type ReactNode, useMemo, useState } from "react";
import {
  fmtCompact,
  leftMarginFor,
  niceTicks,
  seriesColor,
  useContainerWidth,
} from "./chart-utils.ts";
import "./charts.css";

export interface BarGroup {
  key: string;
  label: string;
  /** One value per series index; null renders as a dim "—" (never a zero-height lie). */
  values: (number | null)[];
}

// Round-9 §4: no fixed left margin — it derives from the widest y tick.
const V_MARGIN = { top: 10, right: 12, bottom: 24 };
const V_MIN_MARGIN_LEFT = 46;
const H_LABEL_W = 150;
const H_VALUE_W = 64;
const H_BAR_H = 14;
const H_BAR_GAP = 4;
const H_GROUP_PAD = 10;
const DEFAULT_HEIGHT = 220;

interface BarHover {
  groupKey: string;
  label: string;
  series: string;
  value: string;
  px: number;
  py: number;
}

/**
 * Grouped bar chart with an optional horizontal layout (v5 spec §2.2 — FROZEN
 * props). Horizontal mode renders label column + bars + inline value labels;
 * vertical mode renders grouped columns with a hover tooltip.
 */
export function BarChart(props: {
  groups: BarGroup[];
  /** One name per values index; legend shown when > 1. */
  series: string[];
  horizontal?: boolean;
  height?: number;
  format?: (v: number) => string;
  colors?: string[];
  emptyText?: string;
}): ReactNode {
  const [ref, width] = useContainerWidth();
  const [hover, setHover] = useState<BarHover | null>(null);
  const format = props.format ?? fmtCompact;
  const seriesCount = Math.max(1, props.series.length);
  const colorOf = (i: number) => seriesColor(i, props.colors?.[i]);

  const max = useMemo(() => {
    const values = props.groups.flatMap((g) => g.values).filter((v): v is number => v !== null);
    return values.length > 0 ? Math.max(...values, 0) : null;
  }, [props.groups]);

  if (max === null || props.groups.length === 0) {
    return (
      <div className="chart" ref={ref}>
        <div className="chart-empty">{props.emptyText ?? "No data"}</div>
      </div>
    );
  }
  const scaleMax = max > 0 ? max * 1.05 : 1;

  const legend =
    props.series.length > 1 ? (
      <div className="chart-legend">
        {props.series.map((name, i) => (
          <span className="chart-legend-item" key={name}>
            <span className="chart-dot" style={{ background: colorOf(i) }} />
            {name}
          </span>
        ))}
      </div>
    ) : null;

  if (props.horizontal) {
    const rowH = seriesCount * (H_BAR_H + H_BAR_GAP) + H_GROUP_PAD;
    const height = props.groups.length * rowH + 8;
    const barAreaW = Math.max(10, width - H_LABEL_W - H_VALUE_W - 8);
    return (
      <div className="chart" ref={ref}>
        {width > 0 ? (
          // biome-ignore lint/a11y/noSvgWithoutTitle: decorative data visualization; values are rendered as inline labels
          <svg width={width} height={height}>
            {props.groups.map((group, gi) => {
              const top = gi * rowH + 4;
              return (
                <g key={group.key}>
                  <text
                    className="chart-bar-label"
                    x={H_LABEL_W - 8}
                    y={top + (rowH - H_GROUP_PAD) / 2 + 4}
                    textAnchor="end"
                  >
                    {group.label.length > 24 ? `${group.label.slice(0, 23)}…` : group.label}
                    <title>{group.label}</title>
                  </text>
                  {Array.from({ length: seriesCount }, (_, si) => {
                    const value = group.values[si] ?? null;
                    const y = top + si * (H_BAR_H + H_BAR_GAP);
                    if (value === null) {
                      return (
                        <text
                          // biome-ignore lint/suspicious/noArrayIndexKey: series slots are positional by contract
                          key={si}
                          className="chart-bar-null"
                          x={H_LABEL_W + 4}
                          y={y + H_BAR_H - 3}
                        >
                          —
                        </text>
                      );
                    }
                    const w = Math.max(1, (value / scaleMax) * barAreaW);
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: series slots are positional by contract
                      <g key={si}>
                        <rect
                          x={H_LABEL_W}
                          y={y}
                          width={w}
                          height={H_BAR_H}
                          rx={2}
                          fill={colorOf(si)}
                        />
                        <text className="chart-bar-value" x={H_LABEL_W + w + 5} y={y + H_BAR_H - 3}>
                          {format(value)}
                        </text>
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </svg>
        ) : null}
        {legend}
      </div>
    );
  }

  // vertical (grouped columns)
  const height = props.height ?? DEFAULT_HEIGHT;
  // Round-9 §4: left margin sized to the widest rendered y tick.
  const yTicks = niceTicks(0, scaleMax, 4);
  const marginLeft = leftMarginFor(
    yTicks.map((t) => format(t)),
    V_MIN_MARGIN_LEFT,
  );
  const innerW = Math.max(10, width - marginLeft - V_MARGIN.right);
  const innerH = Math.max(10, height - V_MARGIN.top - V_MARGIN.bottom);
  const sy = (v: number) => V_MARGIN.top + (1 - v / scaleMax) * innerH;
  const band = innerW / props.groups.length;
  const barW = Math.min(40, (band * 0.8) / seriesCount);
  const groupW = barW * seriesCount;

  return (
    <div className="chart" ref={ref}>
      {width > 0 ? (
        // biome-ignore lint/a11y/noSvgWithoutTitle: decorative data visualization; values are in the hover tooltip
        <svg width={width} height={height} onMouseLeave={() => setHover(null)}>
          {yTicks.map((t) => (
            <g key={`y${t}`}>
              <line
                className="chart-grid-line"
                x1={marginLeft}
                x2={marginLeft + innerW}
                y1={sy(t)}
                y2={sy(t)}
              />
              <text className="chart-tick" x={marginLeft - 6} y={sy(t) + 3} textAnchor="end">
                {format(t)}
              </text>
            </g>
          ))}
          <line
            className="chart-axis-line"
            x1={marginLeft}
            x2={marginLeft + innerW}
            y1={V_MARGIN.top + innerH}
            y2={V_MARGIN.top + innerH}
          />
          {props.groups.map((group, gi) => {
            const center = marginLeft + band * gi + band / 2;
            const label =
              group.label.length > Math.max(4, Math.floor(band / 7))
                ? `${group.label.slice(0, Math.max(3, Math.floor(band / 7) - 1))}…`
                : group.label;
            return (
              <g key={group.key}>
                <text
                  className="chart-bar-label"
                  x={center}
                  y={V_MARGIN.top + innerH + 14}
                  textAnchor="middle"
                >
                  {label}
                  <title>{group.label}</title>
                </text>
                {Array.from({ length: seriesCount }, (_, si) => {
                  const value = group.values[si] ?? null;
                  const x = center - groupW / 2 + si * barW;
                  if (value === null) {
                    return (
                      <text
                        // biome-ignore lint/suspicious/noArrayIndexKey: series slots are positional by contract
                        key={si}
                        className="chart-bar-null"
                        x={x + barW / 2}
                        y={V_MARGIN.top + innerH - 4}
                        textAnchor="middle"
                      >
                        —
                      </text>
                    );
                  }
                  const y = sy(value);
                  return (
                    // biome-ignore lint/a11y/noStaticElementInteractions: passive hover target — values are also reachable via the legend + labels
                    <rect
                      // biome-ignore lint/suspicious/noArrayIndexKey: series slots are positional by contract
                      key={si}
                      x={x + 1}
                      y={y}
                      width={Math.max(1, barW - 2)}
                      height={Math.max(1, V_MARGIN.top + innerH - y)}
                      rx={2}
                      fill={colorOf(si)}
                      onMouseEnter={() =>
                        setHover({
                          groupKey: group.key,
                          label: group.label,
                          series: props.series[si] ?? "",
                          value: format(value),
                          px: x + barW / 2,
                          py: y,
                        })
                      }
                    />
                  );
                })}
              </g>
            );
          })}
        </svg>
      ) : null}
      {hover !== null ? (
        <div
          className="chart-tip"
          style={
            hover.px > width * 0.62
              ? { right: width - hover.px + 8, top: Math.max(0, hover.py - 8) }
              : { left: hover.px + 8, top: Math.max(0, hover.py - 8) }
          }
        >
          <div className="chart-tip-title">{hover.label}</div>
          <div className="chart-tip-row">
            {hover.series ? <span>{hover.series}</span> : null}
            <span className="chart-tip-value">{hover.value}</span>
          </div>
        </div>
      ) : null}
      {legend}
    </div>
  );
}
