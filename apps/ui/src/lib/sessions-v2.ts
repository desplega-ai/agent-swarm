// Sessions v2: the version gate and the pure URL-state rules (plan D12).
//
// Relative imports only: `bun:test` runs this from the repo root.

/**
 * The first API that serves `GET /api/session-tree`, the session moves, and
 * the v2 list filters. It is the patch after the `package.json` version that
 * the sessions v2 branch started from. Recheck it before the merge.
 */
export const SESSIONS_V2_MIN_VERSION = "2.4.5";

/** The "New session" tab in `?tabs=`. On the path it is `/sessions` with no id. */
export const NEW_SESSION_TAB = "new";

/** The flat sidebar sections that `?view=` can open. A group key opens a group. */
export const SESSION_SECTIONS = ["inbox", "later", "done", "nogroup"] as const;
export type SessionSection = (typeof SESSION_SECTIONS)[number];

/** `?tabs=` as a list: trimmed, no blanks, no repeats, in URL order. */
export function parseTabs(value: string | null): string[] {
  if (!value) return [];
  const tabs: string[] = [];
  for (const raw of value.split(",")) {
    const tab = raw.trim();
    if (tab && !tabs.includes(tab)) tabs.push(tab);
  }
  return tabs;
}

/** The tabs to show: the URL list, plus the focused tab at the end when the list lacks it. */
export function tabsWithFocus(tabs: string[], focused: string): string[] {
  return tabs.includes(focused) ? tabs : [...tabs, focused];
}

/**
 * `?tabs=` for a tab list. Empty (drop the param) when the only tab is the
 * focused one, because the path already names it.
 */
export function serializeTabs(tabs: string[], focused: string): string {
  if (tabs.length === 1 && tabs[0] === focused) return "";
  return tabs.join(",");
}

/** `?view=`: a section name or a group key (it ends with `/`). Anything else is no view. */
export function parseView(value: string | null): string | null {
  if (!value) return null;
  if ((SESSION_SECTIONS as readonly string[]).includes(value)) return value;
  return value.endsWith("/") ? value : null;
}

/**
 * The tab list after opening `id`. An open tab keeps its place. Otherwise
 * `newTab` adds it after the focused tab, and a plain open replaces the
 * focused tab (a click opens in the current tab).
 */
export function openTab(
  tabs: string[],
  focused: string,
  id: string,
  options: { newTab?: boolean } = {},
): string[] {
  if (tabs.includes(id)) return tabs;
  const at = tabs.indexOf(focused);
  if (at < 0) return [...tabs, id];
  const next = [...tabs];
  if (options.newTab) next.splice(at + 1, 0, id);
  else next[at] = id;
  return next;
}

/**
 * The tab list and the focus after closing `id`. Closing the focused tab
 * focuses its right neighbor, else its left one. Closing the last tab leaves
 * a New session tab.
 */
export function closeTab(
  tabs: string[],
  focused: string,
  id: string,
): { tabs: string[]; focused: string } {
  const at = tabs.indexOf(id);
  if (at < 0) return { tabs, focused };
  const next = tabs.filter((tab) => tab !== id);
  if (next.length === 0) return { tabs: [NEW_SESSION_TAB], focused: NEW_SESSION_TAB };
  if (id !== focused) return { tabs: next, focused };
  return { tabs: next, focused: next[Math.min(at, next.length - 1)] };
}

/** The route of a tab. */
export function tabPath(tab: string): string {
  return tab === NEW_SESSION_TAB ? "/sessions" : `/sessions/${encodeURIComponent(tab)}`;
}
