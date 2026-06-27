/**
 * Shared internals for the hand-rolled SVG charts (v5 spec §2).
 * Theme-aware: colors are CSS variables resolved by the browser.
 */
import { type RefObject, useLayoutEffect, useRef, useState } from "react";

/** Default series palette (frozen order — v5 spec §2). */
export const CHART_PALETTE = [
  "var(--accent)",
  "var(--blue)",
  "var(--green)",
  "var(--orange)",
  "var(--red)",
  "var(--yellow)",
];

export function seriesColor(index: number, override?: string): string {
  return override ?? CHART_PALETTE[index % CHART_PALETTE.length];
}

/**
 * Fixed group colors for the color-by toggles (v7 spec §C1 — FROZEN).
 * Harness providers and the well-known model vendors get stable hues; every
 * other group hashes deterministically into CHART_PALETTE via colorForGroup.
 */
export const HARNESS_COLORS: Record<string, string> = {
  claude: "var(--orange)",
  pi: "var(--blue)",
  opencode: "var(--green)",
  codex: "var(--accent)",
};

export const VENDOR_COLORS: Record<string, string> = {
  anthropic: "var(--orange)",
  openai: "var(--accent)",
  google: "var(--blue)",
  deepseek: "var(--red)",
  "z-ai": "var(--yellow)",
  qwen: "var(--green)",
};

/** Deterministic non-crypto string hash (djb2) for palette assignment. */
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return Math.abs(h);
}

/** Stable color for a group label: fixed map first, then palette by hash. */
export function colorForGroup(group: string, fixed?: Record<string, string>): string {
  const hit = fixed?.[group.toLowerCase()];
  if (hit) return hit;
  return CHART_PALETTE[hashString(group.toLowerCase()) % CHART_PALETTE.length];
}

/** Observe the rendered width of the chart container (responsive SVG). */
export function useContainerWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/**
 * Left margin sized to the widest rendered y tick (round-9 §4 clipping audit):
 * estimator chars*6.2px + 14px (6px tick gap + breathing room), floored at
 * `min` so short ticks keep the legacy layout.
 */
export function leftMarginFor(tickLabels: string[], min: number): number {
  const chars = Math.max(0, ...tickLabels.map((t) => t.length));
  return Math.max(min, chars * 6.2 + 14);
}

/** ~n nice tick values spanning [min, max] (1/2/5 steps). */
export function niceTicks(min: number, max: number, n = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const step0 = (max - min) / Math.max(1, n);
  const mag = 10 ** Math.floor(Math.log10(step0));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 1e-6; v += step) out.push(Number(v.toFixed(12)));
  return out;
}

/** Compact default value format: "3.4M" / "1.2k" / "42" / "0.123". */
export function fmtCompact(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(v / 1_000).toFixed(1)}k`;
  if (abs >= 100) return String(Math.round(v));
  if (abs >= 1) return String(Number(v.toFixed(2)));
  return String(Number(v.toFixed(3)));
}
