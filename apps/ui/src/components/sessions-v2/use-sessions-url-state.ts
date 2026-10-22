import { useCallback, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import {
  closeSplit as closeSplitIn,
  closeUrlTab,
  focusedTab,
  GROUP_TAB,
  NEW_SESSION_TAB,
  openTab,
  parseView,
  replaceTab,
  serializeTabs,
  splitTo,
  tabPath,
  tabsWithFocus,
  urlTabs,
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
  /** The session in the split pane (`?split=`). */
  split: string | null;
  /** The list of the group tab (`?view=`): `inbox`, `later`, `done`, `nogroup`, or a group key. */
  view: string | null;
  /** The sidebar search (`?q=`). */
  q: string;
  /**
   * Open a session in the focused tab, or in a new tab after it. `background`
   * adds the tab and keeps the focus where it is.
   */
  openSession: (id: string, options?: { newTab?: boolean; background?: boolean }) => void;
  /** Send in the New session tab: the tab turns into the new session. */
  replaceNewTab: (id: string) => void;
  /** Focus an open tab (or `NEW_SESSION_TAB`). */
  focusTab: (tab: string) => void;
  /** Close a tab. It replaces the history entry, also when the focus moves. */
  closeTab: (tab: string) => void;
  /** Open (or focus) the group tab on a list ("View all N"). */
  openView: (view: string) => void;
  /** Open a session in the split pane. Returns why it cannot, or null. */
  openInSplit: (id: string) => string | null;
  /** Open a session in the split pane in place of the one there (a click in the split pane). */
  replaceSplit: (id: string) => void;
  /** Close the split. `keep` moves its session back to the main pane as a tab. */
  closeSplit: (keep: boolean) => void;
  setQuery: (q: string) => void;
}

/**
 * The sessions v2 state that lives in the URL (plan D12). `/sessions/:rootTaskId`
 * is the focused session, so old links keep working. Opening or focusing a
 * tab, the group tab, or the split pushes a history entry, so browser back
 * returns to the last place. Closing a tab or the split replaces the
 * current entry, also when the focus moves, so back never reopens a closed
 * tab. A background tab and the search replace the current entry.
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
  const { tabs, split } = useMemo(
    () => urlTabs(tabsParam, { focused, view, split: splitParam }),
    [tabsParam, focused, view, splitParam],
  );
  const q = readStringParam(searchParams, "q");

  const go = useCallback(
    (
      next: { tabs: string[]; focused: string; split?: string | null; view?: string | null },
      replace = false,
    ) => {
      const params = new URLSearchParams(searchParams);
      const value = serializeTabs(next.tabs, next.focused);
      if (value) params.set("tabs", value);
      else params.delete("tabs");
      // The split as shown: a split param that names the focused tab drops out.
      const nextSplit = next.split !== undefined ? next.split : split;
      if (nextSplit && nextSplit !== next.focused) params.set("split", nextSplit);
      else params.delete("split");
      const nextView = next.view !== undefined ? next.view : view;
      if (nextView) params.set("view", nextView);
      else params.delete("view");
      const qs = params.toString();
      void navigate(`${tabPath(next.focused, nextView !== null)}${qs ? `?${qs}` : ""}`, {
        replace,
      });
    },
    [navigate, searchParams, view, split],
  );

  const openSession = useCallback(
    (id: string, options?: { newTab?: boolean; background?: boolean }) => {
      if (options?.background) {
        const next = openTab(tabs, focused, id, { newTab: true });
        if (next !== tabs) go({ tabs: next, focused }, true);
      } else go({ tabs: openTab(tabs, focused, id, options), focused: id });
    },
    [go, tabs, focused],
  );
  const replaceNewTab = useCallback(
    (id: string) => go({ tabs: replaceTab(tabs, NEW_SESSION_TAB, id), focused: id }),
    [go, tabs],
  );
  const focusTab = useCallback(
    (tab: string) => go({ tabs: tabsWithFocus(tabs, tab), focused: tab }),
    [go, tabs],
  );
  const closeTab = useCallback(
    (tab: string) => go(closeUrlTab(tabs, focused, view, tab), true),
    [go, tabs, focused, view],
  );
  // One group tab: a second "View all" shows its list in the same tab.
  const openView = useCallback(
    (next: string) => go({ tabs: withGroupTab(tabs, focused), focused: GROUP_TAB, view: next }),
    [go, tabs, focused],
  );
  const openInSplit = useCallback(
    (id: string) => {
      const result = splitTo(tabs, focused, split, id);
      if ("message" in result) return result.message;
      if (result.split !== split || result.tabs !== tabs) go(result);
      return null;
    },
    [go, tabs, focused, split],
  );
  const replaceSplit = useCallback(
    (id: string) => {
      if (id !== split) go({ tabs, focused, split: id });
    },
    [go, tabs, focused, split],
  );
  const closeSplit = useCallback(
    (keep: boolean) => go({ tabs: closeSplitIn(tabs, split, keep), focused, split: null }, true),
    [go, tabs, focused, split],
  );
  const setQuery = useCallback((next: string) => setParam("q", next), [setParam]);

  return {
    focused,
    tabs,
    split,
    view,
    q,
    openSession,
    replaceNewTab,
    focusTab,
    closeTab,
    openView,
    openInSplit,
    replaceSplit,
    closeSplit,
    setQuery,
  };
}
