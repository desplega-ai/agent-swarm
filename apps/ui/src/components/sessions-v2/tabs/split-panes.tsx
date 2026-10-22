/**
 * The pane area (plan Phase 8, SPEC R2.9): the main pane with its tabs, and
 * one split pane beside it. The split opens with `v`, the row menu, Cmd+K,
 * the Columns2 button, or by dragging a session tab to the right edge
 * (as in the mockup). The split pane holds one session tab or the New
 * session tab. Its close button returns to one pane.
 *
 * The active pane holds the pane keys and the amber bar on its focused tab.
 * A press or a focus inside a pane makes it active.
 */

import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  pointerWithin,
  useDroppable,
} from "@dnd-kit/core";
import { Columns2 } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { focusQuietly, useQuietTooltip } from "../pane/quiet-focus";
import { TipKey } from "../sidebar/tree-row";
import { SILENT_DRAG_ACCESSIBILITY, useMouseDragSensors } from "../sidebar/use-row-drag";
import { type TabDragData, TabStrip } from "./tab-strip";

/** 0: the main pane. 1: the split pane. */
export type PaneIndex = 0 | 1;

const SPLIT_ZONE = "split-zone";

/**
 * The right half of the pane area under the tab strips, while a tab drags.
 * Over it, it shows where the tab lands. The label sits near the top, clear
 * of the dragged tab under the pointer.
 */
function SplitDropZone() {
  const { setNodeRef, isOver } = useDroppable({ id: SPLIT_ZONE });
  return (
    <div
      ref={setNodeRef}
      aria-hidden
      className="pointer-events-none absolute top-10 right-0 bottom-0 z-20 w-1/2 p-1.5"
    >
      <div
        className={cn(
          "flex size-full justify-center rounded-lg border-2 border-dashed border-primary/60 bg-primary/10 pt-10 opacity-0 transition-opacity duration-150 ease-snappy",
          isOver && "opacity-100",
        )}
      >
        <span className="h-fit rounded-full border border-border bg-card px-3 py-1.5 text-data font-semibold shadow-sm">
          Drop to open in split
        </span>
      </div>
    </div>
  );
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
  view,
  activePane,
  onActivatePane,
  onFocusTab,
  onCloseTab,
  onNewSession,
  onPickSplit,
  onCloseSplit,
  onDropToSplit,
  renderPane,
}: {
  tabs: string[];
  focused: string;
  split: string | null;
  view: string | null;
  activePane: PaneIndex;
  onActivatePane: (pane: PaneIndex) => void;
  onFocusTab: (tab: string) => void;
  onCloseTab: (tab: string) => void;
  onNewSession: () => void;
  /** The Columns2 button with no split: pick a session for it. */
  onPickSplit: () => void;
  /** `keep`: the split session goes back to the main pane as a tab. */
  onCloseSplit: (keep: boolean) => void;
  /** A main tab dropped on the right edge. */
  onDropToSplit: (tab: string) => void;
  /** The body of a pane: the main pane's focused tab, or the split session. */
  renderPane: (tab: string, pane: PaneIndex) => ReactNode;
}) {
  const main = usePaneIds();
  const side = usePaneIds();
  const sensors = useMouseDragSensors();
  const mainRef = useRef<HTMLElement>(null);
  const [dragging, setDragging] = useState<TabDragData | null>(null);
  const onDragStart = (event: DragStartEvent) =>
    setDragging((event.active.data.current as TabDragData | undefined) ?? null);
  const onDragEnd = (event: DragEndEvent) => {
    if (dragging && event.over?.id === SPLIT_ZONE) onDropToSplit(dragging.tab);
    setDragging(null);
  };
  const two = split !== null;
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
          "Split view · On. Click to close it."
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
      collisionDetection={pointerWithin}
      accessibility={SILENT_DRAG_ACCESSIBILITY}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <section
          ref={mainRef}
          aria-label={two ? "Main pane" : "Open sessions"}
          onPointerDownCapture={() => onActivatePane(0)}
          onFocusCapture={() => onActivatePane(0)}
          className="flex min-h-0 min-w-0 flex-1 basis-0 flex-col"
        >
          <TabStrip
            tabs={tabs}
            selected={focused}
            view={view}
            label="Tabs"
            panelId={main.panelId}
            tabId={main.tabId}
            paneActive={activePane === 0}
            draggable
            onFocusTab={onFocusTab}
            onCloseTab={onCloseTab}
            onNewSession={onNewSession}
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
        </section>
        {split ? (
          <section
            aria-label="Split pane"
            onPointerDownCapture={() => onActivatePane(1)}
            onFocusCapture={() => onActivatePane(1)}
            // No split on a phone (SPEC R8.5).
            className="flex min-h-0 min-w-0 flex-1 basis-0 flex-col border-l border-border max-md:hidden"
          >
            <TabStrip
              tabs={[split]}
              selected={split}
              view={view}
              label="Split pane tabs"
              panelId={side.panelId}
              tabId={side.tabId}
              paneActive={activePane === 1}
              draggable={false}
              onFocusTab={() => onActivatePane(1)}
              onCloseTab={() => {
                // The split pane goes: its focus moves to the main pane's tab, with no tooltip.
                focusQuietly(
                  mainRef.current?.querySelector<HTMLElement>("[role=tab][aria-selected=true]"),
                );
                onCloseSplit(false);
              }}
            />
            <div
              role="tabpanel"
              id={side.panelId}
              aria-labelledby={side.tabId(split)}
              className="flex min-h-0 flex-1 flex-col"
            >
              {renderPane(split, 1)}
            </div>
          </section>
        ) : null}
        {dragging ? <SplitDropZone /> : null}
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
