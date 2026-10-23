// Sessions v2 list filter, from the filter menu at the end of the search
// row. Two parts, each stored in this browser:
//
// - The "Mine / All" view. Mine (the default) lists the sessions the picked
//   user started from a human channel, plus the ones shared with them. All
//   adds the workflow, schedule, and system runs attributed to them.
// - Hidden sources: root sources (Slack, a chat channel, ...) left out of
//   every list and count, the Inbox included. None by default, so a new
//   source shows until the user hides it.
//
// The server applies both (`show` and `hideSource` on
// `GET /api/sessions?scope=tree` and `GET /api/session-tree`), so totals and
// pages stay right. They never change who can open a session: a direct link
// to a hidden session still works.
//
// Relative imports only: `bun:test` runs this from the repo root.

import { useSyncExternalStore } from "react";

export type SessionsShow = "mine" | "all";

const SHOW_KEY = "swarm:v1:sessions-v2:show";
const HIDDEN_KEY = "swarm:v1:sessions-v2:hidden-sources";

// One store for every hook instance in this tab, plus the `storage` event for
// other tabs. Query options read it outside React, so the list keys and the
// tree key always agree.
const listeners = new Set<() => void>();
let memoryShow: SessionsShow = "mine";
let memoryHidden = "";

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

/** Hidden sources in one sorted, comma-joined string: a stable snapshot and query key part. */
function hiddenRaw(): string {
  const stored = read(HIDDEN_KEY);
  return stored === null ? memoryHidden : stored;
}

let parsed: { raw: string; list: readonly string[] } = { raw: "", list: [] };

/** The hidden root sources, sorted. The same array until they change. */
export function getSessionsHiddenSources(): readonly string[] {
  const raw = hiddenRaw();
  if (raw !== parsed.raw) parsed = { raw, list: raw ? raw.split(",") : [] };
  return parsed.list;
}

export function setSessionsHiddenSources(next: readonly string[]) {
  memoryHidden = [...new Set(next.filter(Boolean))].sort().join(",");
  write(HIDDEN_KEY, memoryHidden);
}

/** The view, re-rendering on a change from any tab. */
export function useSessionsShow(): [SessionsShow, (next: SessionsShow) => void] {
  const show = useSyncExternalStore(subscribe, getSessionsShow, () => "mine" as const);
  return [show, setSessionsShow];
}

/** The hidden sources, re-rendering on a change from any tab. */
export function useSessionsHiddenSources(): [readonly string[], (next: readonly string[]) => void] {
  const hidden = useSyncExternalStore(subscribe, getSessionsHiddenSources, () => parsed.list);
  return [hidden, setSessionsHiddenSources];
}

/** The whole filter as one string, for a component that only re-renders on a change. */
function filterSnapshot(): string {
  return `${getSessionsShow()}|${hiddenRaw()}`;
}

/** Re-render on any filter change (the view or the hidden sources), from any tab. */
export function useSessionsFilter(): void {
  useSyncExternalStore(subscribe, filterSnapshot, () => "mine|");
}

/**
 * The filter query params: `show` for All only (Mine is the server
 * default), `hideSource` when a source is hidden.
 */
export function sessionsFilterParams(
  show: SessionsShow,
  hidden: readonly string[],
): { show?: "all"; hideSource?: string } {
  return {
    ...(show === "all" ? { show } : {}),
    ...(hidden.length > 0 ? { hideSource: hidden.join(",") } : {}),
  };
}

/** Whether the filter differs from the default (Mine, nothing hidden): the menu icon shows a dot. */
export function sessionsFilterActive(show: SessionsShow, hidden: readonly string[]): boolean {
  return show !== "mine" || hidden.length > 0;
}
