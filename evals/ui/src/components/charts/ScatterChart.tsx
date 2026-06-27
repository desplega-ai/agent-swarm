import { type ReactNode, useMemo, useState } from "react";
import { fmtCompact, leftMarginFor, niceTicks, useContainerWidth } from "./chart-utils.ts";
import "./charts.css";

/**
 * One dot of the scatter (v7 spec §C2 — FROZEN props). Callers resolve colors
 * (colorForGroup + HARNESS_COLORS/VENDOR_COLORS) and pre-filter null axes —
 * a point missing either coordinate is simply not passed in.
 */
export interface ScatterPoint {
  /** Stable id (model key / config id). */
  key: string;
  /** Hover title + optional inline dot label. */
  label: string;
  x: number;
  y: number;
  /** Resolved CSS color; default = var(--accent). */
  color?: string;
  /** Legend group ("claude", "anthropic", …); legend shows distinct groups. */
  group?: string;
  /** Dot radius in px (caller may scale by attempts). Default 5. */
  r?: number;
  /** Rich hover card; default = label + formatted x/y rows. */
  tip?: ReactNode;
}

/**
 * Shaded "most attractive" corner band (à la artificialanalysis.ai).
 * Round-9 §2 (FROZEN — props unchanged from the v7/round-8 shape): the bands
 * anchor to the RENDERED axis ranges — each is a corner rect of exactly
 * 25% × 25% of the inner plot in screen space, independent of the point
 * distribution (the round-8 median split is gone). `x`/`y` pick the best
 * corner: x "low" → left edge, "high" → right; y "high" → top, "low" → bottom.
 */
export interface ScatterQuadrant {
  x: "low" | "high";
  y: "low" | "high";
  /** Corner caption. Default "most attractive quadrant". */
  label?: string;
  /** Also shade the diagonally-opposite 25%×25% corner red. */
  worst?: boolean;
  /** Corner caption for the worst band. Default "least attractive". */
  worstLabel?: string;
}

const MARGIN = { top: 14, right: 16, bottom: 34 };
const MIN_MARGIN_LEFT = 52;
const DEFAULT_HEIGHT = 280;
/** Round-9 §2 (FROZEN): bands span 25% of each rendered axis range. */
const BAND_FRACTION = 0.25;
const DEFAULT_BEST_LABEL = "most attractive quadrant";
const DEFAULT_WORST_LABEL = "least attractive";

function flipSide(side: "low" | "high"): "low" | "high" {
  return side === "low" ? "high" : "low";
}

interface BandRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Corner-anchored 25%×25% band rect in screen space, derived from the SAME
 * post-padding domains that drive sx/sy — so the band is independent of the
 * point distribution (round-9 §2 — FROZEN geometry).
 */
function bandRect(
  qx: "low" | "high",
  qy: "low" | "high",
  left: number,
  top: number,
  innerW: number,
  innerH: number,
): BandRect {
  const w = innerW * BAND_FRACTION;
  const h = innerH * BAND_FRACTION;
  return {
    x: qx === "low" ? left : left + innerW - w,
    y: qy === "high" ? top : top + innerH - h,
    w,
    h,
  };
}

/**
 * Caption anchored in the band's outer corner (the chart-boundary corner),
 * extending INWARD: anchor start on left bands / end on right bands. A long
 * caption may extend past a narrow band into the plot — never past the svg
 * edge (round-9 §2/§4.8).
 */
function bandCaption(
  rect: BandRect,
  qx: "low" | "high",
  qy: "low" | "high",
): { x: number; y: number; anchor: "start" | "end" } {
  return {
    x: qx === "low" ? rect.x + 6 : rect.x + rect.w - 6,
    y: qy === "high" ? rect.y + 12 : rect.y + rect.h - 5,
    anchor: qx === "low" ? "start" : "end",
  };
}

interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PlacedLabel {
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
}

const LABEL_H = 12;

function labelBox(at: PlacedLabel, w: number): LabelBox {
  const x = at.anchor === "start" ? at.x : at.anchor === "end" ? at.x - w : at.x - w / 2;
  return { x, y: at.y - 9, w, h: LABEL_H };
}

function boxesIntersect(a: LabelBox, b: LabelBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function boxHitsCircle(box: LabelBox, cx: number, cy: number, r: number): boolean {
  const nx = Math.max(box.x, Math.min(cx, box.x + box.w));
  const ny = Math.max(box.y, Math.min(cy, box.y + box.h));
  return Math.hypot(cx - nx, cy - ny) < r;
}

/**
 * Estimated boxes of the band captions (same w = chars*6.2+4, h = 12
 * estimator as point labels) — seeded into placeLabels' `taken` list so the
 * captions are collision-safe (round-9 §2 — FROZEN).
 */
function captionBoxes(
  quadrant: ScatterQuadrant,
  left: number,
  top: number,
  innerW: number,
  innerH: number,
): LabelBox[] {
  const make = (qx: "low" | "high", qy: "low" | "high", text: string): LabelBox =>
    labelBox(
      bandCaption(bandRect(qx, qy, left, top, innerW, innerH), qx, qy),
      text.length * 6.2 + 4,
    );
  const boxes = [make(quadrant.x, quadrant.y, quadrant.label ?? DEFAULT_BEST_LABEL)];
  if (quadrant.worst === true) {
    boxes.push(
      make(flipSide(quadrant.x), flipSide(quadrant.y), quadrant.worstLabel ?? DEFAULT_WORST_LABEL),
    );
  }
  return boxes;
}

/**
 * Greedy collision-aware label placement (round-8 spec §C1 — FROZEN): points
 * are processed by radius desc (≈ attempts desc, important labels win) with
 * candidate anchors right → left → above → below of the dot. A candidate is
 * rejected when its estimated box (w = chars*6.2+4, h = 12) intersects an
 * already-placed label box, any dot circle, or leaves the inner chart bounds.
 * When all four candidates fail, the label is hidden — the dot keeps the
 * nearest-point hover tooltip as recourse. Round-9 §2: the `taken` list is
 * pre-seeded with the band caption boxes so captions stay readable.
 */
function placeLabels(
  dots: { key: string; label: string; cx: number; cy: number; r: number }[],
  bounds: LabelBox,
  reserved: LabelBox[],
): Map<string, PlacedLabel> {
  const placed = new Map<string, PlacedLabel>();
  const taken: LabelBox[] = [...reserved];
  const order = [...dots].sort((a, b) => b.r - a.r);
  for (const d of order) {
    const w = d.label.length * 6.2 + 4;
    const candidates: PlacedLabel[] = [
      { x: d.cx + d.r + 3, y: d.cy + 3, anchor: "start" },
      { x: d.cx - d.r - 3, y: d.cy + 3, anchor: "end" },
      { x: d.cx, y: d.cy - d.r - 4, anchor: "middle" },
      { x: d.cx, y: d.cy + d.r + 11, anchor: "middle" },
    ];
    for (const at of candidates) {
      const box = labelBox(at, w);
      const inBounds =
        box.x >= bounds.x &&
        box.y >= bounds.y &&
        box.x + box.w <= bounds.x + bounds.w &&
        box.y + box.h <= bounds.y + bounds.h;
      if (!inBounds) continue;
      if (taken.some((t) => boxesIntersect(t, box))) continue;
      if (dots.some((o) => boxHitsCircle(box, o.cx, o.cy, o.r))) continue;
      placed.set(d.key, at);
      taken.push(box);
      break;
    }
  }
  return placed;
}

/**
 * XY scatter chart (v7 spec §C2 — FROZEN props; round-8 §C1/§C4 additive
 * extensions: worst band, yDomain, collision-aware labels). Hand-rolled
 * theme-aware SVG, no deps: axis-range-anchored 25% corner bands (round-9 §2),
 * per-group legend, nearest-point hover tooltip, optional inline dot labels
 * for small datasets.
 */
export function ScatterChart(props: {
  points: ScatterPoint[];
  height?: number;
  xLabel?: string;
  yLabel?: string;
  xFormat?: (v: number) => string;
  yFormat?: (v: number) => string;
  quadrant?: ScatterQuadrant | null;
  /** Inline labels next to dots — readable up to ~20 points. */
  showLabels?: boolean;
  /**
   * Y-axis domain (round-8 spec §C4): "zero" (default) anchors the domain at
   * 0 — bit-for-bit the legacy behavior; "fit" spans [min,max] of the plotted
   * ys with 8% padding so tightly clustered values (e.g. scores near 1.0)
   * spread over the full plot height. An explicit `[lo, hi]` tuple pins the
   * domain to a constant range regardless of the data — used to lock 0–1
   * metrics (score / pass rate) so the quadrant bands stay anchored to the
   * true scale instead of the plotted range.
   */
  yDomain?: "zero" | "fit" | [number, number];
  emptyText?: string;
}): ReactNode {
  const [ref, width] = useContainerWidth();
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const height = props.height ?? DEFAULT_HEIGHT;
  const xFormat = props.xFormat ?? fmtCompact;
  const yFormat = props.yFormat ?? fmtCompact;
  const yDomain = props.yDomain ?? "zero";

  const layout = useMemo(() => {
    const pts = props.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (pts.length === 0) return null;
    const pad = (lo: number, hi: number): [number, number] => {
      if (lo === hi) return [lo - (Math.abs(lo) || 1) * 0.2, hi + (Math.abs(hi) || 1) * 0.2];
      const d = (hi - lo) * 0.08;
      return [lo - d, hi + d];
    };
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const [x0, x1] = pad(Math.min(...xs), Math.max(...xs));
    let y0: number;
    let y1: number;
    if (Array.isArray(yDomain)) {
      // Constant domain: pin to the given [lo, hi] regardless of the data so
      // the quadrant bands anchor to the true scale (e.g. 0–1 score/pass-rate).
      [y0, y1] = yDomain;
    } else if (yDomain === "fit") {
      [y0, y1] = pad(Math.min(...ys), Math.max(...ys));
    } else {
      const [y0raw, y1pad] = pad(Math.min(0, ...ys), Math.max(...ys));
      y0 = Math.min(0, y0raw);
      y1 = y1pad;
    }
    return { pts, x0, x1, y0, y1 };
  }, [props.points, yDomain]);

  // Round-9 §4: left margin sized to the widest rendered y tick — strings
  // like "$0.0350" / "1h 05m" used to clip past the fixed 52px margin.
  const marginLeft =
    layout === null
      ? MIN_MARGIN_LEFT
      : leftMarginFor(
          niceTicks(layout.y0, layout.y1).map((t) => yFormat(t)),
          MIN_MARGIN_LEFT,
        );

  const labelPlacements = useMemo(() => {
    if (props.showLabels !== true || layout === null || width === 0) return null;
    const { pts, x0, x1, y0, y1 } = layout;
    const innerW = Math.max(40, width - marginLeft - MARGIN.right);
    const innerH = Math.max(40, height - MARGIN.top - MARGIN.bottom);
    const sx = (v: number) => marginLeft + ((v - x0) / (x1 - x0)) * innerW;
    const sy = (v: number) => MARGIN.top + innerH - ((v - y0) / (y1 - y0)) * innerH;
    const quadrant = props.quadrant ?? null;
    const reserved =
      quadrant === null ? [] : captionBoxes(quadrant, marginLeft, MARGIN.top, innerW, innerH);
    return placeLabels(
      pts.map((p) => ({ key: p.key, label: p.label, cx: sx(p.x), cy: sy(p.y), r: p.r ?? 5 })),
      { x: marginLeft, y: MARGIN.top, w: innerW, h: innerH },
      reserved,
    );
  }, [props.showLabels, props.quadrant, layout, width, height, marginLeft]);

  if (width === 0 || layout === null) {
    return (
      <div className="chart" ref={ref}>
        <div className="chart-empty">{props.emptyText ?? "No data"}</div>
      </div>
    );
  }

  const { pts, x0, x1, y0, y1 } = layout;
  const innerW = Math.max(40, width - marginLeft - MARGIN.right);
  const innerH = Math.max(40, height - MARGIN.top - MARGIN.bottom);
  const sx = (v: number) => marginLeft + ((v - x0) / (x1 - x0)) * innerW;
  const sy = (v: number) => MARGIN.top + innerH - ((v - y0) / (y1 - y0)) * innerH;

  const quadrant = props.quadrant ?? null;
  const bands =
    quadrant === null
      ? []
      : [
          {
            cls: "chart-quadrant",
            capCls: "chart-quadrant-label",
            qx: quadrant.x,
            qy: quadrant.y,
            text: quadrant.label ?? DEFAULT_BEST_LABEL,
          },
          ...(quadrant.worst === true
            ? [
                {
                  cls: "chart-quadrant worst",
                  capCls: "chart-quadrant-label worst",
                  qx: flipSide(quadrant.x),
                  qy: flipSide(quadrant.y),
                  text: quadrant.worstLabel ?? DEFAULT_WORST_LABEL,
                },
              ]
            : []),
        ];

  const groups: { name: string; color: string }[] = [];
  for (const p of pts) {
    if (p.group && !groups.some((g) => g.name === p.group)) {
      groups.push({ name: p.group, color: p.color ?? "var(--accent)" });
    }
  }

  const hovered = hoverKey === null ? null : (pts.find((p) => p.key === hoverKey) ?? null);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best: { key: string; d: number } | null = null;
    for (const p of pts) {
      const d = Math.hypot(sx(p.x) - mx, sy(p.y) - my);
      if (d <= 18 && (best === null || d < best.d)) best = { key: p.key, d };
    }
    setHoverKey(best?.key ?? null);
  };

  return (
    <div className="chart" ref={ref}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label="scatter chart"
        onMouseMove={onMove}
        onMouseLeave={() => setHoverKey(null)}
      >
        {bands.map((b) => {
          const rect = bandRect(b.qx, b.qy, marginLeft, MARGIN.top, innerW, innerH);
          const cap = bandCaption(rect, b.qx, b.qy);
          return (
            <g key={b.cls}>
              <rect className={b.cls} x={rect.x} y={rect.y} width={rect.w} height={rect.h} />
              <text className={b.capCls} x={cap.x} y={cap.y} textAnchor={cap.anchor}>
                {b.text}
              </text>
            </g>
          );
        })}
        {niceTicks(y0, y1).map((t) => (
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
        {niceTicks(x0, x1, 6).map((t) => (
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
        <line
          className="chart-axis-line"
          x1={marginLeft}
          x2={marginLeft + innerW}
          y1={MARGIN.top + innerH}
          y2={MARGIN.top + innerH}
        />
        {props.xLabel ? (
          <text
            className="chart-axis-label"
            x={marginLeft + innerW / 2}
            y={height - 4}
            textAnchor="middle"
          >
            {props.xLabel}
          </text>
        ) : null}
        {props.yLabel ? (
          <text
            className="chart-axis-label"
            transform={`translate(10 ${MARGIN.top + innerH / 2}) rotate(-90)`}
            textAnchor="middle"
          >
            {props.yLabel}
          </text>
        ) : null}
        {pts.map((p) => {
          const at = labelPlacements?.get(p.key) ?? null;
          return (
            <g key={p.key}>
              <circle
                className={p.key === hoverKey ? "chart-scatter-dot hover" : "chart-scatter-dot"}
                cx={sx(p.x)}
                cy={sy(p.y)}
                r={p.r ?? 5}
                fill={p.color ?? "var(--accent)"}
              />
              {at !== null ? (
                <text className="chart-scatter-label" x={at.x} y={at.y} textAnchor={at.anchor}>
                  {p.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {groups.length > 1 ? (
        <div className="chart-legend">
          {groups.map((g) => (
            <span className="chart-legend-item" key={g.name}>
              <span className="chart-dot" style={{ background: g.color }} />
              {g.name}
            </span>
          ))}
        </div>
      ) : null}
      {hovered !== null
        ? (() => {
            const px = sx(hovered.x);
            const top = Math.max(4, sy(hovered.y) - 14);
            return (
              <div
                className="chart-tip"
                // Round-9 §4: flip to the dot's left near the right edge
                // instead of clamping against a hardcoded tip width.
                style={px > width * 0.62 ? { right: width - px + 10, top } : { left: px + 10, top }}
              >
                {hovered.tip ?? (
                  <>
                    <div className="chart-tip-title">{hovered.label}</div>
                    <div className="chart-tip-row">
                      <span>{props.xLabel ?? "x"}</span>
                      <span className="chart-tip-value">{xFormat(hovered.x)}</span>
                    </div>
                    <div className="chart-tip-row">
                      <span>{props.yLabel ?? "y"}</span>
                      <span className="chart-tip-value">{yFormat(hovered.y)}</span>
                    </div>
                  </>
                )}
              </div>
            );
          })()
        : null}
    </div>
  );
}
