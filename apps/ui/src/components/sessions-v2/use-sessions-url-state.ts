import { useCallback, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import {
  closeTab as closeTabIn,
  NEW_SESSION_TAB,
  openTab,
  parseTabs,
  parseView,
  serializeTabs,
  tabPath,
  tabsWithFocus,
} from "@/lib/sessions-v2";

export interface SessionsUrlState {
  /** The focused tab: the route's session id, or `NEW_SESSION_TAB` on `/sessions`. */
  focused: string;
  /** The open tabs in order (`?tabs=`), the focused one included. */
  tabs: string[];
  /** The session in the split pane (`?split=`). */
  split: string | null;
  /** The open section or group list (`?view=`): `inbox`, `later`, `done`, `nogroup`, or a group key. */
  view: string | null;
  /** The sidebar search (`?q=`). */
  q: string;
  /** Open a session in the focused tab, or in a new tab after it. */
  openSession: (id: string, options?: { newTab?: boolean }) => void;
  /** Focus an open tab (or `NEW_SESSION_TAB`). */
  focusTab: (tab: string) => void;
  /** Close a tab. It replaces the history entry, also when the focus moves. */
  closeTab: (tab: string) => void;
  setSplit: (id: string | null) => void;
  setView: (view: string | null) => void;
  setQuery: (q: string) => void;
}

/**
 * The sessions v2 state that lives in the URL (plan D12). `/sessions/:rootTaskId`
 * is the focused session, so old links keep working. Opening or focusing a
 * tab pushes a history entry, so browser back returns to the last session.
 * Closing a tab replaces the current entry, also when the focus moves, so
 * back never reopens a closed tab. The other fields replace the current
 * entry. Navigation keeps every other query param.
 */
export function useSessionsUrlState(): SessionsUrlState {
  const { rootTaskId } = useParams<{ rootTaskId: string }>();
  const navigate = useNavigate();
  const { searchParams, setParam } = useUrlSearchState();
  const focused = rootTaskId ?? NEW_SESSION_TAB;
  const tabsParam = searchParams.get("tabs");
  const tabs = useMemo(() => tabsWithFocus(parseTabs(tabsParam), focused), [tabsParam, focused]);
  const split = readStringParam(searchParams, "split") || null;
  const view = parseView(searchParams.get("view"));
  const q = readStringParam(searchParams, "q");

  const go = useCallback(
    (nextTabs: string[], nextFocused: string, replace = false) => {
      const params = new URLSearchParams(searchParams);
      const value = serializeTabs(nextTabs, nextFocused);
      if (value) params.set("tabs", value);
      else params.delete("tabs");
      const qs = params.toString();
      void navigate(`${tabPath(nextFocused)}${qs ? `?${qs}` : ""}`, { replace });
    },
    [navigate, searchParams],
  );

  const openSession = useCallback(
    (id: string, options?: { newTab?: boolean }) => go(openTab(tabs, focused, id, options), id),
    [go, tabs, focused],
  );
  const focusTab = useCallback((tab: string) => go(tabsWithFocus(tabs, tab), tab), [go, tabs]);
  const closeTab = useCallback(
    (tab: string) => {
      const next = closeTabIn(tabs, focused, tab);
      go(next.tabs, next.focused, true);
    },
    [go, tabs, focused],
  );
  const setSplit = useCallback((id: string | null) => setParam("split", id), [setParam]);
  const setView = useCallback((next: string | null) => setParam("view", next), [setParam]);
  const setQuery = useCallback((next: string) => setParam("q", next), [setParam]);

  return {
    focused,
    tabs,
    split,
    view,
    q,
    openSession,
    focusTab,
    closeTab,
    setSplit,
    setView,
    setQuery,
  };
}
