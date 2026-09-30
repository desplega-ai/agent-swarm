// Ported from agent-fs `live/src/lib/dom-text-space.ts` (agent-fs commit
// 08e7d89). Adaptations: the walker also skips `data-comb-skip` elements and
// Streamdown chrome (`isSkippedElement`), and `anchorFromRange` comes from
// live/ `MarkdownViewer.tsx` (`targetFromDom`). `rehypeSourceLines` lives in
// `rehype-source-lines.ts`.
//
// Relative imports only: `bun:test` runs this from the repo root.

import { type AnchorQuote, captureQuote, type TextSpace } from "./comment-anchor";

/**
 * A TextSpace over rendered DOM text (the markdown preview, the text viewer
 * rows). Blocks are separated by "\n" so a quote taken across paragraphs
 * matches the way `Selection.toString()` reports it, and elements stamped with
 * `data-line-start`/`data-line-end` (see `rehypeSourceLines`) map offsets back
 * to source lines.
 */
export interface DomTextSpace extends TextSpace {
  lineRangeToOffsets: NonNullable<TextSpace["lineRangeToOffsets"]>;
  offsetToLine: NonNullable<TextSpace["offsetToLine"]>;
  /** DOM Range for [start, end) offsets. */
  toRange(start: number, end: number): Range | null;
  /** Text offset of a DOM boundary point (e.g. a Selection range edge). */
  pointToOffset(node: Node, offset: number): number | null;
  /** Blocks (elements carrying source lines) intersecting [start, end). */
  blocksFor(start: number, end: number): HTMLElement[];
}

const BLOCK_TAGS = new Set([
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "BLOCKQUOTE",
  "PRE",
  "TR",
  "TD",
  "TH",
  "DIV",
  "DT",
  "DD",
  "UL",
  "OL",
  "TABLE",
  "HR",
  "BR",
]);
// Chrome and embedded UI (copy buttons, diagrams) aren't document text.
const SKIP_TAGS = new Set(["BUTTON", "SVG", "svg", "SCRIPT", "STYLE"]);
// Streamdown chrome (streamdown 2.5 `data-streamdown` values). With
// `controls={false}` most of it never renders, but it is not document text.
const SKIP_STREAMDOWN = new Set([
  "code-block-header",
  "code-block-actions",
  "mermaid-block-actions",
  "table-fullscreen",
  "image-fallback",
]);

/**
 * Elements whose text is not document text: buttons and other chrome,
 * `aria-hidden` decoration, anything marked `data-comb-skip` (the text viewer
 * gutter, notices), and Streamdown's own UI.
 */
export function isSkippedElement(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName)) return true;
  if (el.getAttribute("aria-hidden") === "true") return true;
  if (el.hasAttribute("data-comb-skip")) return true;
  const streamdown = el.getAttribute("data-streamdown");
  return streamdown !== null && SKIP_STREAMDOWN.has(streamdown);
}

interface Segment {
  node: Text;
  start: number;
}

interface Block {
  el: HTMLElement;
  start: number;
  end: number;
  lineStart: number;
  lineEnd: number;
}

export function buildDomTextSpace(root: HTMLElement): DomTextSpace {
  let text = "";
  const segments: Segment[] = [];
  const blocks: Block[] = [];

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const data = (node as Text).data;
      if (data) {
        segments.push({ node: node as Text, start: text.length });
        text += data;
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (isSkippedElement(el)) return;
    const isBlock = BLOCK_TAGS.has(el.tagName);
    if (isBlock && text && !text.endsWith("\n")) text += "\n";
    const start = text.length;
    for (let child = el.firstChild; child; child = child.nextSibling) walk(child);
    const ls = el.dataset.lineStart;
    const le = el.dataset.lineEnd;
    if (ls && le) {
      blocks.push({ el, start, end: text.length, lineStart: Number(ls), lineEnd: Number(le) });
    }
    if (isBlock && text && !text.endsWith("\n")) text += "\n";
  };
  walk(root);

  const segmentAt = (offset: number): number => {
    // Last segment starting at or before `offset`.
    let lo = 0;
    let hi = segments.length - 1;
    if (hi < 0 || segments[0].start > offset) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments[mid].start <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const toPoint = (offset: number, isEnd: boolean): [Text, number] | null => {
    const i = segmentAt(offset);
    if (i < 0) return segments.length ? [segments[0].node, 0] : null;
    const seg = segments[i];
    const within = offset - seg.start;
    if (within <= seg.node.data.length) {
      // An end offset exactly at a segment start belongs to the previous one.
      if (isEnd && within === 0 && i > 0) {
        const prev = segments[i - 1];
        return [prev.node, prev.node.data.length];
      }
      return [seg.node, within];
    }
    // Offset falls on a block separator: snap forward (start) or back (end).
    if (isEnd) return [seg.node, seg.node.data.length];
    const next = segments[i + 1];
    return next ? [next.node, 0] : [seg.node, seg.node.data.length];
  };

  const innermost = (list: Block[]) =>
    list.filter((b) => !list.some((o) => o !== b && b.el.contains(o.el)));

  return {
    text,
    toRange(start, end) {
      const a = toPoint(start, false);
      const b = toPoint(end, true);
      if (!a || !b) return null;
      const range = document.createRange();
      range.setStart(a[0], a[1]);
      range.setEnd(b[0], b[1]);
      return range;
    },
    pointToOffset(node, offset) {
      if (node.nodeType === Node.TEXT_NODE) {
        const seg = segments.find((s) => s.node === node);
        if (seg) return seg.start + Math.min(offset, seg.node.data.length);
      }
      // Element boundary (e.g. triple-click): the first text after the point.
      const probe = document.createRange();
      try {
        probe.setStart(node, offset);
      } catch {
        return null;
      }
      probe.collapse(true);
      for (const seg of segments) {
        if (probe.comparePoint(seg.node, 0) >= 0) return seg.start;
      }
      return text.length;
    },
    lineRangeToOffsets(a, b) {
      const hits = innermost(blocks.filter((bl) => bl.lineStart <= b && bl.lineEnd >= a));
      if (!hits.length) return null;
      return [Math.min(...hits.map((h) => h.start)), Math.max(...hits.map((h) => h.end))];
    },
    offsetToLine(offset) {
      const hits = innermost(blocks.filter((bl) => bl.start <= offset && offset < bl.end));
      return hits.length ? hits[0].lineStart : null;
    },
    blocksFor(start, end) {
      return innermost(
        blocks.filter((bl) => bl.start < Math.max(end, start + 1) && bl.end > start),
      ).map((b) => b.el);
    },
  };
}

/** The anchor of a new comment: what `comment-add` stores next to the body. */
export interface NewCommentAnchor {
  quote?: AnchorQuote;
  lineStart?: number;
  lineEnd?: number;
  /** The selected text, first 200 characters (live/ sends it for older clients). */
  quotedContent: string;
}

/**
 * Anchor data for a new comment on a DOM range under `root`: the quote with
 * context from the rendered text, and the source lines of the blocks it spans.
 * Null when the range holds no document text.
 */
export function anchorFromRange(root: HTMLElement, range: Range): NewCommentAnchor | null {
  const space = buildDomTextSpace(root);
  const start = space.pointToOffset(range.startContainer, range.startOffset);
  const end = space.pointToOffset(range.endContainer, range.endOffset);
  if (start == null || end == null || end <= start) return null;
  const quote = captureQuote(space.text, start, end);
  if (!quote) return null;
  const lineStart = space.offsetToLine(start) ?? undefined;
  const lineEnd = space.offsetToLine(end - 1) ?? undefined;
  return {
    quote,
    lineStart,
    lineEnd: lineStart != null ? Math.max(lineStart, lineEnd ?? lineStart) : undefined,
    quotedContent: quote.exact.slice(0, 200),
  };
}
