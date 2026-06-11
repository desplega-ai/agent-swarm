import type { ReactNode } from "react";
import { useNow } from "../hooks.ts";
import { fmtDuration } from "./format.ts";

export const SPINNER_FRAMES: string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Braille-frame spinner, 80ms per frame; static ◌ under prefers-reduced-motion. */
export function Spinner(props: { label?: string }): ReactNode {
  const reduced = prefersReducedMotion();
  const now = useNow(reduced ? 60_000 : 80);
  const frame = reduced ? "◌" : SPINNER_FRAMES[Math.floor(now / 80) % SPINNER_FRAMES.length];
  return (
    <span className="spinner">
      <span className="spinner-frame">{frame}</span>
      {props.label ? <span className="spinner-label">{props.label}</span> : null}
    </span>
  );
}

/** 8px accent dot, CSS opacity pulse (disabled under prefers-reduced-motion). */
export function PulseDot(): ReactNode {
  return <span className="pulse-dot pulse" />;
}

/** Live-ticking "3m 12s" — ticks independently of polling. */
export function Elapsed(props: { since: string | null }): ReactNode {
  const now = useNow(1000);
  if (!props.since) return <span className="elapsed">—</span>;
  const t = new Date(props.since).getTime();
  if (Number.isNaN(t)) return <span className="elapsed">—</span>;
  return <span className="elapsed">{fmtDuration(Math.max(0, now - t))}</span>;
}
