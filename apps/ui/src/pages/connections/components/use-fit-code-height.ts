import { useLayoutEffect, useRef, useState } from "react";

// Code viewers sized to content (capped) instead of fixed 360px boxes
// Estimates the rendered height of a read-only, word-wrapped Monaco viewer
// (fontSize 12) from the source and the measured container width, so short
// blocks (3-line GraphQL / SQL types) do not sit in a 360px empty panel.
const LINE_HEIGHT = 18;
const CHAR_WIDTH = 7.25;
const GUTTER = 64; // line numbers + decorations
const SCROLLBAR = 14;
const CHROME = 16 + 2; // Monaco top/bottom padding + border

export function useFitCodeHeight(source: string, max = 360) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const cols = width ? Math.max(16, Math.floor((width - GUTTER - SCROLLBAR) / CHAR_WIDTH)) : 120;
  const visualLines = source
    .split("\n")
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / cols)), 0);
  const height = Math.min(max, visualLines * LINE_HEIGHT + CHROME);
  return { ref, height: `${height}px` };
}
