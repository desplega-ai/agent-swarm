import {
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";

/** Which way the finger moves: left runs the right-hand action, right the left-hand one. */
export type SwipeSide = "left" | "right";

/** The action runs past this distance (SPEC R8.5). */
export const SWIPE_THRESHOLD_PX = 80;
/** Below this move, the gesture has no direction yet. */
const LOCK_PX = 8;
/** The row leaves or snaps back in this time, on the swift curve (UX review R9). */
const SETTLE_MS = 200;
/** Then the row's slot closes in this time, on the snappy curve, so the rows below glide up. */
const COLLAPSE_MS = 150;
const SNAPPY = "cubic-bezier(0.2, 0, 0, 1)";
/** A row that left but is still here (the list kept it) comes back after this. */
const RETURN_MS = 1200;

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * What a move from the press point is: nothing yet (under 8 px), a swipe
 * (mostly sideways), or a scroll (anything else, the browser keeps it).
 */
export function swipeMode(dx: number, dy: number): "swipe" | "scroll" | null {
  if (Math.abs(dx) < LOCK_PX && Math.abs(dy) < LOCK_PX) return null;
  return Math.abs(dx) > Math.abs(dy) * 1.2 ? "swipe" : "scroll";
}

/**
 * Where the row sits for a finger `dx` from the press point. Past the
 * threshold it follows more slowly, so the end feels firm. It never leaves
 * the row's width.
 */
export function swipeOffset(dx: number, width: number): number {
  const distance = Math.abs(dx);
  const eased =
    distance <= SWIPE_THRESHOLD_PX
      ? distance
      : SWIPE_THRESHOLD_PX + (distance - SWIPE_THRESHOLD_PX) * 0.6;
  return Math.sign(dx) * Math.min(width, eased);
}

/**
 * Swipe a touch row sideways (SPEC R8.5). The first 8 px decide (`swipeMode`):
 * a swipe makes the row follow the finger, a scroll stays with the browser
 * (the row sets `touch-action: pan-y`). Past 80 px the action arms. A
 * release past it runs `onSwipe`:
 *
 * - Left: the row slides out (200 ms, swift), its slot closes (150 ms,
 *   snappy), then `onSwipe` takes it out of the list. Reduced motion: no
 *   slide, the row fades out.
 * - Right: the row snaps back and `onSwipe` runs.
 *
 * The click that ends a swipe is eaten. A gesture stops when `enabled`
 * turns off mid-way (a long-press started a selection), and `cancel()`
 * stops it from outside.
 */
export function useSwipeRow({
  enabled,
  onSwipe,
}: {
  enabled: boolean;
  onSwipe: (side: SwipeSide) => void;
}) {
  const [offset, setOffset] = useState(0);
  const [settling, setSettling] = useState(false);
  const gesture = useRef<{ x: number; y: number; id: number; mode: "swipe" | "scroll" | null }>(
    null,
  );
  const row = useRef<HTMLElement | null>(null);
  const swiped = useRef(false);
  const armed = Math.abs(offset) >= SWIPE_THRESHOLD_PX;
  const wasArmed = useRef(false);
  const timers = useRef<number[]>([]);
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) window.clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    if (armed && !wasArmed.current) navigator.vibrate?.(8);
    wasArmed.current = armed;
  }, [armed]);

  const later = (run: () => void, ms: number) => {
    timers.current.push(window.setTimeout(run, ms));
  };
  /** Back to rest, with the snap unless motion is reduced. */
  const snapBack = () => {
    const ms = reducedMotion() ? 0 : SETTLE_MS;
    setSettling(ms > 0);
    setOffset(0);
    later(() => setSettling(false), ms);
  };
  /** Stop a gesture: the row goes back to rest, and its click is eaten. */
  const cancel = () => {
    const current = gesture.current;
    gesture.current = null;
    if (current?.mode !== "swipe") return;
    swiped.current = true;
    snapBack();
  };

  /** Close the row's slot, then run the action. Reduced motion: a fade only. */
  const collapseThen = (run: () => void) => {
    const el = row.current;
    const reduce = reducedMotion();
    const frames = reduce
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [
          { height: `${el?.offsetHeight ?? 0}px`, opacity: 1 },
          { height: "0px", opacity: 0 },
        ];
    const animation = el?.animate?.(frames, {
      duration: COLLAPSE_MS,
      easing: SNAPPY,
      fill: "forwards",
    });
    later(() => {
      run();
      // The list kept the row (a search result): show it again.
      later(() => {
        animation?.cancel();
        snapBack();
      }, RETURN_MS);
    }, COLLAPSE_MS);
  };

  const end = (event: PointerEvent, cancelled: boolean) => {
    const current = gesture.current;
    if (!current || event.pointerId !== current.id) return;
    if (!enabled) {
      cancel();
      return;
    }
    gesture.current = null;
    if (current.mode !== "swipe") return;
    swiped.current = true;
    if (cancelled || Math.abs(offset) < SWIPE_THRESHOLD_PX) {
      snapBack();
      return;
    }
    const side: SwipeSide = offset < 0 ? "left" : "right";
    if (side === "right") {
      snapBack();
      onSwipe(side);
      return;
    }
    const ms = reducedMotion() ? 0 : SETTLE_MS;
    setSettling(ms > 0);
    setOffset(Number.NEGATIVE_INFINITY);
    later(() => collapseThen(() => onSwipe(side)), ms);
  };

  const transform =
    offset === Number.NEGATIVE_INFINITY ? "translateX(-100%)" : `translateX(${offset}px)`;
  const style: CSSProperties = {
    transform,
    transition: settling ? `transform ${SETTLE_MS}ms var(--ease-swift)` : "none",
  };

  return {
    /** Which side's action shows behind the row. */
    side: offset < 0 ? ("left" as const) : offset > 0 ? ("right" as const) : null,
    armed,
    style,
    cancel,
    handlers: {
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        swiped.current = false;
        if (!enabled || event.button !== 0 || settling) return;
        row.current = event.currentTarget;
        gesture.current = { x: event.clientX, y: event.clientY, id: event.pointerId, mode: null };
      },
      onPointerMove: (event: PointerEvent<HTMLElement>) => {
        const current = gesture.current;
        if (!current || event.pointerId !== current.id || current.mode === "scroll") return;
        if (!enabled) {
          cancel();
          return;
        }
        const dx = event.clientX - current.x;
        if (!current.mode) {
          current.mode = swipeMode(dx, event.clientY - current.y);
          if (current.mode !== "swipe") return;
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }
        setOffset(swipeOffset(dx, event.currentTarget.offsetWidth));
      },
      onPointerUp: (event: PointerEvent) => end(event, false),
      onPointerCancel: (event: PointerEvent) => end(event, true),
      /** Eat the click that ends a swipe. */
      onClickCapture: (event: MouseEvent) => {
        if (!swiped.current) return;
        swiped.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
    },
  };
}
