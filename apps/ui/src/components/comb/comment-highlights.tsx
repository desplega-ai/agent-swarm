import { type RefObject, useEffect, useRef } from "react";
import type { AnchorResolution } from "@/lib/comb/comment-anchor";
import type { DomTextSpace } from "@/lib/comb/dom-text-space";

// CSS Custom Highlight API: paints exact text ranges without touching the DOM
// (wrapping text in elements would break native selection and the anchors).
// Styles: `::highlight(comb-comment*)` in `styles/globals.css`.
const NAMES = {
  anchored: "comb-comment",
  moved: "comb-comment-moved",
  pending: "comb-comment-pending",
  active: "comb-comment-active",
} as const;

// Older browsers: a class on the blocks that hold the passage instead.
const FALLBACK_CLASS = "comb-comment-fallback";
const FALLBACK_PENDING_CLASS = "comb-comment-fallback-pending";
const FALLBACK_ACTIVE_CLASS = "comb-comment-fallback-active";

function supportsHighlights(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

interface CommentHighlightsProps {
  rootRef: RefObject<HTMLElement | null>;
  space: DomTextSpace | null;
  anchors: Map<string, AnchorResolution>;
  /** Comments to paint (the open threads the rail's search and filter show). */
  paintIds: ReadonlySet<string>;
  /** Painted comments in the pending style (`@swarm`, not sent yet). */
  pendingIds: ReadonlySet<string>;
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
  pendingIds,
  emphasizedIds,
  pending,
  onHover,
  onActivate,
}: CommentHighlightsProps) {
  // Painted ranges by comment id with their text length, for hit-testing.
  const rangesRef = useRef(new Map<string, { range: Range; length: number }>());
  const callbacks = useRef({ onHover, onActivate });
  callbacks.current = { onHover, onActivate };

  useEffect(() => {
    const ranges = new Map<string, { range: Range; length: number }>();
    rangesRef.current = ranges;
    if (!space) return;
    const native = supportsHighlights();
    const groups: Record<keyof typeof NAMES, Range[]> = {
      anchored: [],
      moved: [],
      pending: [],
      active: [],
    };
    const marked: Element[] = [];
    const markBlocks = (start: number, end: number, className: string) => {
      for (const el of space.blocksFor(start, end)) {
        el.classList.add(className);
        marked.push(el);
      }
    };

    anchors.forEach((resolution, id) => {
      const painted = paintIds.has(id);
      const emphasized = emphasizedIds.has(id);
      if (!painted && !emphasized) return;
      if (resolution.start == null || resolution.end == null) return;
      const range = space.toRange(resolution.start, resolution.end);
      if (!range) return;
      ranges.set(id, { range, length: resolution.end - resolution.start });
      // A pending passage keeps the pending style when it moved: the card says "Moved".
      const style = pendingIds.has(id)
        ? "pending"
        : resolution.status === "moved"
          ? "moved"
          : "anchored";
      if (painted) groups[style].push(range);
      if (emphasized) groups.active.push(range);
      if (!native) {
        markBlocks(
          resolution.start,
          resolution.end,
          emphasized
            ? FALLBACK_ACTIVE_CLASS
            : style === "pending"
              ? FALLBACK_PENDING_CLASS
              : FALLBACK_CLASS,
        );
      }
    });
    if (pending) {
      groups.active.push(pending);
      if (!native) {
        const start = space.pointToOffset(pending.startContainer, pending.startOffset);
        const end = space.pointToOffset(pending.endContainer, pending.endOffset);
        if (start != null && end != null) markBlocks(start, end, FALLBACK_ACTIVE_CLASS);
      }
    }

    if (native) {
      for (const [group, name] of Object.entries(NAMES) as [keyof typeof NAMES, string][]) {
        const highlight = new Highlight(...groups[group]);
        if (group === "active") highlight.priority = 1;
        CSS.highlights.set(name, highlight);
      }
    }
    return () => {
      if (native) for (const name of Object.values(NAMES)) CSS.highlights.delete(name);
      for (const el of marked) {
        el.classList.remove(FALLBACK_CLASS, FALLBACK_PENDING_CLASS, FALLBACK_ACTIVE_CLASS);
      }
    };
  }, [space, anchors, paintIds, pendingIds, emphasizedIds, pending]);

  // Pointer hit-testing over the painted ranges (the smallest range wins).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const hitAt = (x: number, y: number): string | null => {
      let hit: string | null = null;
      let hitLength = Number.POSITIVE_INFINITY;
      rangesRef.current.forEach(({ range, length }, id) => {
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
