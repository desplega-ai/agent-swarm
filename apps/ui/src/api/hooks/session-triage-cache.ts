// The optimistic cache patches of a triage write (`useSessionTriage`): the
// rows on the cached list pages, the open session details, and the rows
// that arrive in the sidebar's Later or Done list with that section's count.
//
// Relative imports only: `bun:test` runs this from the repo root.

import { hashKey, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { getSessionsShow, type SessionsShow } from "../../lib/sessions-show";
import { sidebarListParams } from "../../lib/sessions-v2";
import type {
  SessionDetailResponse,
  SessionListItem,
  SessionReadState,
  SessionsListResponse,
  SessionTreeResponse,
} from "../types";
import {
  SESSION_LIST_KEY,
  SESSION_TREE_KEY,
  type SessionListParams,
  sessionDetailKey,
  sessionListKey,
  sessionListParams,
  sessionListParamsOf,
  sessionListView,
  sessionTreeKey,
} from "./session-query-keys";

export type TriageAction =
  | { kind: "read" }
  | { kind: "unread" }
  | { kind: "done" }
  | { kind: "later"; until: string }
  | { kind: "inbox" };

/**
 * The row state to show until the server answers. The server applies the
 * read rule (D5) on the next fetch. Back to the Inbox shows as read: the
 * user just looked at the session.
 */
type RowPatch = { readState: SessionReadState; snoozeUntil: SessionListItem["snoozeUntil"] };

function optimisticRow(action: TriageAction): RowPatch {
  switch (action.kind) {
    case "read":
    case "inbox":
      return { readState: "read", snoozeUntil: null };
    case "unread":
      return { readState: "unread", snoozeUntil: null };
    case "done":
      return { readState: "done", snoozeUntil: null };
    case "later":
      return { readState: "later", snoozeUntil: action.until };
  }
}

/**
 * Whether a list page still holds a row in `state`. Inbox, group, and No
 * group lists hold Inbox sessions only (read or unread), as the server does.
 * Later, Done, and Unread lists hold their own state. Any other list (the
 * legacy view) holds every state.
 */
function listHolds(params: SessionListParams | undefined, state: SessionReadState): boolean {
  switch (params?.triage) {
    case "unread":
      return state === "unread";
    case "later":
    case "done":
      return state === params.triage;
    case "inbox":
      return state === "read" || state === "unread";
  }
  if (params?.groupKey || params?.keyPrefix || params?.noGroup) {
    return state === "read" || state === "unread";
  }
  return true;
}

/** What one write changed on one cached page, so a failure can undo just that. */
interface PageChange {
  key: QueryKey;
  /** The rows before the patch, by root id. */
  patched: Map<string, SessionListItem>;
  /** The rows that left the page, at their old place (ascending). */
  removed: Array<{ row: SessionListItem; index: number }>;
}

/** Rows that a write moved into one view's Later or Done list, and the section count it raised. */
interface Arrival {
  section: "later" | "done";
  listKey: QueryKey;
  treeKey: QueryKey;
  ids: string[];
}

export interface TriageContext {
  patch: RowPatch;
  changes: PageChange[];
  /** One per Mine / All view that the moved rows belong to. */
  arrivals: Arrival[];
  /** The open session details this write patched, with their read state before it. */
  details: Array<{ key: QueryKey; before: SessionReadState }>;
  /** The list fetches the write cancelled before it patched (`cancelForTriage`). */
  interrupted?: QueryKey[];
  /** A row this write changed was in Later or Done, so it moves to a list that never held it. */
  leftLaterOrDone: boolean;
}

/**
 * Cancel this user's list, tree and detail fetches before a triage write
 * patches them: a poll that started before the write would bring the old
 * state back. Returns the list fetches it cut short, which the refetch
 * after the write must cover (a first load cancelled here has no rows).
 */
export async function cancelForTriage(
  queryClient: QueryClient,
  userId: string | null,
  ids: Set<string>,
): Promise<QueryKey[]> {
  const listKey = [...SESSION_LIST_KEY, userId];
  const interrupted = queryClient
    .getQueryCache()
    .findAll({ queryKey: listKey, fetchStatus: "fetching" })
    .map((query) => query.queryKey);
  await Promise.all([
    queryClient.cancelQueries({ queryKey: listKey }),
    queryClient.cancelQueries({ queryKey: [...SESSION_TREE_KEY, userId] }),
    ...[...ids].map((id) => queryClient.cancelQueries({ queryKey: sessionDetailKey(id, userId) })),
  ]);
  return interrupted;
}

/**
 * Where a row that arrives in Later or Done goes on the page: Later by wake
 * time (the server's order), Done by newest activity. The rows already
 * there keep their order.
 */
function insertArrived(
  sessions: SessionListItem[],
  row: SessionListItem,
  section: Arrival["section"],
): SessionListItem[] {
  const before = (other: SessionListItem) =>
    section === "later"
      ? (row.snoozeUntil ?? "") < (other.snoozeUntil ?? "\uffff")
      : row.lastActivityAt > other.lastActivityAt;
  const at = sessions.findIndex(before);
  return at < 0 ? [...sessions, row] : [...sessions.slice(0, at), row, ...sessions.slice(at)];
}

/**
 * Whether a list page of `pageView` shows only sessions that `view` shows
 * too. Mine is a subset of All, so All takes rows from either view, and
 * Mine only from Mine: an All row may be a workflow run that Mine hides.
 */
function viewCovers(view: SessionsShow, pageView: SessionsShow | null): boolean {
  return pageView !== null && (view === "all" || pageView === "mine");
}

/**
 * Undo one write on one page: a patched row goes back only while it still
 * shows this write's value, and a removed row comes back only while it is
 * still gone. A newer write to the same row (fast keys, the bulk bar) keeps
 * its own state.
 */
function rollBackPage(
  page: SessionsListResponse,
  change: PageChange,
  patch: RowPatch,
): SessionsListResponse {
  let sessions = page.sessions.map((row) => {
    const before = change.patched.get(row.root.id);
    const ours = row.readState === patch.readState && row.snoozeUntil === patch.snoozeUntil;
    return before && ours ? before : row;
  });
  let restored = 0;
  for (const { row, index } of change.removed) {
    if (sessions.some((r) => r.root.id === row.root.id)) continue;
    sessions = [...sessions.slice(0, index), row, ...sessions.slice(index)];
    restored++;
  }
  return { ...page, sessions, total: page.total + restored };
}

/**
 * Patch this user's cached pages, tree, and details for one write. Rows in
 * the cached list pages change at once (a row that leaves a list drops out
 * of it), and so does the read state of a cached session detail (the pane
 * header). A row that moves into Later or Done also lands in the sidebar's
 * list of that section, and that section's count goes up, so the section
 * never flashes its empty state. Each Mine / All view gets only rows from
 * its own pages (see `viewCovers`). The view on screen gets its section
 * list even when that list is not loaded yet (it was empty); the other view
 * only has what it already cached patched.
 */
export function patchTriageCaches(
  queryClient: QueryClient,
  userId: string | null,
  ids: Set<string>,
  action: TriageAction,
): TriageContext {
  const pages = queryClient.getQueriesData<SessionsListResponse>({
    queryKey: [...SESSION_LIST_KEY, userId],
  });
  const patch = optimisticRow(action);
  const details: TriageContext["details"] = [];
  const parked = (state: SessionReadState | undefined) => state === "later" || state === "done";
  let leftLaterOrDone = false;
  for (const id of ids) {
    const key = sessionDetailKey(id, userId);
    const detail = queryClient.getQueryData<SessionDetailResponse>(key);
    if (!detail?.readState) continue;
    if (parked(detail.readState) && detail.readState !== patch.readState) leftLaterOrDone = true;
    details.push({ key, before: detail.readState });
    queryClient.setQueryData<SessionDetailResponse>(key, { ...detail, readState: patch.readState });
  }
  const changes: PageChange[] = [];
  // A row that leaves its list (Done or Later out of the Inbox and the
  // groups, back to the Inbox out of Later and Done) drops out at once, so
  // the next row moves up. The other rows show the new state.
  for (const [key, page] of pages) {
    if (!page?.sessions.some((row) => ids.has(row.root.id))) continue;
    const holds = listHolds(sessionListParamsOf(key), patch.readState);
    const change: PageChange = { key, patched: new Map(), removed: [] };
    const sessions: SessionListItem[] = [];
    page.sessions.forEach((row, index) => {
      if (!ids.has(row.root.id)) {
        sessions.push(row);
        return;
      }
      if (parked(row.readState) && row.readState !== patch.readState) leftLaterOrDone = true;
      if (holds) {
        change.patched.set(row.root.id, row);
        sessions.push({ ...row, ...patch });
      } else change.removed.push({ row, index });
    });
    changes.push(change);
    queryClient.setQueryData<SessionsListResponse>(key, {
      ...page,
      sessions,
      total: Math.max(0, page.total - change.removed.length),
    });
  }
  const arrivals: Arrival[] = [];
  if (patch.readState === "later" || patch.readState === "done") {
    const section = patch.readState;
    const current = getSessionsShow();
    for (const view of ["mine", "all"] as const) {
      const moved = new Map<string, SessionListItem>();
      for (const [key, page] of pages) {
        if (!viewCovers(view, sessionListView(sessionListParamsOf(key)))) continue;
        for (const row of page?.sessions ?? []) {
          if (ids.has(row.root.id) && row.readState !== section && !moved.has(row.root.id)) {
            moved.set(row.root.id, { ...row, ...patch });
          }
        }
      }
      if (moved.size === 0) continue;
      const params = sessionListParams(sidebarListParams(section), view);
      const listKey = sessionListKey(userId, params);
      const treeKey = sessionTreeKey(userId, view);
      queryClient.setQueryData<SessionTreeResponse>(treeKey, (tree) =>
        tree
          ? { ...tree, [section]: { ...tree[section], total: tree[section].total + moved.size } }
          : tree,
      );
      queryClient.setQueryData<SessionsListResponse>(listKey, (page) => {
        if (!page && view !== current) return page;
        const base = page ?? { sessions: [], total: 0, limit: params.limit, offset: 0 };
        let sessions = base.sessions;
        for (const row of moved.values()) {
          if (!sessions.some((other) => other.root.id === row.root.id)) {
            sessions = insertArrived(sessions, row, section);
          }
        }
        return { ...base, sessions, total: base.total + sessions.length - base.sessions.length };
      });
      arrivals.push({ section, listKey, treeKey, ids: [...moved.keys()] });
    }
  }
  return { patch, changes, details, arrivals, leftLaterOrDone };
}

/** Undo `patchTriageCaches` after a failed write. A newer write to the same row keeps its state. */
export function rollBackTriageCaches(queryClient: QueryClient, context: TriageContext) {
  const { patch } = context;
  for (const change of context.changes) {
    queryClient.setQueryData<SessionsListResponse>(change.key, (page) =>
      page ? rollBackPage(page, change, patch) : page,
    );
  }
  // The rows that arrived in Later or Done leave again, while they still
  // show this write's state.
  for (const { section, listKey, treeKey, ids } of context.arrivals) {
    const arrived = new Set(ids);
    queryClient.setQueryData<SessionsListResponse>(listKey, (page) => {
      if (!page) return page;
      const sessions = page.sessions.filter(
        (row) => !(arrived.has(row.root.id) && row.readState === patch.readState),
      );
      return {
        ...page,
        sessions,
        total: Math.max(0, page.total - (page.sessions.length - sessions.length)),
      };
    });
    queryClient.setQueryData<SessionTreeResponse>(treeKey, (tree) =>
      tree
        ? {
            ...tree,
            [section]: { ...tree[section], total: Math.max(0, tree[section].total - ids.length) },
          }
        : tree,
    );
  }
  for (const { key, before } of context.details) {
    queryClient.setQueryData<SessionDetailResponse>(key, (detail) =>
      detail && detail.readState === patch.readState ? { ...detail, readState: before } : detail,
    );
  }
}

/** What the triage writes in flight since the last refetch need refetched. */
interface PendingRefresh {
  /** A write other than "read" settled: refetch every list. */
  all: boolean;
  /** The list pages that held a row a "read" write changed, by key hash. */
  lists: Map<string, QueryKey>;
}

const pendingRefresh = new WeakMap<QueryClient, PendingRefresh>();

/**
 * The refetch after a triage write settles, once no other write is in
 * flight (`othersInFlight`). A refetch after an early write would bring
 * back rows that a later write already changed, so the writes in between
 * only add to what the last one refetches.
 *
 * Opening an unread session marks it read, so "read" is the common write.
 * It changes no list's membership except lists that held the row (an
 * Unread list drops it), and the rows already show it. So it refetches
 * the tree (its counts), those lists, and the list fetches it cancelled
 * (opening a session from a link cancels the Inbox's first load). A read
 * that takes a row out of Later or Done, and every other write, refetches
 * every list: a row can arrive in a list that never held it.
 */
export function refreshAfterTriage(
  queryClient: QueryClient,
  action: TriageAction,
  context: TriageContext | undefined,
  othersInFlight: boolean,
) {
  const pending = pendingRefresh.get(queryClient) ?? { all: false, lists: new Map() };
  pendingRefresh.set(queryClient, pending);
  if (action.kind === "read" && context && !context.leftLaterOrDone) {
    for (const { key } of context.changes) pending.lists.set(hashKey(key), key);
    for (const key of context.interrupted ?? []) pending.lists.set(hashKey(key), key);
  } else pending.all = true;
  if (othersInFlight) return;
  pendingRefresh.delete(queryClient);
  void queryClient.invalidateQueries({ queryKey: SESSION_TREE_KEY });
  if (pending.all) void queryClient.invalidateQueries({ queryKey: ["sessions"] });
  else {
    for (const key of pending.lists.values()) {
      void queryClient.invalidateQueries({ queryKey: key, exact: true });
    }
  }
  // The dashboard inbox (and the pane's Later wake time) read the same rows.
  void queryClient.invalidateQueries({ queryKey: ["inbox-state"] });
}
