// Sessions v2: the version gate, the pure URL-state rules (plan D12), and
// small pure helpers the sidebar and the pane share.
//
// Relative imports only: `bun:test` runs this from the repo root.

import type {
  AgentTask,
  SessionDetailResponse,
  SessionListItem,
  SessionSectionCounts,
  SessionTreeResponse,
} from "../api/types";
import { groupKeyOf, sourceOfGroupKey } from "./session-groups";

/**
 * The first API that serves `GET /api/session-tree`, the session moves, and
 * the v2 list filters. v2.5.0 was released from main before sessions v2
 * merged, so it has none of them: the first release with them is 2.5.1.
 */
export const SESSIONS_V2_MIN_VERSION = "2.5.1";

/** The "New session" tab in `?tabs=`. On the path it is `/sessions` with no id. */
export const NEW_SESSION_TAB = "new";

/**
 * The group tab in `?tabs=` (Phase 8): the full list that `?view=` names.
 * There is one group tab. It is focused on `/sessions` while `?view=` is set.
 */
export const GROUP_TAB = "view";

/**
 * The pinned Overview tab of a use-case group (step-10). It never goes in
 * `?tabs=`: it shows before the tabs while the group tab is open and its group
 * qualifies, and `?tab=overview` focuses it (`?tab=list` focuses the list).
 */
export const OVERVIEW_TAB = "overview";

/** The group tab's two faces: the Overview or the session list (`?tab=`). */
export type GroupPane = "overview" | "list";

/** `?tab=` as a group pane, or null when it names neither. */
export function parseGroupPane(value: string | null): GroupPane | null {
  return value === "overview" || value === "list" ? value : null;
}

/**
 * An asset tab: a file, a page, or a task that a link in a session opens
 * next to it (`lib/link-preview.ts` builds and reads the id). It sits in a
 * pane's tab strip with the session tabs.
 */
export const ASSET_TAB_PREFIX = "asset:";

/** A tab that shows a file, a page, or a task. */
export function isAssetTab(tab: string): boolean {
  return tab.startsWith(ASSET_TAB_PREFIX);
}

/** A tab that holds a session (not the New session tab, the group tab, the Overview, or an asset). */
export function isSessionTab(tab: string): boolean {
  return tab !== NEW_SESSION_TAB && tab !== GROUP_TAB && tab !== OVERVIEW_TAB && !isAssetTab(tab);
}

/** A tab the split pane can hold: a session, the New session tab, or an asset. */
export function canSplitTab(tab: string): boolean {
  return tab !== GROUP_TAB && tab !== OVERVIEW_TAB;
}

/** The flat sidebar sections that `?view=` can open. A group key opens a group. */
export const SESSION_SECTIONS = ["inbox", "working", "later", "done", "nogroup"] as const;
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
 * the session opens in a new tab after the focused tab, as a browser tab
 * does: an open never replaces a tab, so every opened session stays open
 * until its tab closes. The New session tab and the group tab keep their
 * place too, so a draft and a list survive a click.
 */
export function openTab(tabs: string[], focused: string, id: string): string[] {
  if (tabs.includes(id)) return tabs;
  const at = tabs.indexOf(focused);
  if (at < 0) return [...tabs, id];
  const next = [...tabs];
  next.splice(at + 1, 0, id);
  return next;
}

/** 0: the main pane. 1: the split pane. */
export type PaneIndex = 0 | 1;

/**
 * The two panes. Each is a tab group: the main pane's tabs with its focused
 * tab (the route), and the split pane's tabs with its own focused tab. No
 * split tabs is no split. One tab never shows in both panes, so one session
 * (or one New session draft) never mounts twice.
 */
export interface Panes {
  tabs: string[];
  focused: string;
  split: string[];
  /** The focused tab of the split pane. Null with no split. */
  splitFocused: string | null;
}

/**
 * The panes of a URL. A group tab with no list in `?view=` is gone. The
 * split holds sessions, the New session tab, and assets. The main pane's
 * focused tab stays there, so a split that names it loses it, and a tab in
 * the split leaves the main list. `?splitFocus=` names the split's focused
 * tab: its first tab when the param is missing or stale.
 */
export function urlPanes(
  tabsParam: string | null,
  {
    focused,
    view,
    split,
    splitFocus,
  }: { focused: string; view: string | null; split: string | null; splitFocus?: string | null },
): Panes {
  const splitTabs = parseTabs(split).filter((tab) => canSplitTab(tab) && tab !== focused);
  const listed = parseTabs(tabsParam).filter(
    (tab) =>
      (tab !== GROUP_TAB || view !== null) && !splitTabs.includes(tab) && tab !== OVERVIEW_TAB,
  );
  return {
    tabs: tabsWithFocus(listed, focused),
    focused,
    split: splitTabs,
    splitFocused:
      splitFocus && splitTabs.includes(splitFocus) ? splitFocus : (splitTabs[0] ?? null),
  };
}

/** `?splitFocus=`: empty (drop the param) when the split's first tab has the focus. */
export function serializeSplitFocus(panes: Panes): string {
  return panes.splitFocused && panes.splitFocused !== panes.split[0] ? panes.splitFocused : "";
}

/** The pane that holds a tab, or null when it is not open. */
export function paneOf(panes: Panes, tab: string): PaneIndex | null {
  if (panes.tabs.includes(tab)) return 0;
  return panes.split.includes(tab) ? 1 : null;
}

/** The tab list with the group tab: it keeps its place, or comes in after the focused tab. */
export function withGroupTab(tabs: string[], focused: string): string[] {
  if (tabs.includes(GROUP_TAB)) return tabs;
  const at = tabs.indexOf(focused);
  return [...tabs.slice(0, at + 1), GROUP_TAB, ...tabs.slice(at + 1)];
}

/** Why the only tab of the main pane cannot go to the split while no split is open. */
export const SPLIT_NEEDS_SECOND_TAB = "Open a second session first. Then split.";
/** Why the group tab cannot go to the split. */
export const SPLIT_KEEPS_GROUP_TAB = "The group tab stays in the main pane.";

/** A tab list without `id`, and the focus after it: the right neighbor, else the left one. */
function without(
  tabs: string[],
  focused: string | null,
  id: string,
): { tabs: string[]; focused: string | null } {
  const at = tabs.indexOf(id);
  if (at < 0) return { tabs, focused };
  const next = tabs.filter((tab) => tab !== id);
  if (id !== focused) return { tabs: next, focused };
  return { tabs: next, focused: next[Math.min(at, next.length - 1)] ?? null };
}

/**
 * `id` in a tab list: before the tab `before`, at the end (null), or after
 * the focused tab (undefined), as a browser places a new tab.
 */
function insertTab(
  tabs: string[],
  focused: string | null,
  id: string,
  before: string | null | undefined,
): string[] {
  const at =
    before === undefined
      ? tabs.indexOf(focused ?? "") + 1 || tabs.length
      : before === null || !tabs.includes(before)
        ? tabs.length
        : tabs.indexOf(before);
  const next = [...tabs];
  next.splice(at, 0, id);
  return next;
}

/**
 * The panes in a valid state. A main pane with no tab takes the split's
 * tabs (the split closes, as an editor group does when its last tab
 * leaves). With no tab at all, a New session tab stays.
 */
function settle(
  tabs: string[],
  focused: string | null,
  split: string[],
  splitFocused: string | null,
): Panes {
  if (tabs.length === 0 && split.length > 0) {
    return { tabs: split, focused: splitFocused ?? split[0], split: [], splitFocused: null };
  }
  if (tabs.length === 0) {
    return { tabs: [NEW_SESSION_TAB], focused: NEW_SESSION_TAB, split: [], splitFocused: null };
  }
  return {
    tabs,
    focused: focused ?? tabs[0],
    split,
    splitFocused: split.length === 0 ? null : (splitFocused ?? split[0]),
  };
}

/**
 * Open `id` in a pane. An open tab keeps its pane and its place, and takes
 * the focus there. Otherwise it opens after the focused tab of `pane`: an
 * open never replaces a tab. Opening in pane 1 with no split starts the split.
 */
export function openInPane(panes: Panes, pane: PaneIndex, id: string): Panes {
  const at = paneOf(panes, id);
  if (at === 0) return { ...panes, focused: id };
  if (at === 1) return { ...panes, splitFocused: id };
  if (pane === 0 || !canSplitTab(id)) {
    return { ...panes, tabs: openTab(panes.tabs, panes.focused, id), focused: id };
  }
  return {
    ...panes,
    split: insertTab(panes.split, panes.splitFocused, id, undefined),
    splitFocused: id,
  };
}

/** The panes after a move, or why the tab cannot move. */
export type MoveResult = Panes | { message: string };

/**
 * Move a tab to a pane, or to a new place in its own pane. It lands before
 * the tab `before`, at the end (null), or after the pane's focused tab
 * (undefined). A tab that changes pane takes the focus there, and the pane
 * it left focuses its neighbor. The group tab stays in the main pane. The
 * main pane's only tab cannot start a split. When the main pane's last tab
 * goes to the split, the two panes join into one. A tab that is not open
 * opens in the pane.
 */
export function moveTab(
  panes: Panes,
  id: string,
  to: PaneIndex,
  before?: string | null,
): MoveResult {
  const from = paneOf(panes, id);
  if (to === 1 && !canSplitTab(id)) return { message: SPLIT_KEEPS_GROUP_TAB };
  if (to === 1 && from === 0 && panes.tabs.length === 1 && panes.split.length === 0) {
    return { message: SPLIT_NEEDS_SECOND_TAB };
  }
  if (before === id) return panes;
  if (from === to) {
    // A new place in the same pane: the focus stays on the same tab.
    const list = to === 0 ? panes.tabs : panes.split;
    const moved = insertTab(
      list.filter((tab) => tab !== id),
      to === 0 ? panes.focused : panes.splitFocused,
      id,
      before === undefined ? null : before,
    );
    if (moved.every((tab, i) => tab === list[i])) return panes;
    return to === 0 ? { ...panes, tabs: moved } : { ...panes, split: moved };
  }
  const main = from === 0 ? without(panes.tabs, panes.focused, id) : panes;
  const side =
    from === 1
      ? without(panes.split, panes.splitFocused, id)
      : { tabs: panes.split, focused: panes.splitFocused };
  if (to === 0) {
    return settle(insertTab(main.tabs, main.focused, id, before), id, side.tabs, side.focused);
  }
  return settle(main.tabs, main.focused, insertTab(side.tabs, side.focused, id, before), id);
}

/**
 * The panes after closing a tab. The pane focuses the right neighbor of a
 * closed focused tab, else the left one. The split closes with its last
 * tab. The main pane takes the split's tabs when its last tab closes.
 */
export function closePaneTab(panes: Panes, id: string): Panes {
  const main = without(panes.tabs, panes.focused, id);
  const side = without(panes.split, panes.splitFocused, id);
  return settle(main.tabs, main.focused, side.tabs, side.focused);
}

/** The panes with `from` turned into `to`, in its pane (Send turns the New session tab into its session). */
export function replacePaneTab(panes: Panes, from: string, to: string): Panes {
  const at = paneOf(panes, from);
  if (at === null) return openInPane(panes, 0, to);
  const swap = (tabs: string[]) =>
    tabs.filter((tab) => tab !== to).map((tab) => (tab === from ? to : tab));
  const tabs = swap(panes.tabs);
  const split = swap(panes.split);
  return settle(
    tabs,
    at === 0 ? to : tabs.includes(panes.focused) ? panes.focused : null,
    split,
    at === 1
      ? to
      : panes.splitFocused && split.includes(panes.splitFocused)
        ? panes.splitFocused
        : null,
  );
}

/**
 * The panes after the split closes. `keep` (the split button, Cmd+K "Close
 * the split") moves its tabs to the end of the main pane. Without it they close.
 */
export function closeSplitPane(panes: Panes, keep: boolean): Panes {
  return {
    tabs: keep ? [...panes.tabs, ...panes.split] : panes.tabs,
    focused: panes.focused,
    split: [],
    splitFocused: null,
  };
}

/** The narrowest a pane of the split may get. */
export const SPLIT_PANE_MIN_WIDTH = 320;
/** The main pane's share of the row when no size is stored: half. */
export const SPLIT_DEFAULT_RATIO = 0.5;
/** One arrow key press on the split's drag edge. */
export const SPLIT_WIDTH_STEP = 32;

/** The main pane's width in a split row, and the bounds of its drag edge. */
export interface SplitLayout {
  /** The main pane's width in px. */
  width: number;
  min: number;
  max: number;
  /** `width` as a share of the row: what the browser stores. */
  ratio: number;
}

/**
 * The main pane's size in a split row of `rowWidth` px. The stored size is a
 * share of the row, so it holds when the sidebar or a link preview changes
 * the row. Each pane keeps `SPLIT_PANE_MIN_WIDTH`. A row too narrow for two
 * of them splits in half. A missing or bad share gives half.
 */
export function splitLayout(ratio: number | null, rowWidth: number): SplitLayout {
  const value =
    ratio !== null && Number.isFinite(ratio) && ratio > 0 && ratio < 1
      ? ratio
      : SPLIT_DEFAULT_RATIO;
  if (!(rowWidth > 0)) return { width: 0, min: 0, max: 0, ratio: value };
  const half = Math.round(rowWidth / 2);
  // Keep max >= min: an inverted clamp would overwrite the stored size.
  const min = Math.min(SPLIT_PANE_MIN_WIDTH, half);
  const max = Math.max(min, Math.round(rowWidth - SPLIT_PANE_MIN_WIDTH));
  const width = Math.round(Math.min(max, Math.max(min, value * rowWidth)));
  return { width, min, max, ratio: width / rowWidth };
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
  triage?: "inbox" | "working" | "later" | "done";
  noGroup?: boolean;
  groupKey?: string;
  /** A source group: the group and its nested threads. */
  keyPrefix?: string;
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
  if (
    container === "inbox" ||
    container === "working" ||
    container === "later" ||
    container === "done"
  ) {
    return { ...base, triage: container };
  }
  if (container === "nogroup") return { ...base, noGroup: true };
  // A source group (a channel, a DM) lists its threads' sessions too: one list, one sort.
  if (sourceOfGroupKey(container)) return { ...base, keyPrefix: container };
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
 * The session's cost: every task in the chain (root, delegated children and
 * follow-ups), not the root alone. Null when no task has a cost row, or the
 * server predates per-task costs on the chain.
 */
export function sessionCostUsd(chain: readonly Pick<AgentTask, "totalCostUsd">[]): number | null {
  let total: number | null = null;
  for (const task of chain) {
    if (task.totalCostUsd != null) total = (total ?? 0) + task.totalCostUsd;
  }
  return total;
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
    groupKey: detailGroupKey(detail),
  };
}

/** The group of a session detail: the server's, else the key rule of older servers. */
export function detailGroupKey(detail: SessionDetailResponse): string | undefined {
  return detail.groupKey ?? (detail.root.key ? groupKeyOf(detail.root.key) : undefined);
}

/**
 * A count across every session in the tree: No group, every group, Later, and
 * Done. The Inbox leaves out grouped sessions, so it cannot stand in for them.
 */
export function treeCount(
  tree: SessionTreeResponse | undefined,
  key: Exclude<keyof SessionSectionCounts, "total">,
): number {
  if (!tree) return 0;
  const groups = tree.groups.reduce((sum, group) => sum + group[key], 0);
  return tree.noGroup[key] + groups + tree.later[key] + tree.done[key];
}
