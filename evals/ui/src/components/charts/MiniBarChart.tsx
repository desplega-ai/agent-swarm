import { type ReactNode, useMemo, useState } from "react";
import { fmtCompact, useContainerWidth } from "./chart-utils.ts";
import "./charts.css";

/**
 * One bar of a highlights mini chart (v7 spec §C3 — FROZEN props; round-9 §5
 * additive: optional attempts count surfaced in the hover card).
 */
export interface MiniBar {
  key: string;
  label: string;
  value: number;
  /** Resolved CSS color; default = var(--accent). */
  color?: string;
  /** Attempts behind the value — hover card adds an "N attempts" row when non-null. */
  attempts?: number | null;
}

// Slanted name-label geometry (round-9 §4 clipping audit). The svg height is
// FIXED at the height prop (item-5 equal cards): label room is carved out of
// innerH from the longest *rendered* label, and each label is truncated to the
// diagonal room its own slot offers, so nothing crosses the svg edges.
const MARGIN_TOP = 16;
const DEFAULT_HEIGHT = 170;
/** Axis → label-anchor gap (the translate offset of the rotated labels). */
const LABEL_OFFSET = 10;
/** 9px mono glyph-width estimate. */
const LABEL_CHAR_W = 5.4;
/** Deepest rotated glyph below its baseline + breathing room. */
const LABEL_DESCENT = 6;
/** Allowed overhang past x=0 for bar 0 — stays inside the card padding. */
const EDGE_GRACE = 8;
const MAX_LABEL_CHARS = 24;
/** Bars never shrink below this — bounds the vertical label budget. */
const MIN_INNER_H = 40;
const SIN35 = Math.sin((35 * Math.PI) / 180);
const COS35 = Math.cos((35 * Math.PI) / 180);

function truncate(label: string, maxChars: number): string {
  return label.length > maxChars ? `${label.slice(0, Math.max(1, maxChars - 1))}…` : label;
}

/**
 * Vertical mini bar chart for the analytics highlights row (à la the
 * artificialanalysis.ai Intelligence/Speed/Price cards): one colored bar per
 * entry, value label on top, slanted name labels underneath, per-bar hover
 * state + tooltip card (round-9 §5). Theme-aware hand-rolled SVG, no deps.
 */
export function MiniBarChart(props: {
  bars: MiniBar[];
  height?: number;
  /** Value-label format; default fmtCompact. */
  format?: (v: number) => string;
  emptyText?: string;
}): ReactNode {
  const [ref, width] = useContainerWidth();
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const height = props.height ?? DEFAULT_HEIGHT;
  const format = props.format ?? fmtCompact;

  const max = useMemo(() => {
    const values = props.bars.map((b) => b.value).filter((v) => Number.isFinite(v));
    return values.length > 0 ? Math.max(...values, 0) : null;
  }, [props.bars]);

  if (width === 0 || max === null || props.bars.length === 0) {
    return (
      <div className="chart" ref={ref}>
        <div className="chart-empty">{props.emptyText ?? "No data"}</div>
      </div>
    );
  }

  const scaleMax = max > 0 ? max : 1;
  const slot = width / props.bars.length;
  const barW = Math.max(6, Math.min(34, slot * 0.62));

  // Round-9 §4.2 — truncation from slot geometry: an end-anchored -35° label
  // extends cos35°×width left of its bar center, and bar i has slot*i + slot/2
  // px of chart (plus EDGE_GRACE) before the left svg edge. The vertical
  // budget keeps bars at least MIN_INNER_H tall at any label length.
  const vertBudget = Math.floor(
    (height - MARGIN_TOP - MIN_INNER_H - LABEL_OFFSET - LABEL_DESCENT) / SIN35 / LABEL_CHAR_W,
  );
  const labels = props.bars.map((b, i) => {
    const slotBudget = Math.floor((slot * i + slot / 2 + EDGE_GRACE) / COS35 / LABEL_CHAR_W);
    return truncate(b.label, Math.max(2, Math.min(MAX_LABEL_CHARS, vertBudget, slotBudget)));
  });
  // Label room comes out of innerH — the svg height stays = the height prop
  // (item-5 structural equal heights).
  const longestPx = Math.max(...labels.map((l) => l.length)) * LABEL_CHAR_W;
  const labelRoom = LABEL_OFFSET + SIN35 * longestPx + LABEL_DESCENT;
  const innerH = Math.max(20, height - MARGIN_TOP - labelRoom);

  const barGeom = (i: number, value: number) => {
    const h = Math.max(1, (Math.max(0, value) / scaleMax) * innerH);
    return { cx: slot * i + slot / 2, y: MARGIN_TOP + innerH - h, h };
  };

  const hoverIdx = hoverKey === null ? -1 : props.bars.findIndex((b) => b.key === hoverKey);
  const hovered = hoverIdx === -1 ? null : (props.bars[hoverIdx] as MiniBar);

  return (
    <div className="chart" ref={ref}>
      <svg width={width} height={height} role="img" aria-label="mini bar chart">
        {props.bars.map((b, i) => {
          const { cx, y, h } = barGeom(i, b.value);
          return (
            <g key={b.key}>
              <title>{`${b.label}: ${format(b.value)}`}</title>
              <rect
                className={b.key === hoverKey ? "chart-minibar hover" : "chart-minibar"}
                x={cx - barW / 2}
                y={y}
                width={barW}
                height={h}
                rx={2}
                fill={b.color ?? "var(--accent)"}
              />
              {/* Round-9 §4.3: value label clamped ≥ 10px from the svg top. */}
              <text
                className="chart-minibar-value"
                x={cx}
                y={Math.max(10, y - 4)}
                textAnchor="middle"
              >
                {format(b.value)}
              </text>
              <text
                className="chart-minibar-label"
                transform={`translate(${cx} ${MARGIN_TOP + innerH + LABEL_OFFSET}) rotate(-35)`}
                textAnchor="end"
              >
                {labels[i]}
              </text>
              {/* biome-ignore lint/a11y/noStaticElementInteractions: passive hover target — values stay reachable via the <title> + on-bar labels */}
              <rect
                className="chart-hover-rect"
                x={slot * i}
                y={MARGIN_TOP}
                width={slot}
                height={innerH}
                onMouseEnter={() => setHoverKey(b.key)}
                onMouseLeave={() => setHoverKey(null)}
              />
            </g>
          );
        })}
        <line
          className="chart-axis-line"
          x1={0}
          x2={width}
          y1={MARGIN_TOP + innerH}
          y2={MARGIN_TOP + innerH}
        />
      </svg>
      {hovered !== null
        ? (() => {
            const { cx, y } = barGeom(hoverIdx, hovered.value);
            const top = Math.max(0, y - 8);
            return (
              <div
                className="chart-tip"
                style={cx > width * 0.62 ? { right: width - cx + 8, top } : { left: cx + 8, top }}
              >
                <div className="chart-tip-title">{hovered.label}</div>
                <div className="chart-tip-row">
                  <span className="chart-tip-value">{format(hovered.value)}</span>
                </div>
                {hovered.attempts != null ? (
                  <div className="chart-tip-row">
                    <span>{hovered.attempts} attempts</span>
                  </div>
                ) : null}
              </div>
            );
          })()
        : null}
    </div>
  );
}
