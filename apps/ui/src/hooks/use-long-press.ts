import { type MouseEvent, type PointerEvent, useEffect, useRef } from "react";

/** A press this long with no move is a long-press (the mockup's 480 ms). */
const LONG_PRESS_MS = 480;
/** A move this far ends the wait: the finger scrolls or swipes. */
const MOVE_TOLERANCE_PX = 8;

/**
 * A long-press on a touch row (SPEC R8.5): `onLongPress` runs after 480 ms
 * with no move, with a short buzz where the phone has one. The click that
 * ends the press is eaten, so the row does not also open. The context menu
 * (Android long-press) and the iOS callout stay off: the row sets
 * `[-webkit-touch-callout:none]` and `select-none`.
 */
export function useLongPress(onLongPress: (() => void) | undefined) {
  const press = useRef<{ x: number; y: number; id: number; timer: number } | null>(null);
  const fired = useRef(false);

  const cancel = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(
    () => () => {
      if (press.current) window.clearTimeout(press.current.timer);
    },
    [],
  );

  return {
    onPointerDown: (event: PointerEvent) => {
      cancel();
      fired.current = false;
      if (!onLongPress || event.button !== 0) return;
      const timer = window.setTimeout(() => {
        press.current = null;
        fired.current = true;
        navigator.vibrate?.(12);
        onLongPress();
      }, LONG_PRESS_MS);
      press.current = { x: event.clientX, y: event.clientY, id: event.pointerId, timer };
    },
    onPointerMove: (event: PointerEvent) => {
      const current = press.current;
      if (!current || event.pointerId !== current.id) return;
      const moved = Math.hypot(event.clientX - current.x, event.clientY - current.y);
      if (moved >= MOVE_TOLERANCE_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (event: MouseEvent) => {
      if (onLongPress) event.preventDefault();
    },
    /** Eat the click that ends a long-press. */
    onClickCapture: (event: MouseEvent) => {
      if (!fired.current) return;
      fired.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
