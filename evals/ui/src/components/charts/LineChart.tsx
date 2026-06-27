import { type MouseEvent, type ReactNode, useMemo, useState } from "react";
import { fmtDate } from "../format.ts";
import {
  fmtCompact,
  leftMarginFor,
  niceTicks,
  seriesColor,
  useContainerWidth,
} from "./chart-utils.ts";
import "./charts.css";

export interface LinePoint {
  /** Epoch ms (time x-axis). */
  x: number;
  /** Null → gap in the line (missing metric is NOT zero). */
  y: number | null;
}

export interface LineSeries {
  id: string;
  name: string;
  color?: string;
  points: LinePoint[];
}

/** Vertical dashed marker line with a top label (version changes — v5 spec §2.1). */
export interface ChartMarker {
  x: number;
  label: string;
  color?: string;
}

// Round-9 §4: no fixed left margin — it derives from the widest y tick.
const MARGIN = { top: 26, right: 14, bottom: 22 };
const MIN_MARGIN_LEFT = 46;
const DEFAULT_HEIGHT = 220;
/** 9px mono glyph-width estimate for the marker labels. */
const MARKER_CHAR_W = 5.4;

interface Hover {
  /** Snapped data x. */
  x: number;
  /** Pixel x of the snapped value inside the svg. */
  px: number;
}

function defaultXFormat(x: number): string {
  return fmtDate(new Date(x).toISOString());
}

/**
 * Multi-series time line chart (v5 spec §2.1 — FROZEN props). Hand-rolled SVG:
 * hover crosshair + tooltip, gaps at null y, dashed vertical markers with labels.
 */
export function LineChart(props: {
  series: LineSeries[];
  markers?: ChartMarker[];
  height?: number;
  yFormat?: (v: number) => string;
  xFormat?: (x: number) => string;
  /** y domain floor; default 0 (data min when negative). Max is auto (+5% headroom). */
  yMin?: number;
  emptyText?: string;
}): ReactNode {
  const [ref, width] = useContainerWidth();
  const [hover, setHover] = useState<Hover | null>(null);
  const height = props.height ?? DEFAULT_HEIGHT;
  const yFormat = props.yFormat ?? fmtCompact;
  const xFormat = props.xFormat ?? defaultXFormat;
  const markers = props.markers ?? [];

  const layout = useMemo(() => {
    const valued = props.series.flatMap((s) => s.points.filter((p) => p.y !== null));
    if (valued.length === 0) return null;
    const allX = [
      ...props.series.flatMap((s) => s.points.map((p) => p.x)),
      ...markers.map((m) => m.x),
    ];
    let x0 = Math.min(...allX);
    let x1 = Math.max(...allX);
    if (x0 === x1) {
      x0 -= 3_600_000;
      x1 += 3_600_000;
    } else {
      const pad = (x1 - x0) * 0.03;
      x0 -= pad;
      x1 += pad;
    }
    const ys = valued.map((p) => p.y as number);
    const dataMin = Math.min(...ys);
    const dataMax = Math.max(...ys);
    const y0 = Math.min(props.yMin ?? 0, dataMin);
    let y1 = dataMax;
    if (y1 <= y0) y1 = y0 + 1;
    y1 += (y1 - y0) * 0.05;
    // Distinct point xs (sorted) — the hover snap targets.
    const snapXs = [...new Set(props.series.flatMap((s) => s.points.map((p) => p.x)))].sort(
      (a, b) => a - b,
    );
    return { x0, x1, y0, y1, snapXs };
  }, [props.series, markers, props.yMin]);

  if (layout === null) {
    return (
      <div className="chart" ref={ref}>
        <div className="chart-empty">{props.emptyText ?? "No data points"}</div>
      </div>
    );
  }

  // Round-9 §4: left margin sized to the widest rendered y tick.
  const yTicks = niceTicks(layout.y0, layout.y1, 4);
  const marginLeft = leftMarginFor(
    yTicks.map((t) => yFormat(t)),
    MIN_MARGIN_LEFT,
  );
  const innerW = Math.max(10, width - marginLeft - MARGIN.right);
  const innerH = Math.max(10, height - MARGIN.top - MARGIN.bottom);
  const sx = (x: number) => marginLeft + ((x - layout.x0) / (layout.x1 - layout.x0)) * innerW;
  const sy = (y: number) => MARGIN.top + (1 - (y - layout.y0) / (layout.y1 - layout.y0)) * innerH;

  const xTickCount = Math.max(2, Math.min(6, Math.floor(innerW / 110)));
  const xTicks = Array.from(
    { length: xTickCount },
    (_, i) => layout.x0 + ((layout.x1 - layout.x0) * i) / (xTickCount - 1),
  );

  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    if (layout.snapXs.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const dataX = layout.x0 + ((px - marginLeft) / innerW) * (layout.x1 - layout.x0);
    let nearest = layout.snapXs[0];
    for (const x of layout.snapXs) {
      if (Math.abs(x - dataX) < Math.abs(nearest - dataX)) nearest = x;
    }
    setHover({ x: nearest, px: sx(nearest) });
  };

  const hoverRows =
    hover === null
      ? []
      : props.series.flatMap((s, i) => {
          const point = s.points.find((p) => p.x === hover.x);
          if (!point) return [];
          return [
            {
              key: s.id,
              name: s.name,
              color: seriesColor(i, s.color),
              value: point.y === null ? "—" : yFormat(point.y),
            },
          ];
        });

  // Tooltip flips to the left side of the crosshair near the right edge.
  const tipOnLeft = hover !== null && hover.px > width * 0.62;

  return (
    <div className="chart" ref={ref}>
      {width > 0 ? (
        // biome-ignore lint/a11y/noSvgWithoutTitle: decorative data visualization; values are in the tooltip + legend
        <svg width={width} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {/* grid + y ticks */}
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
                {yFormat(t)}
              </text>
            </g>
          ))}
          {/* x axis + ticks */}
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
              y={MARGIN.top + innerH + 14}
              textAnchor="middle"
            >
              {xFormat(t)}
            </text>
          ))}
          {/* version / event markers */}
          {markers.map((m, i) => {
            const px = sx(m.x);
            const color = m.color ?? "var(--dim)";
            // Round-9 §4.6: flip the anchor when the start-anchored label
            // would run past the right svg edge (estimated glyph width).
            const onRight = px + 4 + m.label.length * MARKER_CHAR_W > width - 2;
            return (
              <g key={`m${m.x}-${m.label}`}>
                <line
                  className="chart-marker-line"
                  stroke={color}
                  x1={px}
                  x2={px}
                  y1={MARGIN.top - 2}
                  y2={MARGIN.top + innerH}
                />
                <text
                  className="chart-marker-label"
                  fill={color}
                  x={onRight ? px - 4 : px + 4}
                  y={10 + (i % 2) * 9}
                  textAnchor={onRight ? "end" : "start"}
                >
                  {m.label}
                </text>
              </g>
            );
          })}
          {/* series lines + dots */}
          {props.series.map((s, i) => {
            const color = seriesColor(i, s.color);
            const sorted = [...s.points].sort((a, b) => a.x - b.x);
            const segments: LinePoint[][] = [];
            let current: LinePoint[] = [];
            for (const p of sorted) {
              if (p.y === null) {
                if (current.length > 0) segments.push(current);
                current = [];
              } else {
                current.push(p);
              }
            }
            if (current.length > 0) segments.push(current);
            return (
              <g key={s.id}>
                {segments.map((seg) => (
                  <polyline
                    key={`${s.id}-${seg[0].x}`}
                    fill="none"
                    stroke={color}
                    strokeWidth={1.6}
                    points={seg.map((p) => `${sx(p.x)},${sy(p.y as number)}`).join(" ")}
                  />
                ))}
                {sorted
                  .filter((p) => p.y !== null)
                  .map((p) => (
                    <circle
                      key={`${s.id}-${p.x}-dot`}
                      cx={sx(p.x)}
                      cy={sy(p.y as number)}
                      r={hover?.x === p.x ? 4 : 2.5}
                      fill={color}
                    />
                  ))}
              </g>
            );
          })}
          {/* crosshair */}
          {hover !== null ? (
            <line
              className="chart-crosshair"
              x1={hover.px}
              x2={hover.px}
              y1={MARGIN.top}
              y2={MARGIN.top + innerH}
            />
          ) : null}
        </svg>
      ) : null}
      {hover !== null && hoverRows.length > 0 ? (
        <div
          className="chart-tip"
          style={
            tipOnLeft
              ? { right: width - hover.px + 10, top: MARGIN.top }
              : { left: hover.px + 10, top: MARGIN.top }
          }
        >
          <div className="chart-tip-title">{xFormat(hover.x)}</div>
          {hoverRows.map((row) => (
            <div className="chart-tip-row" key={row.key}>
              <span className="chart-dot" style={{ background: row.color }} />
              <span>{row.name}</span>
              <span className="chart-tip-value">{row.value}</span>
            </div>
          ))}
        </div>
      ) : null}
      {props.series.length > 1 ? (
        <div className="chart-legend">
          {props.series.map((s, i) => (
            <span className="chart-legend-item" key={s.id}>
              <span className="chart-dot" style={{ background: seriesColor(i, s.color) }} />
              {s.name}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
