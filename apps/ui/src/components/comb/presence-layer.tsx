import { useReducedMotion } from "motion/react";
import { type RefObject, useCallback, useEffect, useMemo, useRef } from "react";
import type { StatResult } from "@/lib/agent-fs/types";
import { type AnchorResolution, resolveAnchor } from "@/lib/comb/comment-anchor";
import type { DomTextSpace } from "@/lib/comb/dom-text-space";
import { type FileKind, getFileKind } from "@/lib/comb/file-kinds";
import type { DrivePath } from "@/lib/comb/paths";
import {
  fromGapPointer,
  fromLinePointer,
  fromMediaPointer,
  type LineBlock,
  type LinePointer,
  PEER_FOREGROUND_VAR,
  type PresencePeer,
  type PresencePointer,
  type PresenceSelection,
  peerColorVar,
  peerHighlightName,
  selectionQuote,
  toGapPointer,
  toLinePointer,
  toMediaPointer,
} from "@/lib/comb/presence";
import { usePresenceControl, usePresencePeers } from "./presence-context";
import { useDomTextSpace } from "./use-dom-text-space";

/** Pointer positions are sampled at most this often (the socket carries the rest). */
const POINTER_INTERVAL_MS = 80;
/** A selection is read this long after it stops changing. */
const SELECTION_DEBOUNCE_MS = 150;
/** Share of the gap a remote pointer closes per frame (reduced motion: all of it). */
const SMOOTHING = 0.3;

const STAMPED = "[data-line-start]";

/** Text and markdown map a pointer to source lines, media to its box. Tables send none. */
function pointerMode(kind: FileKind): "lines" | "media" | null {
  if (kind === "markdown" || kind === "text") return "lines";
  if (kind === "image" || kind === "video" || kind === "pdf") return "media";
  return null;
}

// A PDF frame swallows pointer events, so only pointers over its margins are
// sent. Remote pointers still land on the frame's box.
const MEDIA_SELECTOR: Partial<Record<FileKind, string>> = {
  image: "img",
  video: "video",
  pdf: "iframe",
};

function blockLines(el: HTMLElement): [number, number] | null {
  const start = Number(el.dataset.lineStart);
  const end = Number(el.dataset.lineEnd ?? el.dataset.lineStart);
  if (!Number.isInteger(start) || start < 1) return null;
  return [start, Number.isInteger(end) ? Math.max(start, end) : start];
}

function lineBlock(el: HTMLElement): LineBlock | null {
  const lines = blockLines(el);
  return lines ? { box: el.getBoundingClientRect(), lineStart: lines[0], lineEnd: lines[1] } : null;
}

/** The outermost stamped block that holds `el` (itself when none does). */
function outermost(root: HTMLElement, el: HTMLElement): HTMLElement {
  let top = el;
  for (
    let up = el.parentElement?.closest<HTMLElement>(STAMPED);
    up && root.contains(up);
    up = up.parentElement?.closest<HTMLElement>(STAMPED)
  ) {
    top = up;
  }
  return top;
}

/**
 * This tab's pointer over text as a line pointer: over a block, beside it
 * (the pane's margin), or in the gap between two blocks (an image, a margin).
 */
function linePointerAt(
  root: HTMLElement,
  target: EventTarget | null,
  x: number,
  y: number,
): LinePointer | null {
  const own = target instanceof Element ? target.closest<HTMLElement>(STAMPED) : null;
  const inside = own && root.contains(own) ? lineBlock(own) : null;
  if (inside) return toLinePointer(inside.box, inside.lineStart, inside.lineEnd, x, y);
  // Blocks come in reading order: find the last one that starts above the pointer.
  const blocks = root.querySelectorAll<HTMLElement>(STAMPED);
  let lo = 0;
  let hi = blocks.length - 1;
  let index = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].getBoundingClientRect().top <= y) {
      index = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const first = blocks.length ? lineBlock(blocks[0]) : null;
  if (index < 0) return first && toLinePointer(first.box, first.lineStart, first.lineEnd, x, y);
  const above = lineBlock(outermost(root, blocks[index]));
  if (!above) return null;
  if (y < above.box.top + above.box.height) {
    return toLinePointer(above.box, above.lineStart, above.lineEnd, x, y);
  }
  const next = index + 1 < blocks.length ? lineBlock(blocks[index + 1]) : null;
  return toGapPointer(above, next, x, y);
}

/** What renders source line `n`: its innermost block, or the blocks around the gap it is in. */
type LineSpot = { el: HTMLElement } | { above: HTMLElement; below: HTMLElement | null };

function lineSpot(root: HTMLElement, n: number): LineSpot | null {
  const exact = root.querySelectorAll<HTMLElement>(
    `[data-line-start="${n}"][data-line-end="${n}"]`,
  );
  if (exact.length) return { el: exact[exact.length - 1] };
  let inner: HTMLElement | null = null;
  let innerSpan = Number.POSITIVE_INFINITY;
  let above: HTMLElement | null = null;
  let aboveEnd = 0;
  let aboveSpan = -1;
  let below: HTMLElement | null = null;
  let belowStart = Number.POSITIVE_INFINITY;
  for (const el of root.querySelectorAll<HTMLElement>(STAMPED)) {
    const lines = blockLines(el);
    if (!lines) continue;
    const [start, end] = lines;
    if (start <= n && n <= end) {
      if (end - start <= innerSpan) {
        inner = el;
        innerSpan = end - start;
      }
    } else if (end < n) {
      // The block right above the gap: the latest end line, the outermost block.
      if (end > aboveEnd || (end === aboveEnd && end - start > aboveSpan)) {
        above = el;
        aboveEnd = end;
        aboveSpan = end - start;
      }
    } else if (start < belowStart) {
      below = el;
      belowStart = start;
    }
  }
  if (inner) return { el: inner };
  return above ? { above, below } : null;
}

function supportsHighlights(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

function selectionKey(sel: PresenceSelection): string {
  return JSON.stringify([sel.exact, sel.prefix, sel.suffix, sel.lineStart, sel.lineEnd]);
}

/**
 * Presence on the open file. Always: tells the drive which file and version
 * this tab shows. With "Show cursors" on, and outside a review: sends this
 * tab's selection and pointer, and paints everyone else's on the same file
 * and version. Render it next to the viewer pane, in a `relative` box that
 * matches the pane, so the pointers stay out of the pane's text.
 */
export function PresenceLayer({
  file,
  stat,
  viewerRef,
  review,
}: {
  file: DrivePath;
  stat: StatResult;
  viewerRef: RefObject<HTMLElement | null>;
  /** A review (`?diff=`) replaces the file in the pane: no cursors. */
  review: boolean;
}) {
  const control = usePresenceControl();
  const setLocal = control?.setLocal;
  const version = stat.currentVersion;
  const { path } = file;

  useEffect(() => {
    setLocal?.({ file: version ? { path, version } : null });
  }, [setLocal, path, version]);
  useEffect(() => () => setLocal?.({ file: null, sel: null, ptr: null }), [setLocal]);

  if (!control?.showCursors || review || !setLocal || !version) return null;
  return (
    <CursorLayer
      path={path}
      version={version}
      kind={getFileKind(path, stat.contentType, stat.size)}
      viewerRef={viewerRef}
      setLocal={setLocal}
    />
  );
}

interface CursorLayerProps {
  path: string;
  version: number;
  kind: FileKind;
  viewerRef: RefObject<HTMLElement | null>;
  setLocal: NonNullable<ReturnType<typeof usePresenceControl>>["setLocal"];
}

function CursorLayer({ path, version, kind, viewerRef, setLocal }: CursorLayerProps) {
  const space = useDomTextSpace(viewerRef);
  const mode = pointerMode(kind);
  const peers = usePresencePeers();
  const here = useMemo(
    () => peers.filter((p) => p.file?.path === path && p.file.version === version),
    [peers, path, version],
  );

  useLocalPointer(viewerRef, kind, mode, setLocal);
  useLocalSelection(viewerRef, space, setLocal);
  useEffect(() => () => setLocal({ sel: null, ptr: null }), [setLocal]);

  const selRanges = usePeerSelections(space, here);
  const { cursorRef, labelRef } = usePeerPositions(viewerRef, kind, space, here, selRanges);

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl">
      {here.map((peer) => (
        <div key={peer.id} style={{ color: peerColorVar(peer.color) }}>
          {peer.sel ? (
            <div
              ref={labelRef(peer.id)}
              className="absolute top-0 left-0 w-0.5 bg-current opacity-0 transition-opacity duration-150"
            >
              <span
                className="absolute bottom-full left-0 mb-px whitespace-nowrap rounded-sm px-1 py-px text-[10px] font-medium leading-tight data-[flip]:right-0 data-[flip]:left-auto"
                style={{ backgroundColor: peerColorVar(peer.color), color: PEER_FOREGROUND_VAR }}
              >
                {peer.name}
              </span>
            </div>
          ) : null}
          {mode ? (
            <div
              ref={cursorRef(peer.id)}
              className="absolute top-0 left-0 opacity-0 transition-opacity duration-150"
            >
              <svg
                width="16"
                height="18"
                viewBox="0 0 16 18"
                className="fill-current stroke-background"
                aria-hidden="true"
              >
                <path d="M1 1v14.5l4-4 2.8 5.8 2.4-1.1-2.7-5.7H13z" strokeWidth="1.25" />
              </svg>
              <span
                className="absolute top-4 left-3 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-[11px] font-medium leading-tight shadow-xs data-[flip]:right-full data-[flip]:left-auto"
                style={{ backgroundColor: peerColorVar(peer.color), color: PEER_FOREGROUND_VAR }}
              >
                {peer.name}
              </span>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** Send this tab's pointer (rounded, sampled, only on change) while it is over the pane. */
function useLocalPointer(
  viewerRef: RefObject<HTMLElement | null>,
  kind: FileKind,
  mode: "lines" | "media" | null,
  setLocal: CursorLayerProps["setLocal"],
) {
  useEffect(() => {
    const root = viewerRef.current;
    if (!root || !mode) return;
    let last: { x: number; y: number; target: EventTarget | null } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sampledAt = 0;

    const compute = (): PresencePointer | null => {
      if (!last) return null;
      if (mode === "lines") return linePointerAt(root, last.target, last.x, last.y);
      const selector = MEDIA_SELECTOR[kind];
      const media = selector ? root.querySelector(selector) : null;
      return media ? toMediaPointer(media.getBoundingClientRect(), last.x, last.y) : null;
    };
    const sample = () => {
      timer = undefined;
      sampledAt = Date.now();
      setLocal({ ptr: compute() });
    };
    const schedule = () => {
      if (timer) return;
      const wait = sampledAt + POINTER_INTERVAL_MS - Date.now();
      if (wait <= 0) sample();
      else timer = setTimeout(sample, wait);
    };
    const onMove = (event: PointerEvent) => {
      // A touch drag scrolls. Only a mouse or a pen points.
      if (event.pointerType === "touch") return;
      last = { x: event.clientX, y: event.clientY, target: event.target };
      schedule();
    };
    const onLeave = () => {
      last = null;
      clearTimeout(timer);
      timer = undefined;
      setLocal({ ptr: null });
    };
    // Scrolling moves the content under a still pointer.
    const onScroll = () => {
      if (!last) return;
      last.target = document.elementFromPoint(last.x, last.y);
      schedule();
    };
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerleave", onLeave);
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
      root.removeEventListener("scroll", onScroll);
      clearTimeout(timer);
    };
  }, [viewerRef, kind, mode, setLocal]);
}

/** Send this tab's text selection in the pane as an anchor quote with its source lines. */
function useLocalSelection(
  viewerRef: RefObject<HTMLElement | null>,
  space: DomTextSpace | null,
  setLocal: CursorLayerProps["setLocal"],
) {
  useEffect(() => {
    const root = viewerRef.current;
    if (!root || !space) {
      setLocal({ sel: null });
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (): PresenceSelection | null => {
      const selection = window.getSelection();
      const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      if (!range || range.collapsed || !root.contains(range.commonAncestorContainer)) return null;
      const start = space.pointToOffset(range.startContainer, range.startOffset);
      const end = space.pointToOffset(range.endContainer, range.endOffset);
      if (start == null || end == null || end <= start) return null;
      const picked = selectionQuote(space.text, start, end);
      if (!picked) return null;
      const lineStart = space.offsetToLine(picked.start);
      if (lineStart == null) return picked.quote;
      const lineEnd = space.offsetToLineEnd(picked.end - 1) ?? lineStart;
      return { ...picked.quote, lineStart, lineEnd: Math.max(lineStart, lineEnd) };
    };
    const update = () => {
      timer = undefined;
      setLocal({ sel: read() });
    };
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(update, SELECTION_DEBOUNCE_MS);
    };
    update();
    document.addEventListener("selectionchange", onChange);
    return () => {
      document.removeEventListener("selectionchange", onChange);
      clearTimeout(timer);
    };
  }, [viewerRef, space, setLocal]);
}

/**
 * Paint each peer's selection in their color (CSS Custom Highlight API, like
 * the comment passages). A selection resolves like a comment anchor: exact
 * quote with context, then the line range. A lost anchor paints nothing.
 * Returns each peer's painted ranges (one per text run, so a selection over
 * several code rows skips their line numbers), for the name label.
 */
function usePeerSelections(space: DomTextSpace | null, here: readonly PresencePeer[]) {
  const ranges = useRef(new Map<string, Range[]>());
  // Resolving scans the text: resolve a selection once per text space.
  const cache = useRef<{ space: DomTextSpace | null; byKey: Map<string, AnchorResolution> }>({
    space: null,
    byKey: new Map(),
  });
  const selections = here.flatMap((p) => (p.sel ? [{ id: p.id, color: p.color, sel: p.sel }] : []));
  const signature = selections.map((s) => `${s.id}:${s.color}:${selectionKey(s.sel)}`).join("\n");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` holds every selection read here
  useEffect(() => {
    const painted = new Map<string, Range[]>();
    ranges.current = painted;
    if (!space) return;
    if (cache.current.space !== space) cache.current = { space, byKey: new Map() };
    const groups = new Map<number, Range[]>();
    for (const { id, color, sel } of selections) {
      const key = selectionKey(sel);
      let resolution = cache.current.byKey.get(key);
      if (!resolution) {
        resolution = resolveAnchor(space, {
          quote: { exact: sel.exact, prefix: sel.prefix, suffix: sel.suffix },
          lineStart: sel.lineStart,
          lineEnd: sel.lineEnd,
        });
        cache.current.byKey.set(key, resolution);
      }
      if (resolution.status === "lost" || resolution.start == null || resolution.end == null) {
        continue;
      }
      const parts = space.toRanges(resolution.start, resolution.end);
      if (parts.length === 0) continue;
      painted.set(id, parts);
      groups.set(color, [...(groups.get(color) ?? []), ...parts]);
    }
    if (!supportsHighlights()) return;
    for (const [color, list] of groups)
      CSS.highlights.set(peerHighlightName(color), new Highlight(...list));
    return () => {
      for (const color of groups.keys()) CSS.highlights.delete(peerHighlightName(color));
    };
  }, [space, signature]);

  return ranges;
}

/** Where a pointer's name starts, right of the arrow (`left-3`). */
const NAME_OFFSET = 12;

/** Put a name tag on the other side (`data-flip`) when it would run past the pane's right edge. */
function flip(tag: Element | null, left: number, paneWidth: number) {
  if (tag instanceof HTMLElement)
    tag.toggleAttribute("data-flip", left + tag.offsetWidth > paneWidth - 4);
}

/** Where a peer's pointer lands, in client coordinates, or null when nothing renders its spot. */
function pointerTarget(
  root: HTMLElement,
  kind: FileKind,
  ptr: PresencePointer,
  spot: (line: number) => LineSpot | null,
): { x: number; y: number } | null {
  if ("line" in ptr) {
    const found = spot(ptr.line);
    if (!found) return null;
    if ("el" in found) {
      const block = lineBlock(found.el);
      return block ? fromLinePointer(block.box, block.lineStart, block.lineEnd, ptr) : null;
    }
    const above = lineBlock(found.above);
    const below = found.below ? lineBlock(found.below) : null;
    return above ? fromGapPointer(above, below, ptr) : null;
  }
  const selector = MEDIA_SELECTOR[kind];
  const media = selector ? root.querySelector(selector) : null;
  return media ? fromMediaPointer(media.getBoundingClientRect(), ptr) : null;
}

/**
 * Place each peer's pointer and selection label over the pane. Positions are
 * kept in content coordinates (they scroll with the text), and a pointer
 * glides toward its new spot, except under reduced motion.
 */
function usePeerPositions(
  viewerRef: RefObject<HTMLElement | null>,
  kind: FileKind,
  space: DomTextSpace | null,
  here: readonly PresencePeer[],
  selRanges: RefObject<Map<string, Range[]>>,
) {
  const reduceMotion = useReducedMotion() ?? false;
  const cursors = useRef(new Map<string, HTMLElement>());
  const labels = useRef(new Map<string, HTMLElement>());
  const positions = useRef(new Map<string, { x: number; y: number }>());
  // What renders each line, found once per text layout.
  const spots = useRef(new Map<number, LineSpot | null>());
  const frame = useRef(0);
  const live = useRef({ here, kind, reduceMotion });
  live.current = { here, kind, reduceMotion };

  const draw = useCallback(() => {
    frame.current = 0;
    const root = viewerRef.current;
    if (!root) return;
    const pane = root.getBoundingClientRect();
    const { scrollLeft, scrollTop } = root;
    const spot = (line: number) => {
      const n = Math.floor(line);
      let found = spots.current.get(n);
      const stale = found && ("el" in found ? !found.el.isConnected : !found.above.isConnected);
      if (found === undefined || stale) {
        found = lineSpot(root, n);
        spots.current.set(n, found);
      }
      return found;
    };
    let moving = false;
    const shown = new Set<string>();
    for (const peer of live.current.here) {
      const cursor = cursors.current.get(peer.id);
      const target =
        cursor && peer.ptr ? pointerTarget(root, live.current.kind, peer.ptr, spot) : null;
      if (cursor && target) {
        shown.add(peer.id);
        // Content coordinates do not change when the pane scrolls.
        const tx = target.x - pane.left + scrollLeft;
        const ty = target.y - pane.top + scrollTop;
        const from = positions.current.get(peer.id);
        let x = tx;
        let y = ty;
        if (from && !live.current.reduceMotion) {
          x = from.x + (tx - from.x) * SMOOTHING;
          y = from.y + (ty - from.y) * SMOOTHING;
          if (Math.abs(tx - x) < 0.5 && Math.abs(ty - y) < 0.5) {
            x = tx;
            y = ty;
          } else {
            moving = true;
          }
        }
        positions.current.set(peer.id, { x, y });
        cursor.style.transform = `translate(${x - scrollLeft}px, ${y - scrollTop}px)`;
        cursor.style.opacity = "1";
        // Near the right edge the name goes to the left of the pointer.
        flip(cursor.lastElementChild, x - scrollLeft + NAME_OFFSET, pane.width);
      } else if (cursor) {
        cursor.style.opacity = "0";
      }
      const label = labels.current.get(peer.id);
      if (label) {
        const rects = selRanges.current?.get(peer.id)?.at(-1)?.getClientRects();
        const end = rects && rects.length > 0 ? rects[rects.length - 1] : null;
        if (end) {
          label.style.height = `${end.height}px`;
          label.style.transform = `translate(${end.right - pane.left}px, ${end.top - pane.top}px)`;
          label.style.opacity = "1";
          flip(label.firstElementChild, end.right - pane.left, pane.width);
        } else {
          label.style.opacity = "0";
        }
      }
    }
    // A pointer that comes back appears at its spot. It does not glide in.
    for (const id of positions.current.keys()) if (!shown.has(id)) positions.current.delete(id);
    if (moving) frame.current = requestAnimationFrame(draw);
  }, [viewerRef, selRanges]);

  const kick = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(draw);
  }, [draw]);

  // A new text layout: find the blocks again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `space` changes with the layout
  useEffect(() => {
    spots.current.clear();
  }, [space]);
  // New data or a new motion setting: place everything again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are the redraw triggers
  useEffect(() => {
    kick();
  }, [here, space, reduceMotion, kick]);

  useEffect(() => {
    const root = viewerRef.current;
    if (!root) return;
    const observer = new ResizeObserver(kick);
    observer.observe(root);
    root.addEventListener("scroll", kick, { passive: true });
    return () => {
      observer.disconnect();
      root.removeEventListener("scroll", kick);
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [viewerRef, kick]);

  // One ref callback per peer and element, so a re-render does not detach it.
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const refFor = useCallback((into: Map<string, HTMLElement>, key: string, id: string) => {
    let ref = refs.current.get(key);
    if (!ref) {
      ref = (el) => {
        if (el) into.set(id, el);
        else into.delete(id);
      };
      refs.current.set(key, ref);
    }
    return ref;
  }, []);
  return {
    cursorRef: (id: string) => refFor(cursors.current, `cursor:${id}`, id),
    labelRef: (id: string) => refFor(labels.current, `label:${id}`, id),
  };
}
