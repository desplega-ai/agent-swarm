/**
 * Sessions v2 shell: a resizable sidebar frame next to the pane area. It
 * collapses the global nav to icons while it is open, so the sidebar and the
 * panes keep their width (UX review R9).
 *
 * The sidebar holds the session tree (Phase 4). The pane shows the New
 * session composer on `/sessions` (it keeps the `?seed=` and `?prefill=`
 * links working) and today's conversation on `/sessions/:rootTaskId`, until
 * Phases 5 to 7 replace them.
 */

import { History } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { NewSessionView } from "@/components/sessions/new-session-view";
import { Button } from "@/components/ui/button";
import { useCollapseNavWhile } from "@/hooks/use-collapse-nav-while";
import type { SessionsViewMode } from "@/hooks/use-sessions-view";
import { MAIN_BLEED } from "@/lib/main-gutter";
import { NEW_SESSION_TAB } from "@/lib/sessions-v2";
import { cn } from "@/lib/utils";
import { SessionPane } from "./pane/session-pane";
import { SessionTree } from "./sidebar/session-tree";
import { useSessionsUrlState } from "./use-sessions-url-state";

const WIDTH_DEFAULT = 320;
const WIDTH_MIN = 260;
const WIDTH_MAX = 520;
const WIDTH_STEP = 16;
const WIDTH_STORAGE_KEY = "agent-swarm-sessions-v2-sidebar-width";

function clampWidth(width: number): number {
  return Math.round(Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, width)));
}

function readWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_STORAGE_KEY));
    return stored > 0 ? clampWidth(stored) : WIDTH_DEFAULT;
  } catch {
    return WIDTH_DEFAULT;
  }
}

/** The sidebar width, stored per browser when a drag or a key press ends. */
function useSidebarWidth() {
  const [width, setWidthState] = useState(readWidth);
  const setWidth = useCallback((next: number, save: boolean) => {
    const clamped = clampWidth(next);
    setWidthState(clamped);
    if (!save) return;
    try {
      localStorage.setItem(WIDTH_STORAGE_KEY, String(clamped));
    } catch {
      // Storage off: the width holds until a reload.
    }
  }, []);
  return [width, setWidth] as const;
}

/**
 * The drag edge of the sidebar. Drag it, or focus it and use the arrow keys.
 * Home and a double-click reset the width. No animation: the width follows
 * the pointer and the keys at once.
 */
function SidebarResizeHandle({
  width,
  onResize,
  sidebarId,
}: {
  width: number;
  onResize: (width: number, save: boolean) => void;
  sidebarId: string;
}) {
  // The width and the pointer at pointer down. The width follows the
  // pointer's travel, so the grab point stays under the pointer, and a click
  // with no travel stores nothing.
  const drag = useRef<{ startX: number; startWidth: number; next: number | null } | null>(null);
  const [dragging, setDragging] = useState(false);

  // The pointer leaves the 8 px handle during a drag: keep the resize cursor
  // and stop text selection on the whole page until it ends.
  useEffect(() => {
    if (!dragging) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [dragging]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width, next: null };
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || event.clientX === current.startX) return;
    current.next = current.startWidth + (event.clientX - current.startX);
    onResize(current.next, false);
  };
  const endDrag = () => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    setDragging(false);
    if (current.next !== null) onResize(current.next, true);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") onResize(width - WIDTH_STEP, true);
    else if (event.key === "ArrowRight") onResize(width + WIDTH_STEP, true);
    else if (event.key === "Home") onResize(WIDTH_DEFAULT, true);
    else return;
    event.preventDefault();
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable splitter is a widget; <hr> is not
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize the sidebar"
      aria-controls={sidebarId}
      aria-valuemin={WIDTH_MIN}
      aria-valuemax={WIDTH_MAX}
      aria-valuenow={width}
      data-dragging={dragging ? "" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => onResize(WIDTH_DEFAULT, true)}
      onKeyDown={onKeyDown}
      className={cn(
        "absolute inset-y-0 -right-1 z-10 hidden w-2 cursor-col-resize touch-none outline-none md:block",
        "after:absolute after:inset-y-0 after:left-[3px] after:w-0.5 after:bg-transparent after:transition-colors after:duration-150 after:ease-snappy",
        "hover:after:bg-primary focus-visible:after:bg-primary data-dragging:after:bg-primary",
      )}
    />
  );
}

export interface SessionsV2ShellProps {
  /** Switch views. The page owns the one `useSessionsView()` instance. */
  onViewChange: (view: SessionsViewMode) => void;
}

export function SessionsV2Shell({ onViewChange }: SessionsV2ShellProps) {
  useCollapseNavWhile(true);
  const { focused, openSession, focusTab, setView } = useSessionsUrlState();
  const [width, setWidth] = useSidebarWidth();
  const sidebarId = useId();

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row", MAIN_BLEED)}>
      <nav
        id={sidebarId}
        aria-label="Sessions"
        style={{ "--sessions-sidebar-w": `${width}px` } as CSSProperties}
        className="relative flex shrink-0 flex-col border-b border-border bg-surface md:w-(--sessions-sidebar-w) md:border-r md:border-b-0"
      >
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border-subtle pr-2 pl-4 max-md:border-b-0">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">Sessions</h2>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => onViewChange("legacy")}
            className="text-muted-foreground hover:text-foreground"
          >
            <History />
            Legacy sessions
          </Button>
        </div>
        {/* The phone layout lands in Phase 9. */}
        <div className="hidden min-h-0 flex-1 flex-col md:flex">
          <SessionTree
            focused={focused}
            openSession={openSession}
            newSession={() => focusTab(NEW_SESSION_TAB)}
            setView={setView}
          />
        </div>
        <SidebarResizeHandle width={width} onResize={setWidth} sidebarId={sidebarId} />
      </nav>

      <section aria-label="Open sessions" className="flex min-h-0 min-w-0 flex-1 flex-col">
        {focused === NEW_SESSION_TAB ? (
          <NewSessionView />
        ) : (
          // A new key per session: the composer draft and the scroll state
          // never carry over to the next session.
          <SessionPane key={focused} rootTaskId={focused} />
        )}
      </section>
    </div>
  );
}
