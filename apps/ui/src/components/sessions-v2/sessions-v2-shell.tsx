/**
 * Sessions v2 shell: a resizable sidebar frame next to the pane area. It
 * collapses the global nav to icons while it is open, so the sidebar and the
 * panes keep their width (UX review R9). The sidebar header holds the help
 * button (the guide and the keys) and the switch to the legacy view.
 *
 * The sidebar holds the search and the session tree (Phases 4 and 5). The
 * pane area (Phase 8) holds the main pane and one split pane, each with its
 * own tabs. A tab shows the New session composer (it keeps the `?seed=` and
 * `?prefill=` links working), the group tab (`?view=`), an asset (a file, a
 * page, or a task that a link opened), or a session: the header (Phase 6)
 * over the turn timeline (Phase 7). A link in a pane opens its asset as a
 * tab in the other pane, so both show side by side. A use-case group (one
 * with a schedule or files under its key) gets a pinned Overview tab first
 * (step-10), and `?tab=overview|list` picks its face. The first-run guide
 * and the "Open in split…" picker mount here too.
 */

import { CircleHelp, LayoutList, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { type CSSProperties, useCallback, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import { useSession } from "@/api/hooks/use-sessions";
import type { SessionListItem } from "@/api/types";
import { LinkPreviewOpener } from "@/components/link-preview/link-preview-state";
import { ResizeHandle } from "@/components/shared/resize-handle";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useCollapseNavWhile } from "@/hooks/use-collapse-nav-while";
import { useLocalToggle } from "@/hooks/use-local-toggle";
import type { SessionsViewMode } from "@/hooks/use-sessions-view";
import { assetTabId, type LinkPreviewTarget } from "@/lib/link-preview";
import { MAIN_BLEED } from "@/lib/main-gutter";
import {
  detailGroupKey,
  GROUP_TAB,
  isAssetTab,
  isSessionTab,
  NEW_SESSION_TAB,
  type PaneIndex,
} from "@/lib/sessions-v2";
import { cn } from "@/lib/utils";
import { FirstRunGuide, GUIDE_KEYS_STEP, useFirstRunGuide } from "./first-run-guide";
import { GroupTab } from "./group-tab";
import { NewSessionTab } from "./new-session-tab";
import { GroupPanePending, useGroupPane } from "./overview/group-pane";
import { OverviewTab } from "./overview/overview-tab";
import { SessionPane } from "./pane/session-pane";
import { usePaneKeys } from "./pane/use-pane-keys";
import { SessionTree, type SessionTreeHandle } from "./sidebar/session-tree";
import { TipKey } from "./sidebar/tree-row";
import { AssetTab } from "./tabs/asset-tab";
import { SplitPanes } from "./tabs/split-panes";
import { SplitPicker } from "./tabs/split-picker";
import { useMyGroups } from "./use-my-groups";
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

export interface SessionsV2ShellProps {
  /** Switch views. The page owns the one `useSessionsView()` instance. */
  onViewChange: (view: SessionsViewMode) => void;
}

export function SessionsV2Shell({ onViewChange }: SessionsV2ShellProps) {
  useCollapseNavWhile(true);
  const url = useSessionsUrlState();
  const { focused, tabs, split, splitFocused, view, q, setQuery } = url;
  // A use case is one tab: its Overview and its session list are two faces
  // of that tab, switched inside it (`?tab=`), never two strip tabs.
  const groupPane = useGroupPane(view, url.groupPane);
  const [width, setWidth] = useSidebarWidth();
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalToggle(
    "sessions:sidebar-collapsed",
    false,
  );
  const sidebarId = useId();
  // The pane that holds the pane keys, Cmd+K's session, and sidebar clicks.
  const [paneState, setActivePane] = useState<PaneIndex>(0);
  const activePane: PaneIndex = splitFocused ? paneState : 0;
  const current = activePane === 1 && splitFocused ? splitFocused : focused;
  // A click on a tab: the tab takes the focus in its pane, and the pane the keys.
  const focusStripTab = (tab: string) => setActivePane(url.focusTab(tab));
  // The group the New session tab starts in: the one it was opened from.
  const [startIn, setStartIn] = useState<string | null>(null);
  // One New session draft: "+" and `c` focus it in the pane that holds it,
  // else open it in `pane` (the active pane by default).
  const newSession = (group: string | null = null, pane: PaneIndex = activePane) => {
    setStartIn(group);
    setActivePane(url.openSession(NEW_SESSION_TAB, { pane }));
  };
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
      setSidebarCollapsed(false);
      treeRef.current?.revealGroup(groupKey);
      openView(groupKey ?? "nogroup");
    },
    [openView, setSidebarCollapsed],
  );

  /**
   * Every open goes through here, so one session never mounts in two panes
   * (two panes would poll it twice). An open session takes the focus in the
   * pane that holds it. Any other opens as a new tab after the focused tab
   * of the active pane: an open never replaces a tab. A new tab (`t`) opens
   * in the main pane. A background tab (a middle-click) keeps the focus and
   * does not mark the session read (mockup `index.html:4802-4807`). `pane`
   * names the pane for an open from inside it (the group tab).
   */
  const openSession = (
    id: string,
    options: { newTab?: boolean; background?: boolean; pane?: PaneIndex } = {},
  ) => {
    if (options.background) {
      const open = tabs.includes(id) || split.includes(id);
      if (!open) url.openSession(id, { background: true });
      toast(open ? "Already open in a tab." : "Opened in a new tab.");
      return;
    }
    setActivePane(url.openSession(id, { pane: options.newTab ? 0 : (options.pane ?? activePane) }));
  };
  /** Move a tab to a pane (or to a new place in it). A toast says why it cannot. */
  const moveTab = (tab: string, to: PaneIndex, before?: string | null): boolean => {
    const message = url.moveTab(tab, to, before);
    if (message) {
      toast(message);
      return false;
    }
    // The main pane's only tab joins the split: one pane stays, the main one.
    setActivePane(to === 1 && tabs.length === 1 && tabs[0] === tab ? 0 : to);
    return true;
  };
  const openInSplit = (id: string) => void moveTab(id, 1);
  const closeSplit = (keep: boolean) => {
    setActivePane(0);
    url.closeSplit(keep);
  };
  /**
   * A link in a pane opens its file, page, or task as a tab in the other
   * pane (the split starts if there is none), so the session stays in view
   * next to it. The keys stay with the pane the link is in.
   */
  const openAsset = (target: LinkPreviewTarget, from: PaneIndex, tab: string) => {
    url.openSession(assetTabId(target, tab), { pane: from === 0 ? 1 : 0 });
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
    const fresh = id === NEW_SESSION_TAB && !split.includes(id) && !tabs.includes(id);
    const group = startGroupOfPane();
    if (moveTab(id, 1) && fresh) setStartIn(group);
  };
  usePaneKeys({
    split: () => setPickingSplit(true),
    newSession: () => newSession(startGroupOfPane()),
  });

  const renderPane = (tab: string, pane: PaneIndex) => {
    // The New session tab stays mounted while it is open in the pane, so a
    // click on a sidebar row or another tab never loses its draft.
    const draft = (pane === 0 ? tabs : split).includes(NEW_SESSION_TAB) ? (
      <div className={tab === NEW_SESSION_TAB ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <NewSessionTab startIn={startIn} onStarted={url.replaceNewTab} />
      </div>
    ) : null;
    const body =
      tab === NEW_SESSION_TAB ? null : isAssetTab(tab) ? (
        // A new key per asset: the viewer's scroll and state never carry over.
        <AssetTab key={tab} tab={tab} />
      ) : tab === GROUP_TAB && view ? (
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
        renderSession(tab, pane)
      );
    return (
      <LinkPreviewOpener open={(target) => openAsset(target, pane, tab)}>
        {draft}
        {body}
      </LinkPreviewOpener>
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
    // The tab and pane tooltips open after 300 ms, as in the sidebar and the header.
    <TooltipProvider delayDuration={300} skipDelayDuration={300}>
      <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", MAIN_BLEED)}>
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <nav
            id={sidebarId}
            aria-label="Sessions"
            style={{ "--sessions-sidebar-w": `${width}px` } as CSSProperties}
            data-sessions-sidebar=""
            className={cn(
              "group/nav relative flex shrink-0 flex-col border-b border-border bg-surface md:border-r md:border-b-0",
              sidebarCollapsed ? "md:w-10" : "md:w-(--sessions-sidebar-w)",
            )}
          >
            {/* The bulk bar covers this header while sessions are selected: hide
              it from the pointer, the keys, and screen readers then. */}
            <div
              className={cn(
                "flex h-9 shrink-0 items-center gap-1 border-b border-border-subtle group-has-[[data-bulk-bar]]/nav:invisible max-md:border-b-0",
                sidebarCollapsed ? "justify-center px-1" : "pr-2 pl-4",
              )}
            >
              <h2
                className={
                  sidebarCollapsed ? "sr-only" : "min-w-0 flex-1 truncate text-sm font-semibold"
                }
              >
                Sessions
              </h2>
              {!sidebarCollapsed && (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label="Guide and keys"
                        aria-haspopup="dialog"
                        aria-keyshortcuts="Shift+?"
                        onClick={() => guide.open(GUIDE_KEYS_STEP)}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <CircleHelp />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent className="flex items-center gap-1.5">
                      Guide and keys
                      <TipKey>?</TipKey>
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label="Legacy sessions"
                        onClick={() => onViewChange("legacy")}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <LayoutList />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Switch to the legacy sessions view</TooltipContent>
                  </Tooltip>
                </>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={
                      sidebarCollapsed ? "Expand sessions sidebar" : "Collapse sessions sidebar"
                    }
                    aria-expanded={!sidebarCollapsed}
                    aria-controls={sidebarId}
                    onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                  >
                    {sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {sidebarCollapsed ? "Expand sessions sidebar" : "Collapse sessions sidebar"}
                </TooltipContent>
              </Tooltip>
            </div>
            {/* Phones render `MobileSessions` instead (pages/sessions/page.tsx). */}
            <div className={cn("hidden min-h-0 flex-1 flex-col", !sidebarCollapsed && "md:flex")}>
              <SessionTree
                onReveal={() => flushSync(() => setSidebarCollapsed(false))}
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
                  closeSplit: split.length > 0 ? () => closeSplit(true) : undefined,
                  showGuide: () => guide.open(0),
                }}
                ref={treeRef}
              />
            </div>
            {!sidebarCollapsed && (
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
            )}
          </nav>

          <SplitPanes
            tabs={tabs}
            focused={focused}
            split={split}
            splitFocused={splitFocused}
            view={view}
            activePane={activePane}
            onActivatePane={setActivePane}
            onFocusTab={focusStripTab}
            onCloseTab={url.closeTab}
            onNewSession={(pane) => newSession(null, pane)}
            onPickSplit={() => setPickingSplit(true)}
            onCloseSplit={closeSplit}
            onMoveTab={moveTab}
            renderPane={renderPane}
          />
        </div>
        <SplitPicker
          open={pickingSplit}
          tabs={tabs.filter(isSessionTab)}
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
