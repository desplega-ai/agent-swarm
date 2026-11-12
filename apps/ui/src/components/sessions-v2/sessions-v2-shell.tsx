/**
 * Sessions v2 shell: a resizable sidebar frame next to the pane area, and the
 * status bar under both. It collapses the global nav to icons while it is
 * open, so the sidebar and the panes keep their width (UX review R9).
 *
 * The sidebar holds the search and the session tree (Phases 4 and 5). The
 * pane area (Phase 8) holds the main pane with its tabs and one split pane.
 * A tab shows the New session composer (it keeps the `?seed=` and
 * `?prefill=` links working), the group tab (`?view=`), or a session: the
 * header (Phase 6) over the turn timeline (Phase 7). A use-case group (one
 * with a schedule or files under its key) gets a pinned Overview tab first
 * (step-10), and `?tab=overview|list` picks its face. The first-run guide
 * and the "Open in split…" picker mount here too.
 */

import { History } from "lucide-react";
import { type CSSProperties, useCallback, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { useSession } from "@/api/hooks/use-sessions";
import type { SessionListItem } from "@/api/types";
import { LinkPreviewDock } from "@/components/link-preview/link-preview-dock";
import { ResizeHandle } from "@/components/shared/resize-handle";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useCollapseNavWhile } from "@/hooks/use-collapse-nav-while";
import type { SessionsViewMode } from "@/hooks/use-sessions-view";
import { MAIN_BLEED } from "@/lib/main-gutter";
import { detailGroupKey, GROUP_TAB, isSessionTab, NEW_SESSION_TAB } from "@/lib/sessions-v2";
import { cn } from "@/lib/utils";
import { FirstRunGuide, GUIDE_KEYS_STEP, useFirstRunGuide } from "./first-run-guide";
import { GroupTab } from "./group-tab";
import { NewSessionTab } from "./new-session-tab";
import { GroupPanePending, useGroupPane } from "./overview/group-pane";
import { OverviewTab } from "./overview/overview-tab";
import { SessionPane } from "./pane/session-pane";
import { usePaneKeys } from "./pane/use-pane-keys";
import { SessionTree, type SessionTreeHandle } from "./sidebar/session-tree";
import { StatusBar } from "./status-bar";
import { type PaneIndex, SplitPanes } from "./tabs/split-panes";
import { SplitPicker } from "./tabs/split-picker";
import { useMyGroups } from "./use-my-groups";
import { useSessionsUrlState } from "./use-sessions-url-state";

const WIDTH_DEFAULT = 320;
const WIDTH_MIN = 260;
const WIDTH_MAX = 520;
const WIDTH_STEP = 16;
const WIDTH_STORAGE_KEY = "agent-swarm-sessions-v2-sidebar-width";
/** The room the panes need next to a link preview. */
const PANE_MIN_WIDTH = 400;

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

export interface SessionsV2ShellProps {
  /** Switch views. The page owns the one `useSessionsView()` instance. */
  onViewChange: (view: SessionsViewMode) => void;
}

export function SessionsV2Shell({ onViewChange }: SessionsV2ShellProps) {
  useCollapseNavWhile(true);
  const url = useSessionsUrlState();
  const { focused, tabs, split, view, q, setQuery, focusTab } = url;
  // A use case is one tab: its Overview and its session list are two faces
  // of that tab, switched inside it (`?tab=`), never two strip tabs.
  const groupPane = useGroupPane(view, url.groupPane);
  const focusStripTab = (tab: string) => {
    setActivePane(0);
    focusTab(tab);
  };
  const [width, setWidth] = useSidebarWidth();
  const sidebarId = useId();
  // The pane that holds the pane keys, Cmd+K's session, and sidebar clicks.
  const [paneState, setActivePane] = useState<PaneIndex>(0);
  const activePane: PaneIndex = split ? paneState : 0;
  const current = activePane === 1 && split ? split : focused;
  // The group the New session tab starts in: the one it was opened from.
  const [startIn, setStartIn] = useState<string | null>(null);
  // One New session draft: while the split holds it, "+" and `c` focus it there.
  const newSession = useCallback(
    (group: string | null = null) => {
      setStartIn(group);
      if (split === NEW_SESSION_TAB) {
        setActivePane(1);
        return;
      }
      setActivePane(0);
      focusTab(NEW_SESSION_TAB);
    },
    [focusTab, split],
  );
  // The session whose header title is its rename field (Cmd+K "Rename
  // session", the pencil), in one pane. A switch to another session ends it.
  const [renaming, setRenaming] = useState<{ id: string; pane: PaneIndex } | null>(null);
  // The tree's move dialog and group reveal, for the pane header.
  const treeRef = useRef<SessionTreeHandle>(null);
  const moveSessions = useCallback(
    (sessions: SessionListItem[], returnFocus: () => void) =>
      treeRef.current?.move(sessions, returnFocus),
    [],
  );
  // The session header's group crumb: open the group in its tab, next to
  // the session, and show it in the sidebar tree.
  const { openView } = url;
  const revealGroup = useCallback(
    (groupKey: string | null) => {
      treeRef.current?.revealGroup(groupKey);
      openView(groupKey ?? "nogroup");
    },
    [openView],
  );

  /**
   * Every open goes through here, so one session never mounts in two panes
   * (two panes would poll it twice). The split session gets the focus in its
   * pane. A plain open goes to the active pane, in its current tab (SPEC R2):
   * in the split pane, a session that has a main tab gets the focus there.
   * A new tab opens in the main pane, and so does any open while the split
   * holds the New session tab (its draft stays). A background tab (a middle-click)
   * keeps the focus and does not mark the session read (mockup
   * `index.html:4802-4807`). `pane` names the pane for an open from inside
   * it (the group tab).
   */
  const openSession = (
    id: string,
    options: { newTab?: boolean; background?: boolean; pane?: PaneIndex } = {},
  ) => {
    if (options.background) {
      const open = id === split || tabs.includes(id);
      if (!open) url.openSession(id, { background: true });
      toast(open ? "Already open in a tab." : "Opened in a new tab.");
    } else if (id === split) setActivePane(1);
    else if (options.newTab || (options.pane ?? activePane) === 0 || split === NEW_SESSION_TAB) {
      setActivePane(0);
      url.openSession(id, { newTab: options.newTab });
    } else if (tabs.includes(id)) {
      setActivePane(0);
      focusTab(id);
    } else url.replaceSplit(id);
  };
  const openInSplit = (id: string) => {
    const message = url.openInSplit(id);
    if (message) toast(message);
    else setActivePane(1);
  };
  const closeSplit = (keep: boolean) => {
    setActivePane(0);
    url.closeSplit(keep);
  };
  const [pickingSplit, setPickingSplit] = useState(false);
  const guide = useFirstRunGuide();

  // `v` and `c` away from the sidebar (UX review R9, mockup `paneKey`): the
  // split picker, and a New session tab in the group of the focused pane's
  // session (the rule `c` follows on a session row in the tree).
  const { userId } = useCurrentUser();
  const { targets, writeBlock } = useMyGroups(userId ?? null);
  const currentDetail = useSession(isSessionTab(current) ? current : undefined, {
    poll: "off",
  }).data;
  const startGroupOfPane = (): string | null => {
    const key =
      current === GROUP_TAB ? view : currentDetail ? (detailGroupKey(currentDetail) ?? null) : null;
    return key && targets.some((target) => target.key === key) && !writeBlock(key) ? key : null;
  };
  // A new New session tab in the split starts in the group of the pane's
  // session, as `c` does. A moved one keeps its group.
  const pickSplit = (id: string) => {
    const fresh = id === NEW_SESSION_TAB && split !== id && !tabs.includes(id);
    const group = startGroupOfPane();
    const message = url.openInSplit(id);
    if (message) {
      toast(message);
      return;
    }
    setActivePane(1);
    if (fresh) setStartIn(group);
  };
  usePaneKeys({
    split: () => setPickingSplit(true),
    newSession: () => newSession(startGroupOfPane()),
  });

  const renderPane = (tab: string, pane: PaneIndex) => {
    if (pane === 1) {
      return tab === NEW_SESSION_TAB ? (
        <NewSessionTab startIn={startIn} onStarted={url.replaceSplit} />
      ) : (
        renderSession(tab, 1)
      );
    }
    // The New session tab stays mounted while it is open, so a click on a
    // sidebar row or another tab never loses its draft.
    const draft = tabs.includes(NEW_SESSION_TAB) ? (
      <div className={tab === NEW_SESSION_TAB ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <NewSessionTab startIn={startIn} onStarted={url.replaceNewTab} />
      </div>
    ) : null;
    const body =
      tab === NEW_SESSION_TAB ? null : tab === GROUP_TAB && view ? (
        groupPane.pane === "pending" ? (
          // A link with no `?tab=` waits for the group's schedules and files.
          <GroupPanePending />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {groupPane.qualifies ? (
              <GroupPaneSwitch pane={groupPane.pane} onPick={url.focusGroupPane} />
            ) : null}
            {groupPane.pane === "overview" && groupPane.qualifies ? (
              // A new key per group: the last visit and the Ask the Lead draft
              // never carry over to the next group.
              <OverviewTab
                key={view}
                view={view}
                onOpen={(id) => openSession(id, { pane: 0 })}
                onOpenList={() => url.focusGroupPane("list")}
              />
            ) : (
              // A row opens next to the group tab, in the main pane.
              <GroupTab view={view} onOpen={(id) => openSession(id, { pane: 0 })} />
            )}
          </div>
        )
      ) : (
        renderSession(tab, 0)
      );
    return (
      <>
        {draft}
        {body}
      </>
    );
  };
  const renderSession = (tab: string, pane: PaneIndex) => (
    // A new key per session: the composer draft and the scroll state
    // never carry over to the next session.
    <SessionPane
      key={tab}
      rootTaskId={tab}
      renaming={renaming?.id === tab && renaming.pane === pane}
      onRenamingChange={(on) => setRenaming(on ? { id: tab, pane } : null)}
      onMove={moveSessions}
      onRevealGroup={revealGroup}
      keysActive={activePane === pane}
    />
  );

  return (
    // The tab, pane, and status bar tooltips open after 300 ms, as in the sidebar and the header.
    <TooltipProvider delayDuration={300} skipDelayDuration={300}>
      <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", MAIN_BLEED)}>
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <nav
            id={sidebarId}
            aria-label="Sessions"
            style={{ "--sessions-sidebar-w": `${width}px` } as CSSProperties}
            data-sessions-sidebar=""
            className="group/nav relative flex shrink-0 flex-col border-b border-border bg-surface md:w-(--sessions-sidebar-w) md:border-r md:border-b-0"
          >
            {/* The bulk bar covers this header while sessions are selected: hide
              it from the pointer, the keys, and screen readers then. */}
            <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border-subtle pr-2 pl-4 group-has-[[data-bulk-bar]]/nav:invisible max-md:border-b-0">
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
            {/* Phones render `MobileSessions` instead (pages/sessions/page.tsx). */}
            <div className="hidden min-h-0 flex-1 flex-col md:flex">
              <SessionTree
                focused={current}
                openSession={openSession}
                newSession={newSession}
                setView={url.openView}
                query={q}
                setQuery={setQuery}
                onViewChange={onViewChange}
                onRename={() => setRenaming({ id: current, pane: activePane })}
                paneCommands={{
                  openInSplit,
                  pickSplit: () => setPickingSplit(true),
                  closeSplit: split ? () => closeSplit(true) : undefined,
                  showGuide: () => guide.open(0),
                }}
                ref={treeRef}
              />
            </div>
            <ResizeHandle
              edge="right"
              width={width}
              min={WIDTH_MIN}
              max={WIDTH_MAX}
              defaultWidth={WIDTH_DEFAULT}
              step={WIDTH_STEP}
              onResize={setWidth}
              label="Resize the sidebar"
              controls={sidebarId}
              className="hidden md:block"
            />
          </nav>

          <SplitPanes
            tabs={tabs}
            focused={focused}
            split={split}
            view={view}
            activePane={activePane}
            onActivatePane={setActivePane}
            onFocusTab={focusStripTab}
            onCloseTab={url.closeTab}
            onNewSession={() => newSession(null)}
            onPickSplit={() => setPickingSplit(true)}
            onCloseSplit={closeSplit}
            onDropToSplit={openInSplit}
            renderPane={renderPane}
          />
          {/* A link preview opens here, next to the panes (T3 Code's preview panel). */}
          <LinkPreviewDock
            storageKey="agent-swarm-sessions-link-preview-width"
            siblingMinWidth={width + PANE_MIN_WIDTH}
            className="max-md:hidden"
          />
        </div>
        <StatusBar
          query={q}
          onQueryChange={setQuery}
          tabCount={tabs.length + (split ? 1 : 0)}
          paneCount={split ? 2 : 1}
          onKeys={() => guide.open(GUIDE_KEYS_STEP)}
        />
        <SplitPicker
          open={pickingSplit}
          tabs={tabs.filter((tab) => isSessionTab(tab) && tab !== split)}
          onOpenChange={setPickingSplit}
          onPick={pickSplit}
        />
        <FirstRunGuide state={guide.state} onStep={guide.setStep} onClose={guide.close} />
      </div>
    </TooltipProvider>
  );
}

const GROUP_PANES = [
  { value: "overview", label: "Overview" },
  { value: "list", label: "Sessions" },
] as const;

/** The use case tab's two faces: its Overview and its session list. */
function GroupPaneSwitch({
  pane,
  onPick,
}: {
  pane: "overview" | "list";
  onPick: (pane: "overview" | "list") => void;
}) {
  return (
    <div className="flex shrink-0 items-center border-b border-border-subtle px-4 py-2">
      <SegmentedControl
        size="sm"
        aria-label="Use case view"
        value={pane}
        onValueChange={onPick}
        options={GROUP_PANES}
      />
    </div>
  );
}
