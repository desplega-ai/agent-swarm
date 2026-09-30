import { type RefObject, useEffect, useRef } from "react";
import type { AnchorResolution } from "@/lib/comb/comment-anchor";
import type { DomTextSpace } from "@/lib/comb/dom-text-space";

// CSS Custom Highlight API: paints exact text ranges without touching the DOM
// (wrapping text in elements would break native selection and the anchors).
// Styles: `::highlight(comb-comment*)` in `styles/globals.css`.
const NAMES = {
  anchored: "comb-comment",
  moved: "comb-comment-moved",
  active: "comb-comment-active",
} as const;

// Older browsers: a class on the blocks that hold the passage instead.
const FALLBACK_CLASS = "comb-comment-fallback";
const FALLBACK_ACTIVE_CLASS = "comb-comment-fallback-active";

function supportsHighlights(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

interface CommentHighlightsProps {
  rootRef: RefObject<HTMLElement | null>;
  space: DomTextSpace | null;
  anchors: Map<string, AnchorResolution>;
  /** Comments to paint (the open threads). */
  paintIds: ReadonlySet<string>;
  /** Painted in the active style, open or not: the selected card, the hovered card. */
  emphasizedIds: ReadonlySet<string>;
  /** The passage a new comment is being written on. */
  pending: Range | null;
  /** Pointer over a painted passage (null when it leaves). */
  onHover: (id: string | null) => void;
  /** Click on a painted passage. */
  onActivate: (id: string) => void;
}

/** Paint comment anchors in the viewer pane and report pointer hits. Renders nothing. */
export function CommentHighlights({
  rootRef,
  space,
  anchors,
  paintIds,
  emphasizedIds,
  pending,
  onHover,
  onActivate,
}: CommentHighlightsProps) {
  // Painted ranges by comment id, for hit-testing.
  const rangesRef = useRef(new Map<string, Range>());
  const callbacks = useRef({ onHover, onActivate });
  callbacks.current = { onHover, onActivate };

  useEffect(() => {
    const ranges = new Map<string, Range>();
    rangesRef.current = ranges;
    if (!space) return;
    const native = supportsHighlights();
    const groups: Record<keyof typeof NAMES, Range[]> = { anchored: [], moved: [], active: [] };
    const marked: Element[] = [];

    anchors.forEach((resolution, id) => {
      const painted = paintIds.has(id);
      const emphasized = emphasizedIds.has(id);
      if (!painted && !emphasized) return;
      if (resolution.start == null || resolution.end == null) return;
      const range = space.toRange(resolution.start, resolution.end);
      if (!range) return;
      ranges.set(id, range);
      if (painted) groups[resolution.status === "moved" ? "moved" : "anchored"].push(range);
      if (emphasized) groups.active.push(range);
      if (!native) {
        for (const el of space.blocksFor(resolution.start, resolution.end)) {
          el.classList.add(emphasized ? FALLBACK_ACTIVE_CLASS : FALLBACK_CLASS);
          marked.push(el);
        }
      }
    });
    if (pending) groups.active.push(pending);

    if (native) {
      for (const [group, name] of Object.entries(NAMES) as [keyof typeof NAMES, string][]) {
        const highlight = new Highlight(...groups[group]);
        if (group === "active") highlight.priority = 1;
        CSS.highlights.set(name, highlight);
      }
    }
    return () => {
      if (native) for (const name of Object.values(NAMES)) CSS.highlights.delete(name);
      for (const el of marked) el.classList.remove(FALLBACK_CLASS, FALLBACK_ACTIVE_CLASS);
    };
  }, [space, anchors, paintIds, emphasizedIds, pending]);

  // Pointer hit-testing over the painted ranges (the smallest range wins).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const hitAt = (x: number, y: number): string | null => {
      let hit: string | null = null;
      let hitLength = Number.POSITIVE_INFINITY;
      rangesRef.current.forEach((range, id) => {
        const length = range.toString().length;
        if (length >= hitLength) return;
        for (const rect of range.getClientRects()) {
          if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
            hit = id;
            hitLength = length;
            break;
          }
        }
      });
      return hit;
    };
    let frame = 0;
    let hovered: string | null = null;
    const onMove = (event: MouseEvent) => {
      if (frame) return;
      const { clientX, clientY } = event;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const hit = hitAt(clientX, clientY);
        if (hit !== hovered) {
          hovered = hit;
          callbacks.current.onHover(hit);
        }
      });
    };
    const onLeave = () => {
      if (hovered === null) return;
      hovered = null;
      callbacks.current.onHover(null);
    };
    const onClick = (event: MouseEvent) => {
      // A click that ends a text selection is not an activation.
      if (!window.getSelection()?.isCollapsed) return;
      const hit = hitAt(event.clientX, event.clientY);
      if (hit) callbacks.current.onActivate(hit);
    };
    root.addEventListener("mousemove", onMove);
    root.addEventListener("mouseleave", onLeave);
    root.addEventListener("click", onClick);
    return () => {
      root.removeEventListener("mousemove", onMove);
      root.removeEventListener("mouseleave", onLeave);
      root.removeEventListener("click", onClick);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [rootRef]);

  return null;
}
