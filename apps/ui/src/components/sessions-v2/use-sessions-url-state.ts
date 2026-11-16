import { useCallback, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import {
  closePaneTab,
  closeSplitPane,
  focusedTab,
  GROUP_TAB,
  type GroupPane,
  moveTab as moveTabIn,
  NEW_SESSION_TAB,
  openInPane,
  type PaneIndex,
  type Panes,
  paneOf,
  parseGroupPane,
  parseView,
  replacePaneTab,
  serializeSplitFocus,
  serializeTabs,
  tabPath,
  tabsWithFocus,
  urlPanes,
  withGroupTab,
} from "@/lib/sessions-v2";

export interface SessionsUrlState {
  /**
   * The focused tab of the main pane: the route's session id, the group tab
   * (`GROUP_TAB`) on `/sessions` while `?view=` is set, else `NEW_SESSION_TAB`.
   */
  focused: string;
  /** The open tabs of the main pane in order (`?tabs=`), the focused one included. */
  tabs: string[];
  /** The open tabs of the split pane in order (`?split=`). Empty: no split. */
  split: string[];
  /** The focused tab of the split pane (`?splitFocus=`, else its first tab). */
  splitFocused: string | null;
  /** The list of the group tab (`?view=`): `inbox`, `later`, `done`, `nogroup`, or a group key. */
  view: string | null;
  /** The group tab's face the URL asks for (`?tab=`): the Overview or the list. */
  groupPane: GroupPane | null;
  /** The sidebar search (`?q=`). */
  q: string;
  /**
   * Open a tab (a session or an asset) in a pane, after its focused tab, as
   * a browser tab: an open never replaces a tab. An open tab only takes the
   * focus, in the pane that holds it. Pane 1 with no split starts the split.
   * `background` adds a main pane tab and keeps the focus where it is.
   * Returns the pane that holds the tab.
   */
  openSession: (id: string, options?: { pane?: PaneIndex; background?: boolean }) => PaneIndex;
  /** Send in the New session tab: the tab turns into the new session, in its pane. */
  replaceNewTab: (id: string) => void;
  /** Focus an open tab (or `NEW_SESSION_TAB`), in the pane that holds it. Returns that pane. */
  focusTab: (tab: string) => PaneIndex;
  /** Close a tab of either pane. It replaces the history entry, also when the focus moves. */
  closeTab: (tab: string) => void;
  /** Open (or focus) the group tab on a list ("View all N"). */
  openView: (view: string) => void;
  /** Focus the group tab on its Overview or its list (`?tab=`). */
  focusGroupPane: (pane: GroupPane) => void;
  /**
   * Move a tab to a pane, or to a new place in its pane: before the tab
   * `before`, at the end (null), or after the pane's focused tab. A tab that
   * is not open opens there. Returns why it cannot, or null.
   */
  moveTab: (id: string, to: PaneIndex, before?: string | null) => string | null;
  /** Close the split. `keep` moves its tabs back to the main pane. */
  closeSplit: (keep: boolean) => void;
  setQuery: (q: string) => void;
}

/**
 * The sessions v2 state that lives in the URL (plan D12). `/sessions/:rootTaskId`
 * is the focused tab of the main pane, so old links keep working. Opening
 * or focusing a tab, the group tab, or a move to the other pane pushes a
 * history entry, so browser back returns to the last place. Closing a tab
 * or the split replaces the current entry, also when the focus moves, so
 * back never reopens a closed tab. A background tab, a new place in the same
 * pane, and the search replace the current entry.
 * Navigation keeps every other query param.
 */
export function useSessionsUrlState(): SessionsUrlState {
  const { rootTaskId } = useParams<{ rootTaskId: string }>();
  const navigate = useNavigate();
  const { searchParams, setParam } = useUrlSearchState();
  const view = parseView(searchParams.get("view"));
  const focused = focusedTab(rootTaskId, view);
  const tabsParam = searchParams.get("tabs");
  const splitParam = readStringParam(searchParams, "split") || null;
  const splitFocusParam = readStringParam(searchParams, "splitFocus") || null;
  const panes = useMemo(
    () => urlPanes(tabsParam, { focused, view, split: splitParam, splitFocus: splitFocusParam }),
    [tabsParam, focused, view, splitParam, splitFocusParam],
  );
  const { tabs, split, splitFocused } = panes;
  const q = readStringParam(searchParams, "q");
  const groupPane = parseGroupPane(searchParams.get("tab"));

  const go = useCallback(
    (
      next: Panes & {
        view?: string | null;
        /** The group tab's face. Undefined keeps it, null drops it. */
        pane?: GroupPane | null;
      },
      replace = false,
    ) => {
      const params = new URLSearchParams(searchParams);
      const value = serializeTabs(next.tabs, next.focused);
      if (value) params.set("tabs", value);
      else params.delete("tabs");
      if (next.split.length > 0) params.set("split", next.split.join(","));
      else params.delete("split");
      const splitFocus = serializeSplitFocus(next);
      if (splitFocus) params.set("splitFocus", splitFocus);
      else params.delete("splitFocus");
      const nextView = next.view !== undefined ? next.view : view;
      if (nextView) params.set("view", nextView);
      else params.delete("view");
      const nextPane = next.pane !== undefined ? next.pane : nextView ? groupPane : null;
      if (nextPane) params.set("tab", nextPane);
      else params.delete("tab");
      const qs = params.toString();
      void navigate(`${tabPath(next.focused, nextView !== null)}${qs ? `?${qs}` : ""}`, {
        replace,
      });
    },
    [navigate, searchParams, view, groupPane],
  );

  const openSession = useCallback(
    (id: string, options?: { pane?: PaneIndex; background?: boolean }) => {
      if (options?.background) {
        if (paneOf(panes, id) === null) {
          go({ ...panes, tabs: tabsWithFocus(openInPane(panes, 0, id).tabs, focused) }, true);
        }
        return paneOf(panes, id) ?? 0;
      }
      const next = openInPane(panes, options?.pane ?? 0, id);
      go(next);
      return paneOf(next, id) ?? 0;
    },
    [go, panes, focused],
  );
  const replaceNewTab = useCallback(
    (id: string) => go(replacePaneTab(panes, NEW_SESSION_TAB, id)),
    [go, panes],
  );
  const focusTab = useCallback(
    (tab: string) => {
      const next = openInPane(panes, 0, tab);
      go(next);
      return paneOf(next, tab) ?? 0;
    },
    [go, panes],
  );
  const closeTab = useCallback(
    (tab: string) =>
      go({ ...closePaneTab(panes, tab), view: tab === GROUP_TAB ? null : view }, true),
    [go, panes, view],
  );
  // One group tab: a second "View all" shows its list in the same tab. A new
  // list drops `?tab=`, so a use-case group opens on its Overview.
  const openView = useCallback(
    (next: string) =>
      go({
        ...panes,
        tabs: withGroupTab(tabs, focused),
        focused: GROUP_TAB,
        view: next,
        ...(next === view ? {} : { pane: null }),
      }),
    [go, panes, tabs, focused, view],
  );
  const focusGroupPane = useCallback(
    (pane: GroupPane) =>
      go({ ...panes, tabs: tabsWithFocus(tabs, GROUP_TAB), focused: GROUP_TAB, pane }),
    [go, panes, tabs],
  );
  const moveTab = useCallback(
    (id: string, to: PaneIndex, before?: string | null) => {
      const result = moveTabIn(panes, id, to, before);
      if ("message" in result) return result.message;
      // A new place in the same pane is no new history entry.
      if (result !== panes) go(result, paneOf(panes, id) === to);
      return null;
    },
    [go, panes],
  );
  const closeSplit = useCallback(
    (keep: boolean) => go(closeSplitPane(panes, keep), true),
    [go, panes],
  );
  const setQuery = useCallback((next: string) => setParam("q", next), [setParam]);

  return {
    focused,
    tabs,
    split,
    splitFocused,
    view,
    groupPane,
    q,
    openSession,
    replaceNewTab,
    focusTab,
    closeTab,
    openView,
    focusGroupPane,
    moveTab,
    closeSplit,
    setQuery,
  };
}
