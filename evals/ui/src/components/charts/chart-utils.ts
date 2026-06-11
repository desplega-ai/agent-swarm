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
