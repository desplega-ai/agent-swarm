/**
 * The pane area (plan Phase 8, SPEC R2.9): the main pane and one split pane
 * beside it. Each pane is a tab group with its own strip: sessions, the New
 * session tab, and assets (the files, pages, and tasks that links open) sit
 * in one row, as T3 Code mixes chats, files, and the browser. The split
 * opens with `v`, the row menu, Cmd+K, the Columns2 button, a link in a
 * session, or a tab dragged to the right half.
 *
 * A tab drags to a new place in its strip, to the other strip, or onto the
 * other pane. Its move button and its context menu move it to the other
 * pane too. A move adds the tab there: it never takes the place of another
 * tab. The focus follows a tab that changes pane. The edge between the two
 * panes drags, or takes the arrow keys, to resize them. The browser keeps
 * the size as a share of the row.
 *
 * The active pane holds the pane keys and the amber bar on its focused tab.
 * A press or a focus inside a pane makes it active.
 */

import {
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  pointerWithin,
  useDroppable,
} from "@dnd-kit/core";
import { ArrowLeftToLine, ArrowRightToLine, Columns2 } from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ResizeHandle } from "@/components/shared/resize-handle";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useElementWidth } from "@/hooks/use-element-width";
import {
  canSplitTab,
  type PaneIndex,
  SPLIT_DEFAULT_RATIO,
  SPLIT_NEEDS_SECOND_TAB,
  SPLIT_WIDTH_STEP,
  splitLayout,
} from "@/lib/sessions-v2";
import { cn } from "@/lib/utils";
import { focusQuietly, useQuietTooltip } from "../pane/quiet-focus";
import { TipKey } from "../sidebar/tree-row";
import { SILENT_DRAG_ACCESSIBILITY, useMouseDragSensors } from "../sidebar/use-row-drag";
import {
  type TabDragData,
  type TabDropData,
  type TabMove,
  type TabMoveState,
  TabStrip,
} from "./tab-strip";

/**
 * A place in a strip (a tab, then the strip's free end) wins over the pane
 * body under the pointer, so a drop on the strip sets the tab's place.
 */
const tabCollision: CollisionDetection = (args) => {
  const rank = (id: unknown) => {
    const text = String(id);
    return text.startsWith("drop:") ? 0 : text.startsWith("tail:") ? 1 : 2;
  };
  return [...pointerWithin(args)].sort((a, b) => rank(a.id) - rank(b.id));
};

/**
 * A pane's body as a drop target while a tab drags from the other pane, or
 * the right half of the row while there is no split. Over it, it shows
 * where the tab lands. The label sits near the top, clear of the dragged
 * tab under the pointer.
 */
function PaneDropZone({
  pane,
  label,
  className,
}: {
  pane: PaneIndex;
  label: string;
  className: string;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `body:${pane}`,
    data: { pane } satisfies TabDropData,
  });
  return (
    <div
      ref={setNodeRef}
      aria-hidden
      className={cn("pointer-events-none absolute top-9 bottom-0 z-20 p-1.5", className)}
    >
      <div
        className={cn(
          "flex size-full justify-center rounded-lg border-2 border-dashed border-primary/60 bg-primary/10 pt-10 opacity-0 transition-opacity duration-150 ease-snappy",
          isOver && "opacity-100",
        )}
      >
        <span className="h-fit rounded-full border border-border bg-card px-3 py-1.5 text-data font-semibold shadow-sm">
          {label}
        </span>
      </div>
    </div>
  );
}

const RATIO_STORAGE_KEY = "agent-swarm-sessions-v2-split-ratio";

function readRatio(): number | null {
  try {
    const stored = Number(localStorage.getItem(RATIO_STORAGE_KEY));
    return stored > 0 && stored < 1 ? stored : null;
  } catch {
    return null;
  }
}

/** The main pane's share of the split row, stored per browser when a drag or a key press ends. */
function useSplitRatio() {
  const [ratio, setRatioState] = useState(readRatio);
  const setRatio = useCallback((next: number, save: boolean) => {
    setRatioState(next);
    if (!save) return;
    try {
      localStorage.setItem(RATIO_STORAGE_KEY, String(next));
    } catch {
      // Storage off: the size holds until a reload.
    }
  }, []);
  return [ratio, setRatio] as const;
}

/** The DOM ids of one pane: its tabs and its tab panel. `useId` keeps them unique per pane. */
function usePaneIds() {
  const base = useId();
  return {
    panelId: `${base}panel`,
    tabId: (tab: string) => `${base}tab-${encodeURIComponent(tab)}`,
  };
}

export function SplitPanes({
  tabs,
  focused,
  split,
  splitFocused,
  view,
  activePane,
  onActivatePane,
  onFocusTab,
  onCloseTab,
  onNewSession,
  onPickSplit,
  onCloseSplit,
  onMoveTab,
  renderPane,
}: {
  tabs: string[];
  focused: string;
  /** The split pane's tabs. Empty: one pane. */
  split: string[];
  splitFocused: string | null;
  view: string | null;
  activePane: PaneIndex;
  onActivatePane: (pane: PaneIndex) => void;
  onFocusTab: (tab: string, pane: PaneIndex) => void;
  onCloseTab: (tab: string) => void;
  /** "+" in a pane's strip: a New session tab there. */
  onNewSession: (pane: PaneIndex) => void;
  /** The Columns2 button with no split: pick a session for it. */
  onPickSplit: () => void;
  /** `keep`: the split's tabs go back to the main pane. */
  onCloseSplit: (keep: boolean) => void;
  /**
   * Move a tab to a pane: before the tab `before`, last (null), or after the
   * pane's focused tab. False when it cannot move (the shell says why).
   */
  onMoveTab: (tab: string, to: PaneIndex, before?: string | null) => boolean;
  /** The body of a pane: its focused tab. */
  renderPane: (tab: string, pane: PaneIndex) => ReactNode;
}) {
  const main = usePaneIds();
  const side = usePaneIds();
  const sensors = useMouseDragSensors();
  const mainRef = useRef<HTMLElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  const mainId = useId();
  const [dragging, setDragging] = useState<TabDragData | null>(null);
  const two = split.length > 0 && splitFocused !== null;

  // After a move to the other pane, the focus goes to the moved tab there
  // (the tab it left is gone), quietly: no tooltip. Its pane becomes active
  // by that focus. With the two panes joined into one, that is the main pane.
  const focusAfterMove = useRef<PaneIndex | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: it reads the DOM; a new tab list or focus re-runs it
  useLayoutEffect(() => {
    const pane = focusAfterMove.current;
    if (pane === null) return;
    focusAfterMove.current = null;
    const root = (pane === 1 ? sideRef.current : null) ?? mainRef.current;
    focusQuietly(root?.querySelector<HTMLElement>("[role=tab][aria-selected=true]"));
  }, [tabs, focused, split, splitFocused]);
  const move = (tab: string, from: PaneIndex, to: PaneIndex, before?: string | null) => {
    if (onMoveTab(tab, to, before) && from !== to) focusAfterMove.current = to;
  };

  const onDragStart = (event: DragStartEvent) =>
    setDragging((event.active.data.current as TabDragData | undefined) ?? null);
  const onDragEnd = (event: DragEndEvent) => {
    const drop = event.over?.data.current as TabDropData | undefined;
    if (dragging && drop) move(dragging.tab, dragging.pane, drop.pane, drop.before);
    setDragging(null);
  };

  const moveToSplit: TabMove = {
    label: "Move to split pane",
    icon: ArrowRightToLine,
    state: (tab): TabMoveState => {
      if (!canSplitTab(tab)) return "hidden";
      return tabs.length === 1 && !two ? { blocked: SPLIT_NEEDS_SECOND_TAB } : "ready";
    },
    onMove: (tab) => move(tab, 0, 1),
  };
  const moveToMain: TabMove = {
    label: "Move to main pane",
    icon: ArrowLeftToLine,
    state: () => "ready",
    onMove: (tab) => move(tab, 1, 0),
  };

  // The main pane's width while split: a share of the row, kept in bounds.
  const [rowRef, rowWidth] = useElementWidth<HTMLDivElement>();
  const [ratio, setRatio] = useSplitRatio();
  const layout = splitLayout(ratio, rowWidth);
  const onResize = (width: number, save: boolean) => {
    if (!(rowWidth > 0)) return;
    const clamped = Math.min(layout.max, Math.max(layout.min, width));
    setRatio(clamped / rowWidth, save);
  };
  // The picker gives the focus back quietly: no tooltip on that focus.
  const splitTip = useQuietTooltip();

  const splitButton = (
    <Tooltip {...splitTip}>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          // One name; the pressed state says whether the split is open.
          aria-label="Split view"
          aria-pressed={two}
          aria-keyshortcuts={two ? undefined : "v"}
          onClick={() => (two ? onCloseSplit(true) : onPickSplit())}
          className="size-7 text-muted-foreground hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
        >
          <Columns2 className="size-3.5" />
        </Button>
      </TooltipTrigger>
      {/* The same name as the button, then the state (as Handoffs does). */}
      <TooltipContent className="flex items-center gap-1.5">
        {two ? (
          "Split view · On. Click to join the panes."
        ) : (
          <>
            Split view
            <TipKey>V</TipKey>
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={tabCollision}
      accessibility={SILENT_DRAG_ACCESSIBILITY}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <div ref={rowRef} className="relative flex min-h-0 min-w-0 flex-1">
        <section
          ref={mainRef}
          id={mainId}
          aria-label={two ? "Main pane" : "Open sessions"}
          onPointerDownCapture={() => onActivatePane(0)}
          onFocusCapture={() => onActivatePane(0)}
          style={
            two ? ({ "--split-main-w": `${layout.ratio * 100}%` } as CSSProperties) : undefined
          }
          className={cn(
            "relative flex min-h-0 min-w-0 flex-1 basis-0 flex-col",
            // The stored size applies from md up. A phone has no split (SPEC R8.5).
            two && "md:grow-0 md:basis-(--split-main-w)",
          )}
        >
          <TabStrip
            tabs={tabs}
            selected={focused}
            view={view}
            label="Tabs"
            panelId={main.panelId}
            tabId={main.tabId}
            pane={0}
            paneActive={activePane === 0}
            draggable
            move={moveToSplit}
            onFocusTab={(tab) => onFocusTab(tab, 0)}
            onCloseTab={onCloseTab}
            onNewSession={() => onNewSession(0)}
            actions={splitButton}
          />
          <div
            role="tabpanel"
            id={main.panelId}
            aria-labelledby={main.tabId(focused)}
            className="flex min-h-0 flex-1 flex-col"
          >
            {renderPane(focused, 0)}
          </div>
          {two && dragging?.pane === 1 ? (
            <PaneDropZone pane={0} label="Drop to move here" className="inset-x-0" />
          ) : null}
          {two && rowWidth > 0 ? (
            <ResizeHandle
              edge="right"
              width={layout.width}
              min={layout.min}
              max={layout.max}
              defaultWidth={Math.round(rowWidth * SPLIT_DEFAULT_RATIO)}
              step={SPLIT_WIDTH_STEP}
              onResize={onResize}
              label="Resize the split"
              controls={mainId}
              className="hidden md:block"
            />
          ) : null}
        </section>
        {two ? (
          <section
            ref={sideRef}
            aria-label="Split pane"
            onPointerDownCapture={() => onActivatePane(1)}
            onFocusCapture={() => onActivatePane(1)}
            // No split on a phone (SPEC R8.5).
            className="relative flex min-h-0 min-w-0 flex-1 basis-0 flex-col border-l border-border max-md:hidden"
          >
            <TabStrip
              tabs={split}
              selected={splitFocused}
              view={view}
              label="Split pane tabs"
              panelId={side.panelId}
              tabId={side.tabId}
              pane={1}
              paneActive={activePane === 1}
              draggable
              move={moveToMain}
              onFocusTab={(tab) => onFocusTab(tab, 1)}
              onCloseTab={(tab) => {
                // The split pane goes with its last tab: its focus moves to the main pane's tab, with no tooltip.
                if (split.length === 1) {
                  focusQuietly(
                    mainRef.current?.querySelector<HTMLElement>("[role=tab][aria-selected=true]"),
                  );
                }
                onCloseTab(tab);
              }}
              onNewSession={() => onNewSession(1)}
            />
            <div
              role="tabpanel"
              id={side.panelId}
              aria-labelledby={side.tabId(splitFocused)}
              className="flex min-h-0 flex-1 flex-col"
            >
              {renderPane(splitFocused, 1)}
            </div>
            {dragging?.pane === 0 ? (
              <PaneDropZone pane={1} label="Drop to move here" className="inset-x-0" />
            ) : null}
          </section>
        ) : null}
        {dragging && !two ? (
          <PaneDropZone pane={1} label="Drop to open in split" className="right-0 w-1/2" />
        ) : null}
      </div>
      {createPortal(
        <DragOverlay dropAnimation={null}>
          {dragging ? (
            <div className="flex max-w-60 cursor-grabbing items-center gap-1.5 rounded-md border border-border bg-popover px-2.5 py-1.5 text-data font-medium shadow-md">
              <Columns2 aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">{dragging.title}</span>
            </div>
          ) : null}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}
