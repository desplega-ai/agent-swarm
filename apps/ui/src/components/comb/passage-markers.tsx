import { type RefObject, useLayoutEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import type { AnchorResolution } from "@/lib/comb/comment-anchor";
import type { DomTextSpace } from "@/lib/comb/dom-text-space";
import { ProcessingDot } from "./swarm-state";

interface PassageMarkersProps {
  rootRef: RefObject<HTMLElement | null>;
  space: DomTextSpace | null;
  anchors: Map<string, AnchorResolution>;
  /** Comments to mark: the processing threads the rail shows. */
  ids: ReadonlySet<string>;
}

/**
 * A pulsing dot in the left margin of each processing passage, level with
 * its first line. `::highlight()` cannot animate, and an element inside the
 * pane would change the text the anchors read, so the dots live in a portal
 * with fixed positions that follow every scroll and resize. They hide while
 * their line is outside the pane. Decorative: the thread card says
 * "Processing" and links the task.
 */
export function PassageMarkers({ rootRef, space, anchors, ids }: PassageMarkersProps) {
  const marked = useMemo(
    () =>
      [...ids].filter((id) => {
        const anchor = anchors.get(id);
        return anchor?.start != null && anchor.end != null;
      }),
    [ids, anchors],
  );
  const elements = useRef(new Map<string, HTMLSpanElement>());

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !space || marked.length === 0) return;
    const targets = marked.flatMap((id) => {
      const anchor = anchors.get(id);
      const element = elements.current.get(id);
      if (!element || anchor?.start == null || anchor.end == null) return [];
      const range = space.toRange(anchor.start, anchor.end);
      if (!range) return [];
      return [{ element, range, block: space.blocksFor(anchor.start, anchor.end)[0] ?? null }];
    });
    // Synchronous on scroll: a frame of delay would make the dots trail the text.
    const place = () => {
      const pane = root.getBoundingClientRect();
      for (const { element, range, block } of targets) {
        const line = range.getClientRects()[0];
        const y = line ? line.top + line.height / 2 : Number.NaN;
        const visible = line !== undefined && y >= pane.top + 6 && y <= pane.bottom - 6;
        element.style.visibility = visible ? "visible" : "hidden";
        if (!line || !visible) continue;
        const start = block?.getBoundingClientRect().left ?? line.left;
        const x = Math.max(pane.left + 8, start - 12);
        element.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
      }
    };
    place();
    document.addEventListener("scroll", place, { capture: true, passive: true });
    window.addEventListener("resize", place);
    const observer = new ResizeObserver(place);
    observer.observe(root);
    if (root.firstElementChild) observer.observe(root.firstElementChild);
    return () => {
      document.removeEventListener("scroll", place, { capture: true });
      window.removeEventListener("resize", place);
      observer.disconnect();
    };
  }, [rootRef, space, anchors, marked]);

  if (marked.length === 0) return null;
  return createPortal(
    marked.map((id) => (
      <span
        key={id}
        aria-hidden
        ref={(element) => {
          if (!element) return;
          elements.current.set(id, element);
          return () => {
            elements.current.delete(id);
          };
        }}
        className="pointer-events-none invisible fixed top-0 left-0 z-10 flex"
      >
        <ProcessingDot className="size-2" />
      </span>
    )),
    document.body,
  );
}
