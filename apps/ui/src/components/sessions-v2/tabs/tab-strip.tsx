/**
 * The tab strip of a pane (plan Phase 8, SPEC R2, R9, R10.3). Each tab has a
 * read mark, an ellipsis title, an activity mark, and a close button. A
 * click focuses a tab, and so does Enter or Space after the arrow keys move
 * the focus along the strip. Delete, Backspace, and a middle-click close a
 * tab. A vertical wheel scrolls an overflowing strip sideways.
 *
 * Overflow (R9): the strip keeps its scroll, reveals the focused tab at the
 * nearest edge, fades at an edge while more tabs sit past it, and shows the
 * "All tabs" menu. Session tabs of the main pane drag to the right edge to
 * open in the split (`split-panes.tsx`).
 */

import { useDraggable } from "@dnd-kit/core";
import { Plus, X } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isSessionTab, NEW_SESSION_TAB } from "@/lib/sessions-v2";
import { cn } from "@/lib/utils";
import { useQuietTooltip } from "../pane/quiet-focus";
import { ReadMark, TipKey, UNREAD_TITLE } from "../sidebar/tree-row";
import { AllTabsMenu } from "./all-tabs-menu";
import { TabActivity, TabIcon, tabLabel, useTabInfo } from "./tab-info";

/** The drag data of a tab (the split drop zone reads it). */
export interface TabDragData {
  tab: string;
  title: string;
}

function TabItem({
  tab,
  view,
  id,
  panelId,
  selected,
  paneActive,
  draggable,
  onFocusTab,
  onCloseTab,
  onCloseKey,
}: {
  tab: string;
  view: string | null;
  id: string;
  panelId: string;
  selected: boolean;
  /** The pane holds the keys: its focused tab gets the amber bar. */
  paneActive: boolean;
  /** The tab drags to the split drop zone. */
  draggable: boolean;
  onFocusTab: (tab: string) => void;
  onCloseTab: (tab: string) => void;
  /** Delete or Backspace on the tab: closes it and keeps the focus in the strip. */
  onCloseKey: (tab: string) => void;
}) {
  // The focused tab's pane polls the session already: the tab adds no timer of its own.
  const info = useTabInfo(tab, view, selected ? "off" : "background");
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: `tab:${id}`,
    disabled: !draggable,
    data: { tab, title: info.title } satisfies TabDragData,
  });
  // The tab's tooltip stays shut over its close button (that one has its own)
  // and on a quiet focus (the focus coming back after the split closes).
  const tip = useQuietTooltip();
  const [overClose, setOverClose] = useState(false);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") onFocusTab(tab);
    else if (event.key === "Delete" || event.key === "Backspace") onCloseKey(tab);
    else return;
    event.preventDefault();
  };

  return (
    <Tooltip open={tip.open && !overClose} onOpenChange={tip.onOpenChange}>
      <TooltipTrigger asChild>
        <div
          ref={setNodeRef}
          {...listeners}
          role="tab"
          id={id}
          tabIndex={selected ? 0 : -1}
          aria-selected={selected}
          aria-controls={selected ? panelId : undefined}
          aria-label={tabLabel(info)}
          aria-keyshortcuts="Delete Backspace"
          data-selected={selected ? "" : undefined}
          data-pane-active={paneActive ? "" : undefined}
          onClick={() => onFocusTab(tab)}
          onKeyDown={onKeyDown}
          onAuxClick={(event) => {
            if (event.button !== 1) return;
            event.preventDefault();
            onCloseTab(tab);
          }}
          // No transitions: a tab changes at once, by pointer or by key (DESIGN.md frequency rule).
          className={cn(
            "group/tab relative flex h-10 max-w-60 min-w-36 shrink grow-0 basis-auto items-center gap-1.5 border-r border-border-subtle pr-1.5 pl-2.5 text-xs text-muted-foreground outline-none select-none",
            "hover:bg-accent/70 hover:text-foreground",
            "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
            // The focused tab joins the pane below it: no bottom line, and a 2 px bar on top.
            "data-selected:bg-background data-selected:text-foreground",
            "data-selected:after:absolute data-selected:after:inset-x-0 data-selected:after:-bottom-px data-selected:after:h-px data-selected:after:bg-background",
            "data-selected:before:absolute data-selected:before:inset-x-0 data-selected:before:top-0 data-selected:before:h-0.5 data-selected:before:bg-border",
            "data-pane-active:data-selected:before:bg-primary",
            // "New session" is short and fixed: it keeps its whole label (UX review R9).
            tab === NEW_SESSION_TAB && "shrink-0",
            isDragging && "opacity-50",
          )}
        >
          <ReadMark unread={info.unread} />
          <TabIcon info={info} />
          <span className={cn("min-w-0 flex-1 truncate", info.unread && UNREAD_TITLE)}>
            {info.title}
          </span>
          <TabActivity activity={info.activity} />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                tabIndex={-1}
                aria-label={`Close tab ${info.title}`}
                onPointerEnter={() => setOverClose(true)}
                onPointerLeave={() => setOverClose(false)}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(tab);
                }}
                className={cn(
                  "grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground opacity-0",
                  "hover:bg-muted-foreground/20 hover:text-foreground group-hover/tab:opacity-100",
                  "group-data-selected/tab:opacity-100 group-focus-visible/tab:opacity-100",
                )}
              >
                <X className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Close tab</TooltipContent>
          </Tooltip>
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm wrap-anywhere">{info.tip}</TooltipContent>
    </Tooltip>
  );
}

/** Which edges have more tabs past them, and whether the strip overflows at all. */
interface Overflow {
  left: boolean;
  right: boolean;
  any: boolean;
}

const NO_OVERFLOW: Overflow = { left: false, right: false, any: false };

/** A 16 px fade on each edge with more tabs past it (R9). */
function fadeMask({ left, right }: Overflow): CSSProperties | undefined {
  if (!left && !right) return undefined;
  const from = left ? "transparent, black 16px" : "black";
  const to = right ? "black calc(100% - 16px), transparent" : "black";
  const image = `linear-gradient(to right, ${from}, ${to})`;
  return { maskImage: image, WebkitMaskImage: image };
}

export function TabStrip({
  tabs,
  selected,
  view,
  label,
  panelId,
  tabId,
  paneActive,
  draggable,
  onFocusTab,
  onCloseTab,
  onNewSession,
  actions,
}: {
  tabs: string[];
  /** The focused tab of this pane. */
  selected: string;
  /** The group tab's list. */
  view: string | null;
  /** The tab list's name. */
  label: string;
  /** The id of the pane body (the tab panel). */
  panelId: string;
  /** The DOM id of a tab. Unique per pane, so two panes can show the same session. */
  tabId: (tab: string) => string;
  paneActive: boolean;
  /** Session tabs drag to the split drop zone. */
  draggable: boolean;
  onFocusTab: (tab: string) => void;
  onCloseTab: (tab: string) => void;
  /** "+": a New session tab. Off for the split pane. */
  onNewSession?: () => void;
  /** Pane buttons on the right of the strip. */
  actions?: ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState<Overflow>(NO_OVERFLOW);
  // A tab closed with Delete: the focus goes to the focused tab once the strip updates.
  const refocus = useRef(false);
  const closeFromKeys = useCallback(
    (tab: string) => {
      refocus.current = true;
      onCloseTab(tab);
    },
    [onCloseTab],
  );
  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const any = list.scrollWidth > list.clientWidth + 1;
    const next = {
      any,
      left: any && list.scrollLeft > 1,
      right: any && list.scrollLeft < list.scrollWidth - list.clientWidth - 1,
    };
    setOverflow((prev) =>
      prev.any === next.any && prev.left === next.left && prev.right === next.right ? prev : next,
    );
  }, []);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [measure]);

  // The strip hides its scrollbar, so a mostly vertical wheel scrolls it
  // sideways while it overflows. At an end, or with no overflow, the wheel
  // goes on to the page. A native listener: React's wheel listener is passive.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const max = list.scrollWidth - list.clientWidth;
      if (max <= 1) return;
      // A wheel in lines (deltaMode 1) moves about one line height per step.
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const next = Math.min(max, Math.max(0, list.scrollLeft + delta));
      if (next === list.scrollLeft) return;
      event.preventDefault();
      list.scrollLeft = next;
    };
    list.addEventListener("wheel", onWheel, { passive: false });
    return () => list.removeEventListener("wheel", onWheel);
  }, []);

  // A newly focused tab scrolls into view at the nearest edge. Other renders keep the scroll.
  const tabsKey = tabs.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: it reads the DOM; a new focus or a new tab list re-runs it
  useLayoutEffect(() => {
    const list = listRef.current;
    const tab = list?.querySelector<HTMLElement>("[role=tab][aria-selected=true]");
    if (list && tab) {
      const lr = list.getBoundingClientRect();
      const tr = tab.getBoundingClientRect();
      if (tr.left < lr.left) list.scrollLeft -= lr.left - tr.left;
      else if (tr.right > lr.right) list.scrollLeft += tr.right - lr.right;
      if (refocus.current) tab.focus();
    }
    refocus.current = false;
    measure();
  }, [selected, tabsKey, measure]);

  /** The arrow keys, Home, and End move the focus along the strip. Enter or Space then opens the tab. */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = [...(listRef.current?.querySelectorAll<HTMLElement>("[role=tab]") ?? [])];
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (at < 0 || event.altKey || event.ctrlKey || event.metaKey) return;
    const to =
      event.key === "ArrowRight"
        ? (at + 1) % all.length
        : event.key === "ArrowLeft"
          ? (at - 1 + all.length) % all.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? all.length - 1
              : -1;
    if (to < 0) return;
    event.preventDefault();
    all[to]?.focus();
    all[to]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  return (
    // No tabs on a phone (SPEC R8.5). The phone layout lands in Phase 9.
    <div className="flex h-10 min-w-0 shrink-0 items-stretch border-b border-border bg-surface max-md:hidden">
      <div className="flex min-w-0 flex-1 items-stretch">
        <div
          ref={listRef}
          role="tablist"
          aria-label={label}
          onScroll={measure}
          onKeyDown={onKeyDown}
          style={fadeMask(overflow)}
          className="flex min-w-0 shrink grow-0 basis-auto items-stretch overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {tabs.map((tab) => (
            <TabItem
              key={tab}
              tab={tab}
              view={view}
              id={tabId(tab)}
              panelId={panelId}
              selected={tab === selected}
              paneActive={paneActive}
              draggable={draggable && isSessionTab(tab)}
              onFocusTab={onFocusTab}
              onCloseTab={onCloseTab}
              onCloseKey={closeFromKeys}
            />
          ))}
        </div>
        {overflow.any ? (
          <AllTabsMenu tabs={tabs} selected={selected} view={view} onFocusTab={onFocusTab} />
        ) : null}
        {onNewSession ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="New session"
                aria-keyshortcuts="c"
                onClick={onNewSession}
                className="mx-1 size-7 self-center text-muted-foreground hover:text-foreground"
              >
                <Plus className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent className="flex items-center gap-1.5">
              New session
              <TipKey>C</TipKey>
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-px border-l border-border-subtle px-1.5">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
