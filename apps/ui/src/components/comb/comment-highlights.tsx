import { type RefObject, useEffect, useRef } from "react";
import type { AnchorResolution } from "@/lib/comb/comment-anchor";
import { assetTargets, type DomTextSpace } from "@/lib/comb/dom-text-space";

// CSS Custom Highlight API: paints exact text ranges without touching the DOM
// (wrapping text in elements would break native selection and the anchors).
// Styles: `::highlight(comb-comment*)` in `styles/globals.css`.
const NAMES = {
  anchored: "comb-comment",
  moved: "comb-comment-moved",
  flagged: "comb-comment-flagged",
  active: "comb-comment-active",
} as const;

// Older browsers: a class on the blocks that hold the passage instead.
const FALLBACK_CLASS = "comb-comment-fallback";
const FALLBACK_FLAGGED_CLASS = "comb-comment-fallback-flagged";
const FALLBACK_ACTIVE_CLASS = "comb-comment-fallback-active";

// A comment on an image or a diagram has no text to paint: its asset gets an
// outline through this attribute instead (styles on the asset frame).
export const ASSET_COMMENT_ATTR = "data-comb-asset-comment";
const ASSET_STYLE_RANK = { painted: 0, flagged: 1, active: 2 } as const;
type AssetStyle = keyof typeof ASSET_STYLE_RANK;
/** An asset range is never the smallest hit: the text painted over it wins. */
const ASSET_HIT_LENGTH = Number.MAX_SAFE_INTEGER;

function supportsHighlights(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

interface CommentHighlightsProps {
  rootRef: RefObject<HTMLElement | null>;
  space: DomTextSpace | null;
  anchors: Map<string, AnchorResolution>;
  /** Comments to paint (the open threads the rail's search and filter show). */
  paintIds: ReadonlySet<string>;
  /** Painted comments in the flagged style (`@swarm`, not sent yet). */
  flaggedIds: ReadonlySet<string>;
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
  flaggedIds,
  emphasizedIds,
  pending,
  onHover,
  onActivate,
}: CommentHighlightsProps) {
  // Painted ranges by comment id with their text length, for hit-testing.
  const rangesRef = useRef(new Map<string, { ranges: Range[]; length: number }>());
  const callbacks = useRef({ onHover, onActivate });
  callbacks.current = { onHover, onActivate };

  useEffect(() => {
    const ranges = new Map<string, { ranges: Range[]; length: number }>();
    rangesRef.current = ranges;
    if (!space) return;
    const native = supportsHighlights();
    const groups: Record<keyof typeof NAMES, Range[]> = {
      anchored: [],
      moved: [],
      flagged: [],
      active: [],
    };
    const marked: Element[] = [];
    const assets = new Map<HTMLElement, AssetStyle>();
    const markAsset = (el: HTMLElement, style: AssetStyle) => {
      const current = assets.get(el);
      if (!current || ASSET_STYLE_RANK[style] > ASSET_STYLE_RANK[current]) assets.set(el, style);
    };
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
      const targets = assetTargets(space, resolution);
      if (targets.length > 0) {
        const hits = targets.map((el) => {
          const range = document.createRange();
          range.selectNode(el);
          return range;
        });
        ranges.set(id, { ranges: hits, length: ASSET_HIT_LENGTH });
        const style: AssetStyle = emphasized
          ? "active"
          : flaggedIds.has(id)
            ? "flagged"
            : "painted";
        for (const el of targets) markAsset(el, style);
        return;
      }
      // One range per text run: a passage over several code rows skips their line numbers.
      const parts = space.toRanges(resolution.start, resolution.end);
      if (parts.length === 0) return;
      ranges.set(id, { ranges: parts, length: resolution.end - resolution.start });
      // A flagged passage keeps the flagged style when it moved: the card says "Moved".
      const style = flaggedIds.has(id)
        ? "flagged"
        : resolution.status === "moved"
          ? "moved"
          : "anchored";
      if (painted) groups[style].push(...parts);
      if (emphasized) groups.active.push(...parts);
      if (!native) {
        markBlocks(
          resolution.start,
          resolution.end,
          emphasized
            ? FALLBACK_ACTIVE_CLASS
            : style === "flagged"
              ? FALLBACK_FLAGGED_CLASS
              : FALLBACK_CLASS,
        );
      }
    });
    if (pending) {
      const start = space.pointToOffset(pending.startContainer, pending.startOffset);
      const end = space.pointToOffset(pending.endContainer, pending.endOffset);
      const known = start != null && end != null;
      groups.active.push(...(known ? space.toRanges(start, end) : [pending]));
      if (!native && known) markBlocks(start, end, FALLBACK_ACTIVE_CLASS);
    }

    for (const [el, style] of assets) el.setAttribute(ASSET_COMMENT_ATTR, style);

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
        el.classList.remove(FALLBACK_CLASS, FALLBACK_FLAGGED_CLASS, FALLBACK_ACTIVE_CLASS);
      }
      for (const el of assets.keys()) el.removeAttribute(ASSET_COMMENT_ATTR);
    };
  }, [space, anchors, paintIds, flaggedIds, emphasizedIds, pending]);

  // Pointer hit-testing over the painted ranges (the smallest range wins).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const hitAt = (x: number, y: number): string | null => {
      let hit: string | null = null;
      let hitLength = Number.POSITIVE_INFINITY;
      rangesRef.current.forEach(({ ranges, length }, id) => {
        if (length >= hitLength) return;
        const over = ranges.some((range) =>
          Array.from(range.getClientRects()).some(
            (rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
          ),
        );
        if (over) {
          hit = id;
          hitLength = length;
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
      // A button over a painted asset (Maximize, Comment) does its own thing.
      if (event.target instanceof Element && event.target.closest("button")) return;
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
