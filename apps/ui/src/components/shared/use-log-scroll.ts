import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  matchingRowIndex,
  type SessionLogView,
  type StreamRow,
} from "@/components/shared/session-log-messages";

/** Above this many rows, the log renders through the virtualizer. */
const VIRTUALIZE_THRESHOLD = 120;

/** How close (px) the last row must be to the visible bottom to count as "at the end". */
const AT_END_PX = 72;

/** Page mode, virtualized: how long (ms) the jump to the end glides before it snaps. */
const GLIDE_MAX_MS = 900;

/**
 * Page mode: where the log sits in the caller's scroller, in px. `listTop` is
 * the rows' offset inside the scroll content (the virtualizer's
 * `scrollMargin`). The sticky parts read the other heights.
 */
interface PageBox {
  listTop: number;
  viewportH: number;
  toolbarH: number;
  tailH: number;
}

const EMPTY_PAGE_BOX: PageBox = { listTop: 0, viewportH: 0, toolbarH: 0, tailH: 0 };

function samePageBox(a: PageBox, b: PageBox): boolean {
  return (
    a.listTop === b.listTop &&
    a.viewportH === b.viewportH &&
    a.toolbarH === b.toolbarH &&
    a.tailH === b.tailH
  );
}

interface LogScrollOptions {
  /**
   * Page mode: the caller's scroll container, or `null` while it mounts.
   * `undefined`: the viewer scrolls the log itself (`parentRef`).
   */
  scrollElement: HTMLElement | null | undefined;
  /** The rows that show, in order (after the view and the filter). */
  rows: StreamRow[];
  /** The virtualizer's height guess for the row at an index. */
  estimateSize: (index: number) => number;
  isRunning?: boolean;
  view: SessionLogView;
  /** The filter text. A new filter, like a view switch, resets the "N new" count. */
  query: string;
  onViewChange?: (view: SessionLogView) => void;
}

/**
 * The session log's scroll plumbing, for both scroller kinds (the viewer's
 * own, or the caller's in page mode): the virtualizer, at-end detection and
 * follow mode, the "N new" pill count, jumps, the view-switch anchoring, and
 * the CSS variables the sticky parts read. The viewer renders the rows and
 * attaches the returned refs.
 */
export function useLogScroll({
  scrollElement,
  rows,
  estimateSize,
  isRunning,
  view,
  query,
  onViewChange,
}: LogScrollOptions) {
  // Fixed for the viewer's lifetime: callers pass `scrollElement` from the
  // first render (as `null` until the element mounts) or never.
  const pageMode = scrollElement !== undefined;
  const virtualize = rows.length > VIRTUALIZE_THRESHOLD;

  const parentRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const tailRef = useRef<HTMLDivElement | null>(null);
  // `atBottomRef` is follow mode; `atBottom` hides the jump pill. Page mode
  // starts away from the end: the page opens at its top.
  const [atBottom, setAtBottom] = useState(!pageMode);
  const atBottomRef = useRef(!pageMode);
  const [pending, setPending] = useState(0);
  const prevCount = useRef(0);
  const didInit = useRef(false);
  // Page mode only: whether the rows are inside the scroller's view, and
  // where the log sits in the scroller.
  const [logInView, setLogInView] = useState(false);
  const [pageBox, setPageBox] = useState<PageBox>(EMPTY_PAGE_BOX);
  // Page mode, live task: the queued steering and the footer stick to the
  // bottom of the view.
  const stickyTail = pageMode && isRunning === true;

  const getScroller = useCallback(
    () => (pageMode ? (scrollElement ?? null) : parentRef.current),
    [pageMode, scrollElement],
  );

  // Page mode: "at the end" means the last row is within AT_END_PX of the
  // visible bottom, which is the scroller's bottom edge or the top of the
  // stuck footer. `null` while the log is not laid out (a hidden layout tree,
  // the Agents view).
  const readPageGeometry = useCallback(() => {
    const content = contentRef.current;
    if (!scrollElement || !content || content.getClientRects().length === 0) return null;
    const view = scrollElement.getBoundingClientRect();
    const rows = content.getBoundingClientRect();
    const tailTop = tailRef.current?.getBoundingClientRect().top ?? view.bottom;
    const visibleBottom = Math.min(view.bottom, tailTop);
    return {
      atEnd: rows.bottom - visibleBottom < AT_END_PX,
      inView: rows.top < visibleBottom,
      box: {
        listTop: Math.round(
          rows.top - view.top - scrollElement.clientTop + scrollElement.scrollTop,
        ),
        viewportH: scrollElement.clientHeight,
        toolbarH: toolbarRef.current?.offsetHeight ?? 0,
        tailH: tailRef.current?.offsetHeight ?? 0,
      },
    };
  }, [scrollElement]);

  const virtualizer = useVirtualizer({
    count: virtualize ? rows.length : 0,
    getScrollElement: getScroller,
    estimateSize,
    overscan: 14,
    getItemKey: (i) => rows[i]?.id ?? i,
    // Page mode: the rows start below the hero and the outcome. Rows
    // translate by `start - scrollMargin`.
    scrollMargin: pageMode ? pageBox.listTop : 0,
  });

  useEffect(() => {
    const el = getScroller();
    if (!el) return;
    const onScroll = () => {
      const geometry = pageMode ? readPageGeometry() : null;
      if (pageMode && !geometry) return;
      if (geometry) setLogInView(geometry.inView);
      const ab = geometry
        ? geometry.atEnd
        : el.scrollHeight - el.scrollTop - el.clientHeight < AT_END_PX;
      atBottomRef.current = ab;
      setAtBottom(ab);
      if (ab) setPending(0);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    // Don't compute atBottom synchronously here: on first mount scrollTop is 0
    // while content overflows, which would latch "not at bottom" and defeat the
    // initial pin below. The pin establishes the at-bottom state; real scroll
    // events take over from there.
    return () => el.removeEventListener("scroll", onScroll);
  }, [getScroller, pageMode, readPageGeometry]);

  // Page mode: measure where the log sits whenever the scroller or anything
  // in it resizes. Content above the log (hero, outcome, attachments) changes
  // height, so observe the scroller's children, not only the log.
  useLayoutEffect(() => {
    if (!pageMode || !scrollElement || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const geometry = readPageGeometry();
      if (!geometry) return;
      setPageBox((prev) => (samePageBox(prev, geometry.box) ? prev : geometry.box));
      setLogInView(geometry.inView);
      // A resize can bring the end into view and hide the pill. Only a scroll
      // starts or stops follow mode, so content that settles after the page
      // opens never pins it to the bottom.
      setAtBottom(atBottomRef.current || geometry.atEnd);
      if (geometry.atEnd) setPending(0);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(scrollElement);
    for (const child of scrollElement.children) ro.observe(child);
    if (toolbarRef.current) ro.observe(toolbarRef.current);
    if (tailRef.current) ro.observe(tailRef.current);
    measure();
    return () => ro.disconnect();
  }, [pageMode, scrollElement, readPageGeometry]);

  // The instant jump to the end. In virtualized mode getTotalSize() is an
  // estimate until rows measure, so a bare scrollTop can undershoot the real
  // bottom. scrollToIndex forces the tail to render + measure; the scrollTop
  // assignment then lands flush.
  const snapToEnd = useCallback(() => {
    const el = getScroller();
    if (!el) return;
    if (virtualize && rows.length > 0) {
      virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    }
    el.scrollTop = el.scrollHeight;
    setPending(0);
  }, [getScroller, virtualize, virtualizer, rows.length]);

  // Page mode, virtualized: ends a jump glide that has not landed in time.
  const landingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (landingTimer.current) clearTimeout(landingTimer.current);
    },
    [],
  );

  const stickToBottom = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const el = getScroller();
      if (!el) return;
      // User-initiated jumps glide; the auto-follow callers stay instant (they
      // fire per content-growth frame, and animating those would fight the
      // stream). Reduced motion keeps everything instant.
      if (
        behavior === "smooth" &&
        !(
          typeof window !== "undefined" &&
          window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        )
      ) {
        if (pageMode && virtualize && rows.length > 0) {
          // Page mode opens at the top, so the rows on the way down were
          // never measured, and their size fixes stop a plain glide short.
          // The virtualizer's own glide aims again as those rows measure.
          // Each new aim restarts the glide, so it crawls the last screens
          // for seconds, and it gives up after 5 s (a hidden tab never runs
          // it). After GLIDE_MAX_MS the instant snap lands it, and its scroll
          // event turns follow mode on.
          virtualizer.scrollToIndex(rows.length - 1, { align: "end", behavior: "smooth" });
          if (landingTimer.current) clearTimeout(landingTimer.current);
          landingTimer.current = setTimeout(() => {
            landingTimer.current = null;
            if (!atBottomRef.current) snapToEnd();
          }, GLIDE_MAX_MS);
        } else {
          // No instant scrollToIndex first: it snaps and defeats the glide.
          // The estimate can undershoot in virtualized mode; once the scroll
          // lands, the keep-pinned effect snaps the last few px after the
          // tail rows measure.
          el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        }
        setPending(0);
        return;
      }
      snapToEnd();
    },
    [getScroller, pageMode, virtualize, virtualizer, rows.length, snapToEnd],
  );

  // Keep pinned to the bottom as content grows/measures (only when already there).
  const totalSize = virtualize ? virtualizer.getTotalSize() : 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: totalSize + rows.length are intentional re-stick triggers: the effect reacts to content growth without reading them in the body.
  useEffect(() => {
    if (atBottomRef.current) requestAnimationFrame(() => stickToBottom());
  }, [totalSize, rows.length, stickToBottom]);

  // Land at the newest event when the viewer first populates, and re-pin across
  // a few frames while async content (virtualizer measurement, Streamdown,
  // fonts) settles. Conventional log/chat behavior: opening a task drops you at
  // the bottom whether the agent is still streaming or already finished. This fixes
  // both "doesn't auto-follow on open" and "completed task opens at the top".
  // Page mode skips it: the page opens at its top, with the hero and the
  // answer in view.
  const didInitialPin = useRef(false);
  const hasRows = rows.length > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot on first content; intentionally re-pins across frames without re-subscribing.
  useLayoutEffect(() => {
    if (pageMode || didInitialPin.current || !hasRows) return;
    didInitialPin.current = true;
    atBottomRef.current = true;
    setAtBottom(true);
    const lastIndex = rows.length - 1;
    const landAtBottom = () => {
      const el = parentRef.current;
      if (!el) return;
      if (virtualize && lastIndex >= 0) {
        virtualizer.scrollToIndex(lastIndex, { align: "end" });
      }
      el.scrollTop = el.scrollHeight;
    };
    landAtBottom();
    let frame = 0;
    let raf = requestAnimationFrame(function settle() {
      landAtBottom();
      if (++frame < 12) raf = requestAnimationFrame(settle);
    });
    return () => cancelAnimationFrame(raf);
  }, [hasRows]);

  // Re-pin to the bottom whenever the content grows while we're in follow mode.
  // The growth-stick effect above only reacts to row-count / virtualizer-total
  // changes; it misses a row whose own height grows after it's added (streaming
  // text, async markdown + Prism layout). Observing the content box catches all
  // of those, and this is what actually keeps the log auto-following.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) stickToBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [stickToBottom]);

  // Track newly-appended events for the "N new" pill when scrolled up. A view
  // switch or a new filter changes the row count with no new event: it only
  // sets a new baseline.
  const rowSetKey = `${view}\n${query}`;
  const prevRowSetKey = useRef(rowSetKey);
  useEffect(() => {
    const cur = rows.length;
    if (!didInit.current || prevRowSetKey.current !== rowSetKey) {
      if (didInit.current) setPending(0);
      didInit.current = true;
      prevRowSetKey.current = rowSetKey;
      prevCount.current = cur;
      return;
    }
    // Read the count now: React can run the updater after the ref below moves.
    const added = cur - prevCount.current;
    if (added > 0 && !atBottomRef.current) setPending((p) => p + added);
    prevCount.current = cur;
  }, [rows.length, rowSetKey]);

  // A view switch keeps the reader's place:
  // - The start of the log in view: nothing moves. An end that showed only
  //   because the log is short does not pin the new view to its end.
  // - Scrolled to the end of the log: the keep-pinned effect above keeps the
  //   end in view.
  // - Scrolled into the log: the first row that shows (the anchor) is found
  //   in the new view (the same message, or the line that folds it) and kept
  //   at the same height. A row the new view does not have (a filter hides
  //   it) shows the new view from its first row.
  // The browser's own scroll anchoring is off for the switch: rows are not
  // anchor candidates, so it anchors on a node under the log and scrolls
  // the page by the change in the log's height.
  const switchPlan = useRef<
    | { kind: "keep"; scrollTop: number }
    | { kind: "anchor"; id: string | null; top: number; edge: number }
    | null
  >(null);
  const changeView = useCallback(
    (next: SessionLogView) => {
      // The switch fires again on the selected option.
      if (next === view || !onViewChange) return;
      switchPlan.current = null;
      const el = getScroller();
      const content = contentRef.current;
      if (el && content && content.getClientRects().length > 0) {
        el.style.overflowAnchor = "none";
        // Page mode: the rows show under the toolbar. Own scroller: under its top.
        const edge = pageMode
          ? (toolbarRef.current?.getBoundingClientRect().bottom ?? 0)
          : el.getBoundingClientRect().top + el.clientTop;
        if (content.getBoundingClientRect().top >= edge) {
          atBottomRef.current = false;
          switchPlan.current = { kind: "keep", scrollTop: el.scrollTop };
        } else if (!atBottomRef.current) {
          const anchor = [...content.querySelectorAll<HTMLElement>("[data-row-id]")].find(
            (row) => row.getBoundingClientRect().bottom > edge + 1,
          );
          switchPlan.current = {
            kind: "anchor",
            id: anchor?.dataset.rowId ?? null,
            top: anchor?.getBoundingClientRect().top ?? edge,
            edge,
          };
        }
      }
      onViewChange(next);
    },
    [view, onViewChange, getScroller, pageMode],
  );
  const shownView = useRef(view);
  useLayoutEffect(() => {
    if (shownView.current === view) return;
    shownView.current = view;
    const plan = switchPlan.current;
    switchPlan.current = null;
    const el = getScroller();
    const content = contentRef.current;
    if (!el) return;
    // Back on after the next frame: the browser applies its anchoring at the
    // frame's layout, after this frame's callbacks. Later height changes
    // above the log keep the browser's anchoring.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        el.style.overflowAnchor = "";
      }),
    );
    if (plan?.kind === "keep") {
      el.scrollTop = plan.scrollTop;
      return;
    }
    if (!content || !plan) return;
    const index = plan.id ? matchingRowIndex(rows, plan.id) : -1;
    const row = rows[index];
    // The same row keeps its exact height. A folding line or another row
    // starts at the edge at the lowest, so it does not hide under the toolbar.
    const targetTop = !row
      ? plan.edge
      : row.id === plan.id
        ? plan.top
        : Math.max(plan.top, plan.edge);
    let rowTop: number | undefined;
    if (!row) {
      rowTop = content.getBoundingClientRect().top;
    } else if (virtualize) {
      // Not rendered yet: its place comes from the virtualizer. The rows
      // that rendered at the old offset measured on commit, which moved the
      // starts: `getTotalSize` refreshes them before the read. Not
      // `getOffsetForIndex`: it reads the same cache without the refresh and
      // clamps to the scroll range, which moves a row in the last screen.
      virtualizer.getTotalSize();
      const item = virtualizer.measurementsCache[index];
      if (item) rowTop = el.getBoundingClientRect().top + el.clientTop + item.start - el.scrollTop;
    } else {
      rowTop = content
        .querySelector(`[data-row-id="${CSS.escape(row.id)}"]`)
        ?.getBoundingClientRect().top;
    }
    if (rowTop !== undefined) el.scrollTop = Math.max(0, el.scrollTop + rowTop - targetTop);
  }, [view, getScroller, rows, virtualize, virtualizer]);

  // A minimap jump: the row lands centered.
  const scrollToRow = useCallback(
    (index: number, id: string) => {
      if (virtualize) {
        virtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
      } else {
        parentRef.current
          ?.querySelector(`[data-row-id="${id}"]`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    },
    [virtualize, virtualizer],
  );

  // Page mode: the card is at least as tall as the view under the caller's
  // sticky bars, so a filter that empties the log does not move the toolbar.
  // The minimap and the jump pill read the toolbar and stuck-footer heights.
  const pageStyle = pageMode
    ? ({
        minHeight: `calc(${pageBox.viewportH}px - var(--log-sticky-top, 0px) - var(--log-sticky-bottom, 0px))`,
        "--log-toolbar-h": `${pageBox.toolbarH}px`,
        "--log-tail-h": stickyTail ? `${pageBox.tailH}px` : "0px",
      } as CSSProperties)
    : undefined;
  const minimapStickyHeight = pageMode
    ? `calc(${pageBox.viewportH}px - var(--log-sticky-top, 0px) - var(--log-toolbar-h, 0px) - var(--log-sticky-bottom, 0px) - var(--log-tail-h, 0px))`
    : undefined;

  // Page mode shows the pill only while the rows are in view.
  const showJumpPill = !atBottom && (!pageMode || logInView);

  return {
    pageMode,
    virtualize,
    virtualizer,
    parentRef,
    contentRef,
    toolbarRef,
    tailRef,
    /** Follow mode, read during render (row highlight, stagger). */
    atBottomRef,
    stickyTail,
    pending,
    showJumpPill,
    stickToBottom,
    changeView,
    scrollToRow,
    pageStyle,
    minimapStickyHeight,
  };
}
