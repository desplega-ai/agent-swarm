/**
 * The drag edge of a resizable column: the sessions v2 sidebar and the link
 * preview panel. Drag it, or focus it and use the arrow keys. Home and a
 * double-click reset the width. No animation: the width follows the pointer
 * and the keys at once. Place it in a `relative` column.
 */

import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface ResizeHandleProps {
  /** The column edge the handle sits on. A left edge grows the column leftward. */
  edge: "left" | "right";
  width: number;
  min: number;
  max: number;
  defaultWidth: number;
  step: number;
  /** `save` is true when a drag or a key press ends. */
  onResize: (width: number, save: boolean) => void;
  label: string;
  /** The id of the column it resizes. */
  controls?: string;
  className?: string;
}

export function ResizeHandle({
  edge,
  width,
  min,
  max,
  defaultWidth,
  step,
  onResize,
  label,
  controls,
  className,
}: ResizeHandleProps) {
  // The width and the pointer at pointer down. The width follows the
  // pointer's travel, so the grab point stays under the pointer, and a click
  // with no travel stores nothing.
  const drag = useRef<{ startX: number; startWidth: number; next: number | null } | null>(null);
  const [dragging, setDragging] = useState(false);
  const grow = edge === "right" ? 1 : -1;

  // The pointer leaves the 8 px handle during a drag: keep the resize cursor
  // and stop text selection on the whole page until it ends.
  useEffect(() => {
    if (!dragging) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [dragging]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width, next: null };
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || event.clientX === current.startX) return;
    current.next = current.startWidth + grow * (event.clientX - current.startX);
    onResize(current.next, false);
  };
  const endDrag = () => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    setDragging(false);
    if (current.next !== null) onResize(current.next, true);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") onResize(width - grow * step, true);
    else if (event.key === "ArrowRight") onResize(width + grow * step, true);
    else if (event.key === "Home") onResize(defaultWidth, true);
    else return;
    event.preventDefault();
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable splitter is a widget; <hr> is not
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      data-dragging={dragging ? "" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => onResize(defaultWidth, true)}
      onKeyDown={onKeyDown}
      className={cn(
        "absolute inset-y-0 z-10 w-2 cursor-col-resize touch-none outline-none",
        edge === "right" ? "-right-1" : "-left-1",
        "after:absolute after:inset-y-0 after:left-[3px] after:w-0.5 after:bg-transparent after:transition-colors after:duration-150 after:ease-snappy",
        "hover:after:bg-primary focus-visible:after:bg-primary data-dragging:after:bg-primary",
        className,
      )}
    />
  );
}
