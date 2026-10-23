// Sessions v2 list filter, from the filter menu at the end of the search
// row. Two parts, each stored in this browser:
//
// - The "Mine / All" view. Mine (the default) lists the sessions the picked
//   user started from a human channel, plus the ones shared with them. All
//   adds the workflow, schedule, and system runs attributed to them.
// - Shown sources: the root sources (the dashboard, Slack, GitHub, ...) that
//   lists and counts keep, the Inbox included. Only `ui` by default, so any
//   other source, one never seen before included, stays out until the user
//   ticks it.
//
// The server applies both (`show` and `showSource` on
// `GET /api/sessions?scope=tree` and `GET /api/session-tree`), so totals and
// pages stay right. They never change who can open a session: a direct link
// to a filtered-out session still works.
//
// Relative imports only: `bun:test` runs this from the repo root.

import { useSyncExternalStore } from "react";

export type SessionsShow = "mine" | "all";

const SHOW_KEY = "swarm:v1:sessions-v2:show";
// A new key: the older hidden-sources list was a denylist, and everyone
// starts on the `ui`-only default.
const SHOWN_KEY = "swarm:v1:sessions-v2:shown-sources";

/** The sources shown until the user changes the filter. */
export const DEFAULT_SHOWN_SOURCES: readonly string[] = ["ui"];
const DEFAULT_SHOWN_RAW = DEFAULT_SHOWN_SOURCES.join(",");

// One store for every hook instance in this tab, plus the `storage` event for
// other tabs. Query options read it outside React, so the list keys and the
// tree key always agree.
const listeners = new Set<() => void>();
let memoryShow: SessionsShow = "mine";
let memoryShown = DEFAULT_SHOWN_RAW;

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Storage unavailable: the in-memory values still work.
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the in-memory value still changes.
  }
  for (const listener of listeners) listener();
}

/** The current view: what the stored preference says, else Mine. */
export function getSessionsShow(): SessionsShow {
  const stored = read(SHOW_KEY);
  return stored === "all" || stored === "mine" ? stored : memoryShow;
}

export function setSessionsShow(next: SessionsShow) {
  memoryShow = next;
  write(SHOW_KEY, next);
}

/**
 * Shown sources in one sorted, comma-joined string: a stable snapshot and
 * query key part. An empty string shows no source.
 */
function shownRaw(): string {
  const stored = read(SHOWN_KEY);
  return stored === null ? memoryShown : stored;
}

let parsed: { raw: string; list: readonly string[] } = {
  raw: DEFAULT_SHOWN_RAW,
  list: DEFAULT_SHOWN_SOURCES,
};

/** The shown root sources, sorted. The same array until they change. */
export function getSessionsShownSources(): readonly string[] {
  const raw = shownRaw();
  if (raw !== parsed.raw) parsed = { raw, list: raw ? raw.split(",") : [] };
  return parsed.list;
}

export function setSessionsShownSources(next: readonly string[]) {
  memoryShown = [...new Set(next.filter(Boolean))].sort().join(",");
  write(SHOWN_KEY, memoryShown);
}

/** The view, re-rendering on a change from any tab. */
export function useSessionsShow(): [SessionsShow, (next: SessionsShow) => void] {
  const show = useSyncExternalStore(subscribe, getSessionsShow, () => "mine" as const);
  return [show, setSessionsShow];
}

/** The shown sources, re-rendering on a change from any tab. */
export function useSessionsShownSources(): [readonly string[], (next: readonly string[]) => void] {
  const shown = useSyncExternalStore(subscribe, getSessionsShownSources, () => parsed.list);
  return [shown, setSessionsShownSources];
}

/** The whole filter as one string, for a component that only re-renders on a change. */
function filterSnapshot(): string {
  return `${getSessionsShow()}|${shownRaw()}`;
}

/** Re-render on any filter change (the view or the shown sources), from any tab. */
export function useSessionsFilter(): void {
  useSyncExternalStore(subscribe, filterSnapshot, () => `mine|${DEFAULT_SHOWN_RAW}`);
}

/**
 * The filter query params: `show` for All only (Mine is the server
 * default), and always `showSource`, empty when no source is shown (the
 * server keeps every source when it is missing).
 */
export function sessionsFilterParams(
  show: SessionsShow,
  shown: readonly string[],
): { show?: "all"; showSource: string } {
  return { ...(show === "all" ? { show } : {}), showSource: shown.join(",") };
}

/** Whether the filter differs from the default (Mine, only `ui`): the menu icon shows a dot. */
export function sessionsFilterActive(show: SessionsShow, shown: readonly string[]): boolean {
  return show !== "mine" || shown.join(",") !== DEFAULT_SHOWN_RAW;
}
