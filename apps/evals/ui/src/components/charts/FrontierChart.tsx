import { type ReactNode, useMemo, useState } from "react";
import {
  type DotShape,
  type FrontierDot,
  logTicks,
  scoreDomain,
} from "../../lib/suite-analytics.ts";
import { leftMarginFor, niceTicks, useContainerWidth } from "./chart-utils.ts";
import "./charts.css";

/**
 * Pareto scatter for the Leaderboard: x = cost or agent time on a log axis
 * (lower is better), y = score with a 95% CI whisker (higher is better). Colour
 * is the caller's (harness), the shape is the reasoning effort, a hollow marker
 * is a point the frontier does not trust (partial coverage or too few attempts),
 * and the dashed line joins the non-dominated points.
 *
 * The dot data is prepared by `buildFrontierDots` (lib/suite-analytics.ts); this
 * component only draws and hit-tests.
 */
export interface FrontierChartProps {
  dots: FrontierDot[];
  /** Dots on the frontier, left to right. Empty draws no line. */
  line: FrontierDot[];
  colorOf: (dot: FrontierDot) => string;
  xLabel: string;
  xFormat: (v: number) => string;
  /** Tick positions inside [lo, hi]; default is 1/2/5 per decade. */
  xTicks?: (lo: number, hi: number) => number[];
  renderTip: (dot: FrontierDot) => ReactNode;
  onSelect?: (dot: FrontierDot) => void;
  emptyText?: string;
  height?: number;
}

const MARGIN = { top: 16, right: 22, bottom: 40 };
const MIN_MARGIN_LEFT = 44;
const DEFAULT_HEIGHT = 360;
const DOT_R = 6;
const HIT_RADIUS = 20;
const LABEL_H = 12;
/** Up to this many dots every one is labelled; past it only the frontier, the best score and the hovered one. */
const LABEL_ALL_MAX = 12;

interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Placed {
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
}

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function boxOf(at: Placed, w: number): LabelBox {
  const x = at.anchor === "start" ? at.x : at.anchor === "end" ? at.x - w : at.x - w / 2;
  return { x, y: at.y - 9, w, h: LABEL_H };
}

/**
 * Marker path/element for a shape centred on (cx, cy). Fill and stroke come from
 * CSS (`.frontier-dot`) off the `--dot-color` custom property, so the hollow,
 * frontier and hover states are plain classes.
 */
export function Marker(props: {
  shape: DotShape;
  cx: number;
  cy: number;
  r: number;
  className: string;
  color: string;
}): ReactNode {
  const { shape, cx, cy, r } = props;
  const common = {
    className: props.className,
    style: { "--dot-color": props.color } as React.CSSProperties,
  };
  switch (shape) {
    case "triangle":
      return (
        <path
          {...common}
          d={`M${cx} ${cy - r * 1.2}L${cx + r * 1.1} ${cy + r * 0.85}L${cx - r * 1.1} ${cy + r * 0.85}Z`}
        />
      );
    case "square":
      return (
        <rect {...common} x={cx - r * 0.9} y={cy - r * 0.9} width={r * 1.8} height={r * 1.8} />
      );
    case "diamond":
      return (
        <path
          {...common}
          d={`M${cx} ${cy - r * 1.25}L${cx + r * 1.25} ${cy}L${cx} ${cy + r * 1.25}L${cx - r * 1.25} ${cy}Z`}
        />
      );
    default:
      return <circle {...common} cx={cx} cy={cy} r={r} />;
  }
}

export function FrontierChart(props: FrontierChartProps): ReactNode {
  const [ref, width] = useContainerWidth();
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const height = props.height ?? DEFAULT_HEIGHT;
  const { dots, line } = props;

  const layout = useMemo(() => {
    if (dots.length === 0) return null;
    const xs = dots.map((d) => d.x);
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    // Log axis: pad by a factor so the outer dots (and their labels) stay inside.
    const pad = hi / lo > 1.5 ? 1.35 : 1.6;
    const x0 = lo / pad;
    const x1 = hi * pad;
    const ticks = (props.xTicks ?? logTicks)(x0, x1);
    return { x0, x1, ticks, dom: scoreDomain(dots) };
  }, [dots, props.xTicks]);

  if (layout === null) {
    return <div className="chart-empty">{props.emptyText ?? "No points to plot"}</div>;
  }

  const { x0, x1, ticks, dom } = layout;
  const yTicks = niceTicks(dom.lo, dom.hi, 5);
  const yTickLabels = yTicks.map((t) => t.toFixed(2));
  const marginLeft = leftMarginFor(yTickLabels, MIN_MARGIN_LEFT);
  const innerW = Math.max(60, width - marginLeft - MARGIN.right);
  const innerH = Math.max(60, height - MARGIN.top - MARGIN.bottom);
  const sx = (v: number) =>
    marginLeft + ((Math.log(v) - Math.log(x0)) / (Math.log(x1) - Math.log(x0))) * innerW;
  const sy = (v: number) => MARGIN.top + innerH - ((v - dom.lo) / (dom.hi - dom.lo)) * innerH;

  // Label the frontier, the best score and the hovered dot; skip a label that
  // would sit on another label or dot.
  const top = dots.reduce((best, d) => (d.y > best.y ? d : best), dots[0] as FrontierDot);
  const labelled = new Set<string>(
    dots.length <= LABEL_ALL_MAX
      ? dots.map((d) => d.configId)
      : [top.configId, ...line.map((d) => d.configId)],
  );
  if (hoverKey !== null) labelled.add(hoverKey);
  // A label may not sit on another label, a dot, a whisker or the frontier line.
  const obstacles: LabelBox[] = [];
  for (const d of dots) {
    if (d.ciLo !== null && d.ciHi !== null) {
      obstacles.push({ x: sx(d.x) - 4, y: sy(d.ciHi), w: 8, h: sy(d.ciLo) - sy(d.ciHi) });
    }
  }
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1] as FrontierDot;
    const b = line[i] as FrontierDot;
    for (let t = 0; t <= 1; t += 1 / 24) {
      obstacles.push({
        x: sx(a.x) + (sx(b.x) - sx(a.x)) * t - 1.5,
        y: sy(a.y) + (sy(b.y) - sy(a.y)) * t - 1.5,
        w: 3,
        h: 3,
      });
    }
  }
  const taken: LabelBox[] = [];
  const placements = new Map<string, Placed>();
  const order = [...dots]
    .filter((d) => labelled.has(d.configId))
    .sort((a, b) => Number(b.onFrontier) - Number(a.onFrontier) || b.y - a.y);
  for (const d of order) {
    const w = d.configId.length * 6.2 + 4;
    const cx = sx(d.x);
    const cy = sy(d.y);
    const R = DOT_R + 6;
    const candidates: Placed[] = [
      { x: cx + R, y: cy + 4, anchor: "start" },
      { x: cx - R, y: cy + 4, anchor: "end" },
      { x: cx + R, y: cy + R + 6, anchor: "start" },
      { x: cx + R, y: cy - R + 2, anchor: "start" },
      { x: cx - R, y: cy + R + 6, anchor: "end" },
      { x: cx - R, y: cy - R + 2, anchor: "end" },
      { x: cx, y: cy - R - 4, anchor: "middle" },
      { x: cx, y: cy + R + 14, anchor: "middle" },
    ];
    const inBounds = (b: LabelBox) =>
      b.x >= 2 && b.x + b.w <= width - 2 && b.y >= 0 && b.y + b.h <= height;
    const clear = (b: LabelBox) =>
      !taken.some((t) => overlaps(b, t)) &&
      !obstacles.some((o) => overlaps(b, o)) &&
      !dots.some((o) => {
        const ox = sx(o.x);
        const oy = sy(o.y);
        return (
          ox > b.x - DOT_R && ox < b.x + b.w + DOT_R && oy > b.y - DOT_R && oy < b.y + b.h + DOT_R
        );
      });
    const chosen =
      candidates.find((c) => inBounds(boxOf(c, w)) && clear(boxOf(c, w))) ??
      // nothing is clear: keep the label (it names the dot) on the least bad side
      candidates.find((c) => inBounds(boxOf(c, w)) && !taken.some((t) => overlaps(boxOf(c, w), t)));
    if (chosen) {
      placements.set(d.configId, chosen);
      taken.push(boxOf(chosen, w));
    }
  }

  const hovered = hoverKey === null ? null : (dots.find((d) => d.configId === hoverKey) ?? null);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best: { key: string; d: number } | null = null;
    for (const d of dots) {
      const dist = Math.hypot(sx(d.x) - mx, sy(d.y) - my);
      if (dist <= HIT_RADIUS && (best === null || dist < best.d))
        best = { key: d.configId, d: dist };
    }
    setHoverKey(best?.key ?? null);
  };

  const onClick = () => {
    if (hovered !== null) props.onSelect?.(hovered);
  };

  const linePath =
    line.length > 1
      ? line.map((d, i) => `${i === 0 ? "M" : "L"}${sx(d.x)} ${sy(d.y)}`).join("")
      : null;

  // Draw faded dots first so a bright dot is never hidden behind one.
  const drawOrder = [...dots].sort(
    (a, b) => Number(b.dim) - Number(a.dim) || Number(a.onFrontier) - Number(b.onFrontier),
  );

  return (
    <div className="chart" ref={ref}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: pointer hit-test on a chart; the ranking table and pick cards are the keyboard path to the same runs */}
      <svg
        width={width}
        height={height}
        role="img"
        aria-label="Score against cost or agent time, one marker per config"
        onMouseMove={onMove}
        onMouseLeave={() => setHoverKey(null)}
        onClick={onClick}
        style={{ cursor: hovered !== null && props.onSelect ? "pointer" : undefined }}
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
              {t.toFixed(2)}
            </text>
          </g>
        ))}
        {ticks.map((t) => (
          <g key={`x${t}`}>
            <line
              className="chart-grid-line frontier-grid-x"
              x1={sx(t)}
              x2={sx(t)}
              y1={MARGIN.top}
              y2={MARGIN.top + innerH}
            />
            <text className="chart-tick" x={sx(t)} y={MARGIN.top + innerH + 14} textAnchor="middle">
              {props.xFormat(t)}
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
        <text
          className="chart-axis-label"
          x={marginLeft + innerW / 2}
          y={height - 6}
          textAnchor="middle"
        >
          {props.xLabel}
        </text>
        <text
          className="chart-axis-label"
          transform={`translate(11 ${MARGIN.top + innerH / 2}) rotate(-90)`}
          textAnchor="middle"
        >
          score (higher is better)
        </text>
        {linePath !== null ? <path className="frontier-line" d={linePath} /> : null}
        {drawOrder.map((d) => {
          const cx = sx(d.x);
          const cy = sy(d.y);
          const color = props.colorOf(d);
          const cls = [
            "frontier-dot",
            d.hollow ? "hollow" : "",
            d.onFrontier ? "on-frontier" : "",
            d.dim ? "dim" : "",
            d.configId === hoverKey ? "hover" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <g key={d.configId} className={d.dim ? "frontier-group dim" : "frontier-group"}>
              {d.ciLo !== null && d.ciHi !== null ? (
                <g className="frontier-whisker" stroke={color}>
                  <line x1={cx} x2={cx} y1={sy(d.ciLo)} y2={sy(d.ciHi)} />
                  <line x1={cx - 4} x2={cx + 4} y1={sy(d.ciLo)} y2={sy(d.ciLo)} />
                  <line x1={cx - 4} x2={cx + 4} y1={sy(d.ciHi)} y2={sy(d.ciHi)} />
                </g>
              ) : null}
              <Marker shape={d.shape} cx={cx} cy={cy} r={DOT_R} className={cls} color={color} />
              {placements.has(d.configId) ? (
                <text
                  className="chart-scatter-label"
                  x={placements.get(d.configId)?.x}
                  y={placements.get(d.configId)?.y}
                  textAnchor={placements.get(d.configId)?.anchor}
                >
                  {d.configId}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {hovered !== null
        ? (() => {
            const px = sx(hovered.x);
            const top = Math.max(4, sy(hovered.y) - 14);
            return (
              <div
                className="chart-tip frontier-tip"
                style={px > width * 0.6 ? { right: width - px + 12, top } : { left: px + 12, top }}
              >
                {props.renderTip(hovered)}
              </div>
            );
          })()
        : null}
    </div>
  );
}
