/**
 * A vertical drag handle for a pane's edge: pointer drag, arrow keys (Shift
 * for big steps), Home / End for the min / max width, and double-click to reset. It
 * reports widths only; the owner clamps, stores and applies them.
 *
 * `edge: "start"` sits on the pane's left edge, so dragging left widens it.
 */

import { useRef } from "react";
import { cn } from "@/lib/utils";

const STEP = 16;
const BIG_STEP = 64;

export function clampWidth(width: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(width, min), Math.max(min, max)));
}

export interface ResizeHandleProps {
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  /** Double-click target. */
  onReset: () => void;
  /** Called once a drag ends, with the final width. */
  onCommit?: (width: number) => void;
  label?: string;
  className?: string;
}

export function ResizeHandle({
  width,
  min,
  max,
  onResize,
  onReset,
  onCommit,
  label = "Resize pane",
  className,
}: ResizeHandleProps) {
  const drag = useRef<{ startX: number; startWidth: number; last: number } | null>(null);

  const setWidth = (next: number) => {
    const clamped = clampWidth(next, min, max);
    onResize(clamped);
    return clamped;
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: an interactive splitter is role="separator" with focus, which <hr> cannot carry.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-testid="resize-handle"
      className={cn(
        "group relative w-1.5 shrink-0 cursor-col-resize touch-none select-none outline-none",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border",
        "hover:after:w-0.5 hover:after:bg-primary/60 focus-visible:after:w-0.5 focus-visible:after:bg-primary",
        className,
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drag.current = { startX: event.clientX, startWidth: width, last: width };
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current) return;
        current.last = setWidth(current.startWidth + (current.startX - event.clientX));
      }}
      onPointerUp={(event) => {
        const current = drag.current;
        drag.current = null;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        if (current) onCommit?.(current.last);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const step = event.shiftKey ? BIG_STEP : STEP;
        let next: number | null = null;
        if (event.key === "ArrowLeft") next = width + step;
        else if (event.key === "ArrowRight") next = width - step;
        else if (event.key === "Home") next = min;
        else if (event.key === "End") next = max;
        else if (event.key === "Enter") {
          event.preventDefault();
          onReset();
          return;
        }
        if (next === null) return;
        event.preventDefault();
        onCommit?.(setWidth(next));
      }}
    />
  );
}
