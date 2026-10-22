// Sessions v2: the version gate, the pure URL-state rules (plan D12), and
// small pure helpers the sidebar and the pane share.
//
// Relative imports only: `bun:test` runs this from the repo root.

import type { AgentTask, SessionDetailResponse, SessionListItem } from "../api/types";
import { groupKeyOf } from "./session-groups";

/**
 * The first API that serves `GET /api/session-tree`, the session moves, and
 * the v2 list filters. v2.5.0 was released from main before sessions v2
 * merged, so it has none of them: the first release with them is 2.5.1.
 */
export const SESSIONS_V2_MIN_VERSION = "2.5.1";

/**
 * Where sessions toasts sit: bottom left, over the sidebar. Bottom right
 * covers the composer's Send button (UX review R9).
 */
export const SESSIONS_TOAST_POSITION = "bottom-left" as const;

/** The "New session" tab in `?tabs=`. On the path it is `/sessions` with no id. */
export const NEW_SESSION_TAB = "new";

/**
 * The group tab in `?tabs=` (Phase 8): the full list that `?view=` names.
 * There is one group tab. It is focused on `/sessions` while `?view=` is set.
 */
export const GROUP_TAB = "view";

/** A tab that holds a session (not the New session tab or the group tab). */
export function isSessionTab(tab: string): boolean {
  return tab !== NEW_SESSION_TAB && tab !== GROUP_TAB;
}

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
 * focused tab (a click opens in the current tab). The New session tab and
 * the group tab are never replaced: a session opens next to them (mockup
 * `index.html:2337-2338`), so a draft and a list survive a click.
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
  if (options.newTab || !isSessionTab(focused)) next.splice(at + 1, 0, id);
  else next[at] = id;
  return next;
}

/** The tab list with `from` turned into `to` (Send turns the New session tab into its session). */
export function replaceTab(tabs: string[], from: string, to: string): string[] {
  if (!tabs.includes(from)) return openTab(tabs, from, to);
  return tabs.filter((tab) => tab !== to).map((tab) => (tab === from ? to : tab));
}

/**
 * The tabs and the split of a URL. A group tab with no list in `?view=` is
 * gone. The split holds a session or the New session tab. It never shows in
 * the main pane too: a split that names the focused tab is no split, and a
 * tab that is the split leaves the list. So one session (or one New session
 * draft) never mounts in two panes.
 */
export function urlTabs(
  tabsParam: string | null,
  { focused, view, split }: { focused: string; view: string | null; split: string | null },
): { tabs: string[]; split: string | null } {
  const shownSplit = split && split !== GROUP_TAB && split !== focused ? split : null;
  const listed = parseTabs(tabsParam).filter(
    (tab) => (tab !== GROUP_TAB || view !== null) && tab !== shownSplit,
  );
  return { tabs: tabsWithFocus(listed, focused), split: shownSplit };
}

/** The tab list with the group tab: it keeps its place, or comes in after the focused tab. */
export function withGroupTab(tabs: string[], focused: string): string[] {
  if (tabs.includes(GROUP_TAB)) return tabs;
  const at = tabs.indexOf(focused);
  return [...tabs.slice(0, at + 1), GROUP_TAB, ...tabs.slice(at + 1)];
}

/** `closeTab`, plus the list of the group tab: closing that tab clears `?view=`. */
export function closeUrlTab(
  tabs: string[],
  focused: string,
  view: string | null,
  tab: string,
): { tabs: string[]; focused: string; view: string | null } {
  return { ...closeTab(tabs, focused, tab), view: tab === GROUP_TAB ? null : view };
}

/** Where the split stands after "Open in split" (one split, two panes, SPEC R2.9). */
export type SplitResult =
  | { tabs: string[]; focused: string; split: string }
  /** It cannot split: the session is the only tab. `message` says why. */
  | { message: string };

/**
 * Open `id` in the split pane. A tab of the main pane moves there (it needs
 * a second tab first). A session that was in the split before goes back to
 * the main pane, at the place of the moved tab or after the focused tab, so
 * nothing open is lost.
 */
export function splitTo(
  tabs: string[],
  focused: string,
  split: string | null,
  id: string,
): SplitResult {
  if (id === split) return { tabs, focused, split };
  let next = tabs;
  let nextFocused = focused;
  let at = tabs.indexOf(focused) + 1;
  if (tabs.includes(id)) {
    // The only tab swaps with the split session. With no split, there is nothing to swap.
    if (tabs.length === 1 && !split) return { message: "Open a second session first. Then split." };
    if (tabs.length === 1 && split) return { tabs: [split], focused: split, split: id };
    at = tabs.indexOf(id);
    ({ tabs: next, focused: nextFocused } = closeTab(tabs, focused, id));
  }
  if (split && !next.includes(split)) {
    next = [...next];
    next.splice(Math.min(at, next.length), 0, split);
  }
  return { tabs: next, focused: nextFocused, split: id };
}

/**
 * The tab list after the split closes. `keep` (Cmd+K "Close the split")
 * moves its session back to the main pane as the last tab. Closing its tab
 * drops it.
 */
export function closeSplit(tabs: string[], split: string | null, keep: boolean): string[] {
  if (!keep || !split || tabs.includes(split)) return tabs;
  return [...tabs, split];
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

/**
 * The route of a tab. The New session tab and the group tab both live on
 * `/sessions` with no id, and the group tab wins there while `?view=` is
 * set. So the New session tab moves to `/sessions/new` while a group tab
 * is open (`groupTabOpen`).
 */
export function tabPath(tab: string, groupTabOpen = false): string {
  if (tab === GROUP_TAB) return "/sessions";
  if (tab === NEW_SESSION_TAB) return groupTabOpen ? `/sessions/${NEW_SESSION_TAB}` : "/sessions";
  return `/sessions/${encodeURIComponent(tab)}`;
}

/** The focused tab of a URL: the route's id, else the group tab while `?view=` is set, else New session. */
export function focusedTab(rootTaskId: string | undefined, view: string | null): string {
  return rootTaskId ?? (view ? GROUP_TAB : NEW_SESSION_TAB);
}

/**
 * Rows a sidebar list loads: 10 show, "Show 10 more" shows the next 10. The
 * rest open in the group tab (`?view=`). Loading 20 at once also keeps the
 * list full when Done or Later takes rows out of it.
 */
export const SIDEBAR_LIST_LIMIT = 20;
/** Rows a sidebar list shows before "Show 10 more". */
export const SIDEBAR_LIST_STEP = 10;

/** The list filters of a sidebar container: a section, or a group key. */
interface SidebarListFilter {
  triage?: "inbox" | "later" | "done";
  noGroup?: boolean;
  groupKey?: string;
}

/**
 * The `GET /api/sessions` params of a sidebar container. Every call sends
 * `scope=tree`, so the list totals match the tree counts. The Later
 * notifier reads the same Later list, so both share one cache entry.
 */
export function sidebarListParams(
  container: string,
): SidebarListFilter & { scope: "tree"; limit: number } {
  const base = { scope: "tree" as const, limit: SIDEBAR_LIST_LIMIT };
  if (container === "inbox" || container === "later" || container === "done") {
    return { ...base, triage: container };
  }
  if (container === "nogroup") return { ...base, noGroup: true };
  return { ...base, groupKey: container };
}

/** "1 task", "3 tasks". */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** A user's name from the `/api/users` list, or "Someone" while it loads or for an unknown id. */
export function userName(
  users: readonly { id: string; name: string }[] | undefined,
  id: string,
): string {
  return users?.find((user) => user.id === id)?.name ?? "Someone";
}

/**
 * The task the server reads `latestStatus` from (`src/be/db/session-tree.ts`):
 * the one with the latest `lastUpdatedAt`. On a tie the first one in the
 * server's walk wins: SQLite keeps the first row with the maximum, and the
 * recursive walk is breadth first from the root. Children follow their
 * order in the chain (`createdAt`, then insertion), the closest the client
 * has to the server's index order.
 */
export function latestTask(detail: Pick<SessionDetailResponse, "root" | "chain">): AgentTask {
  const children = new Map<string, AgentTask[]>();
  for (const task of detail.chain) {
    if (!task.parentTaskId || task.id === detail.root.id) continue;
    const siblings = children.get(task.parentTaskId) ?? [];
    siblings.push(task);
    children.set(task.parentTaskId, siblings);
  }
  const root = detail.chain.find((task) => task.id === detail.root.id) ?? detail.root;
  const queue = [root];
  let best = root;
  for (let i = 0; i < queue.length; i++) {
    const task = queue[i];
    // Strictly later: a tie keeps the earlier task in the walk.
    if (task.lastUpdatedAt > best.lastUpdatedAt) best = task;
    queue.push(...(children.get(task.id) ?? []));
  }
  return best;
}

/**
 * A list row for a session from its detail: the focused session when no
 * loaded list holds it (Cmd+K), and the pane header. The detail has no
 * Later wake time: pass it when known, so Undo can snooze again.
 */
export function itemFromDetail(
  detail: SessionDetailResponse,
  snoozeUntil: string | null = null,
): SessionListItem {
  const last = latestTask(detail);
  return {
    root: detail.root,
    chainTaskCount: detail.chain.length,
    lastActivityAt: detail.lastActivityAt ?? last.lastUpdatedAt,
    latestStatus: last.status,
    readState: detail.readState,
    // The list's rule (D6): unread and failed, or an approval that waits.
    needsYou:
      (detail.approvals?.length ?? 0) > 0 ||
      (detail.readState === "unread" && last.status === "failed"),
    snoozeUntil,
    groupKey: detail.root.key ? groupKeyOf(detail.root.key) : undefined,
  };
}
