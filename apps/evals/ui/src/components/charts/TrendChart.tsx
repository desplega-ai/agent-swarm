import { type MouseEvent, type ReactNode, useMemo, useState } from "react";
import { fmtDate } from "../format.ts";
import { leftMarginFor, niceTicks, seriesColor, useContainerWidth } from "./chart-utils.ts";
import "./charts.css";

/**
 * Per-run trend with a confidence band: one line per config, x = run time, y = a
 * 0 to 1 rate. Where a point carries `lo`/`hi` a shaded band is drawn behind the
 * line, so a dip that stays inside the band reads as noise and one that leaves it
 * reads as a regression. Points without a band (a single attempt per scenario, or
 * a pass rate) draw as a plain line.
 *
 * The data is prepared by `trendLine` (lib/suite-analytics.ts); this component
 * only draws and hit-tests.
 */
export interface TrendPointData {
  x: number;
  y: number;
  lo: number | null;
  hi: number | null;
  /** Shown in the hover card for this point. */
  label: string;
  detail?: string;
}

export interface TrendSeries {
  id: string;
  name: string;
  color?: string;
  points: TrendPointData[];
}

const MARGIN = { top: 14, right: 16, bottom: 26 };
const MIN_MARGIN_LEFT = 40;
const DEFAULT_HEIGHT = 260;
const DOT_R = 3.5;

interface Hover {
  x: number;
}

export function TrendChart(props: {
  series: TrendSeries[];
  yFormat: (v: number) => string;
  height?: number;
  emptyText?: string;
}): ReactNode {
  const [ref, width] = useContainerWidth();
  const [hover, setHover] = useState<Hover | null>(null);
  const height = props.height ?? DEFAULT_HEIGHT;

  const layout = useMemo(() => {
    const points = props.series.flatMap((s) => s.points);
    if (points.length === 0) return null;
    let x0 = Math.min(...points.map((p) => p.x));
    let x1 = Math.max(...points.map((p) => p.x));
    if (x0 === x1) {
      x0 -= 12 * 3_600_000;
      x1 += 12 * 3_600_000;
    } else {
      const pad = (x1 - x0) * 0.04;
      x0 -= pad;
      x1 += pad;
    }
    const lows = points.map((p) => p.lo ?? p.y);
    const highs = points.map((p) => p.hi ?? p.y);
    let y0 = Math.min(...lows);
    let y1 = Math.max(...highs);
    const span = Math.max(y1 - y0, 0.05);
    y0 = Math.max(0, y0 - span * 0.15);
    y1 = Math.min(1, y1 + span * 0.15);
    if (y1 - y0 < 0.05) y1 = Math.min(1, y0 + 0.05);
    const snapXs = [...new Set(points.map((p) => p.x))].sort((a, b) => a - b);
    return { x0, x1, y0, y1, snapXs };
  }, [props.series]);

  if (layout === null) {
    return (
      <div className="chart" ref={ref}>
        <div className="chart-empty">{props.emptyText ?? "No runs to draw yet"}</div>
      </div>
    );
  }

  const yTicks = niceTicks(layout.y0, layout.y1, 4);
  const marginLeft = leftMarginFor(yTicks.map(props.yFormat), MIN_MARGIN_LEFT);
  const innerW = Math.max(10, width - marginLeft - MARGIN.right);
  const innerH = Math.max(10, height - MARGIN.top - MARGIN.bottom);
  const sx = (x: number) => marginLeft + ((x - layout.x0) / (layout.x1 - layout.x0)) * innerW;
  const sy = (y: number) => MARGIN.top + (1 - (y - layout.y0) / (layout.y1 - layout.y0)) * innerH;
  const xTickCount = Math.max(2, Math.min(6, Math.floor(innerW / 120)));
  const xTicks = Array.from(
    { length: xTickCount },
    (_, i) => layout.x0 + ((layout.x1 - layout.x0) * i) / (xTickCount - 1),
  );

  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const dataX =
      layout.x0 + ((e.clientX - rect.left - marginLeft) / innerW) * (layout.x1 - layout.x0);
    let nearest = layout.snapXs[0] as number;
    for (const x of layout.snapXs) {
      if (Math.abs(x - dataX) < Math.abs(nearest - dataX)) nearest = x;
    }
    setHover({ x: nearest });
  };

  const hoverRows =
    hover === null
      ? []
      : props.series.flatMap((s, i) => {
          const p = s.points.find((q) => q.x === hover.x);
          return p ? [{ s, p, color: seriesColor(i, s.color) }] : [];
        });
  const hoverPx = hover === null ? 0 : sx(hover.x);

  return (
    <div className="chart" ref={ref}>
      {width > 0 ? (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label="Score per run for each config, with a 95% confidence band"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        >
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
                {props.yFormat(t)}
              </text>
            </g>
          ))}
          <line
            className="chart-axis-line"
            x1={marginLeft}
            x2={marginLeft + innerW}
            y1={MARGIN.top + innerH}
            y2={MARGIN.top + innerH}
          />
          {xTicks.map((t) => (
            <text
              key={`x${t}`}
              className="chart-tick"
              x={sx(t)}
              y={MARGIN.top + innerH + 15}
              textAnchor="middle"
            >
              {fmtDate(new Date(t).toISOString())}
            </text>
          ))}
          {props.series.map((s, i) => {
            const color = seriesColor(i, s.color);
            const banded = s.points.filter((p) => p.lo !== null && p.hi !== null);
            const upper = banded.map((p) => `${sx(p.x)} ${sy(p.hi as number)}`);
            const lower = banded.map((p) => `${sx(p.x)} ${sy(p.lo as number)}`).reverse();
            const line = s.points.map((p, j) => `${j === 0 ? "M" : "L"}${sx(p.x)} ${sy(p.y)}`);
            return (
              <g key={s.id}>
                {banded.length > 1 ? (
                  <path
                    className="trend-band"
                    d={`M${upper.join("L")}L${lower.join("L")}Z`}
                    fill={color}
                  />
                ) : null}
                {banded.length === 1 ? (
                  <line
                    className="trend-whisker"
                    stroke={color}
                    x1={sx((banded[0] as TrendPointData).x)}
                    x2={sx((banded[0] as TrendPointData).x)}
                    y1={sy((banded[0] as TrendPointData).lo as number)}
                    y2={sy((banded[0] as TrendPointData).hi as number)}
                  />
                ) : null}
                {s.points.length > 1 ? (
                  <path className="trend-line" d={line.join("")} stroke={color} />
                ) : null}
                {s.points.map((p) => (
                  <circle
                    key={p.x}
                    className={hover?.x === p.x ? "trend-dot hover" : "trend-dot"}
                    cx={sx(p.x)}
                    cy={sy(p.y)}
                    r={DOT_R}
                    fill={color}
                  />
                ))}
              </g>
            );
          })}
          {hover !== null ? (
            <line
              className="chart-crosshair"
              x1={hoverPx}
              x2={hoverPx}
              y1={MARGIN.top}
              y2={MARGIN.top + innerH}
            />
          ) : null}
        </svg>
      ) : null}
      {hover !== null && hoverRows.length > 0 ? (
        <div
          className="chart-tip trend-tip"
          style={
            hoverPx > width * 0.6
              ? { right: width - hoverPx + 12, top: MARGIN.top }
              : { left: hoverPx + 12, top: MARGIN.top }
          }
        >
          <div className="chart-tip-title">{fmtDate(new Date(hover.x).toISOString())}</div>
          {hoverRows.map(({ s, p, color }) => (
            <div key={s.id} className="trend-tip-row">
              <div className="chart-tip-row">
                <span>
                  <span className="chart-dot" style={{ background: color }} /> {s.name}
                </span>
                <span className="chart-tip-value">
                  {props.yFormat(p.y)}
                  {p.lo !== null && p.hi !== null
                    ? ` (${props.yFormat(p.lo)} to ${props.yFormat(p.hi)})`
                    : ""}
                </span>
              </div>
              <div className="dim trend-tip-detail">
                {p.label}
                {p.detail ? ` · ${p.detail}` : ""}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
