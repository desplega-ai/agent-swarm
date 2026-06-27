import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const EDGE = 8; // min distance from viewport edges
const GAP = 6; // distance from the trigger

/**
 * Portal-based hover/focus tooltip. Renders a `position: fixed` box anchored to
 * the trigger's bounding rect, so it can NEVER be clipped by scroll containers,
 * table cells, or dialogs. Viewport-edge aware: flips below when there is no
 * headroom, x is clamped into the viewport.
 */
export function Tooltip(props: {
  text: ReactNode;
  children: ReactNode;
  /** Wider box (420px) for rich hover cards. */
  wide?: boolean;
  /** Block-level trigger — for wrapping full-width cells (ellipsis keeps working). */
  block?: boolean;
}): ReactNode {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const open = useCallback(() => {
    const el = triggerRef.current;
    if (el) setAnchor(el.getBoundingClientRect());
  }, []);
  const close = useCallback(() => {
    setAnchor(null);
    setPos(null);
  }, []);

  // Position once the box has rendered (hidden) and can be measured.
  useLayoutEffect(() => {
    if (!anchor || !boxRef.current) return;
    const box = boxRef.current.getBoundingClientRect();
    const centerX = anchor.left + anchor.width / 2;
    const left = Math.max(
      EDGE,
      Math.min(centerX - box.width / 2, window.innerWidth - EDGE - box.width),
    );
    let top = anchor.top - GAP - box.height; // above by default
    if (top < EDGE) top = anchor.bottom + GAP; // flip below
    top = Math.max(EDGE, Math.min(top, window.innerHeight - EDGE - box.height));
    setPos({ left, top });
  }, [anchor]);

  // Stale positions are worse than no tooltip — close on any scroll/resize.
  useEffect(() => {
    if (!anchor) return;
    window.addEventListener("scroll", close, { capture: true, passive: true });
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
    };
  }, [anchor, close]);

  // Live tables re-layout under a stationary cursor (new rows pushing the
  // trigger away) and browsers fire no mouseleave until the pointer moves —
  // leaving the box stranded over unrelated content. While open, re-validate
  // that the trigger is still actually hovered/focused.
  useEffect(() => {
    if (!anchor) return;
    const id = window.setInterval(() => {
      const el = triggerRef.current;
      if (!el || (!el.matches(":hover") && !el.matches(":focus-within"))) close();
    }, 300);
    return () => window.clearInterval(id);
  }, [anchor, close]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: passive hover/focus wrapper — the tooltip content is announced via the child's aria-label/role, not by interacting with this span
    <span
      className={props.block ? "tooltip block" : "tooltip"}
      ref={triggerRef}
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={open}
      onBlur={close}
    >
      {props.children}
      {anchor !== null
        ? createPortal(
            <div
              ref={boxRef}
              role="tooltip"
              className={props.wide ? "tip-box wide" : "tip-box"}
              style={
                pos
                  ? { left: pos.left, top: pos.top }
                  : { left: -9999, top: -9999, visibility: "hidden" }
              }
            >
              {props.text}
            </div>,
            // A showModal() dialog paints in the top layer ABOVE (and inert to)
            // anything portaled to document.body — so when the trigger lives
            // inside an open modal, portal into the dialog itself. Positioning
            // math is unchanged: the dialog has no transform, so position:fixed
            // stays viewport-anchored either way.
            triggerRef.current?.closest("dialog:modal") ?? document.body,
          )
        : null}
    </span>
  );
}

/** Lowkey ⓘ glyph + Tooltip. */
export function InfoTip(props: { text: ReactNode }): ReactNode {
  const label = typeof props.text === "string" ? props.text : undefined;
  return (
    <Tooltip text={props.text}>
      <span className="info-tip" role="img" aria-label={label}>
        ⓘ
      </span>
    </Tooltip>
  );
}
