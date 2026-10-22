import { type QueryKey, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { useCurrentUser } from "@/contexts/current-user-context";
import { SESSIONS_TOAST_POSITION, sidebarListParams } from "@/lib/sessions-v2";
import { api } from "../client";
import type {
  InboxItemStatus,
  SessionDetailResponse,
  SessionListItem,
  SessionReadState,
  SessionsListResponse,
  SessionTreeResponse,
} from "../types";
import { SESSION_TREE_KEY } from "./use-session-tree";
import {
  SESSION_LIST_KEY,
  type SessionListParams,
  sessionDetailKey,
  sessionListParamsOf,
  sessionsQueryOptions,
} from "./use-sessions";

/** The read cursor that marks a session unread. The my-swarm app writes the same value. */
const UNREAD_CURSOR = "1970-01-01T00:00:00.000Z";

/** `PATCH /api/inbox-state/bulk` takes at most 200 rows. */
const BULK_LIMIT = 200;

/** Every triage write shares it, so a write can tell whether others are still in flight. */
const TRIAGE_MUTATION_KEY = ["session-triage"] as const;

/** A session to triage: its root id, and its newest activity (the read cursor of "read"). */
export interface TriageTarget {
  rootId: string;
  lastActivityAt: string;
}

export type TriageAction =
  | { kind: "read" }
  | { kind: "unread" }
  | { kind: "done" }
  | { kind: "later"; until: string }
  | { kind: "inbox" };

interface TriageWrite {
  status: InboxItemStatus;
  readAt?: string;
  lastReadAt?: string;
  snoozeUntil?: string;
}

/** The `inbox_item_state` write of an action, in the my-swarm app's shapes, so both clients agree. */
function writeFor(action: TriageAction, target: TriageTarget, now: string): TriageWrite {
  switch (action.kind) {
    case "read":
      return { status: "open", readAt: now, lastReadAt: target.lastActivityAt };
    case "unread":
      return { status: "open", lastReadAt: UNREAD_CURSOR };
    case "done":
      return { status: "done" };
    case "later":
      return { status: "snoozed", snoozeUntil: action.until };
    case "inbox":
      return { status: "open" };
  }
}

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

interface TriageVariables {
  targets: TriageTarget[];
  action: TriageAction;
}

/** What one write changed on one cached page, so a failure can undo just that. */
interface PageChange {
  key: QueryKey;
  /** The rows before the patch, by root id. */
  patched: Map<string, SessionListItem>;
  /** The rows that left the page, at their old place (ascending). */
  removed: Array<{ row: SessionListItem; index: number }>;
}

/** Rows that a write moved into the sidebar's Later or Done list, and the section count it raised. */
interface Arrival {
  section: "later" | "done";
  listKey: QueryKey;
  treeKey: QueryKey;
  ids: string[];
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

interface TriageContext {
  patch: RowPatch;
  changes: PageChange[];
  arrival: Arrival | null;
  /** The open session details this write patched, with their read state before it. */
  details: Array<{ key: QueryKey; before: SessionReadState }>;
}

/**
 * Undo one write on one page: a patched row goes back only while it still
 * shows this write's value, and a removed row comes back only while it is
 * still gone. A newer write to the same row (fast keys, the bulk bar) keeps
 * its own state.
 */
function rollBack(
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
 * Read, unread, Done, Later, and back to the Inbox for one session or a
 * selection. One session writes `PATCH /api/inbox-state`; a selection writes
 * the bulk route. Rows in the cached list pages change at once (a row that
 * leaves a list drops out of it), and so does the read state of a cached
 * session detail (the pane header). A row that moves into Later or Done
 * also lands in the sidebar's list of that section, and that section's
 * count goes up, so the section never flashes its empty state. All of it
 * rolls back with a toast on failure. The other tree counts are not
 * recounted here (that would repeat the server's read rule): the tree and
 * the lists refetch when the last write in flight settles.
 *
 * `canTriage` is false without a picked user (an operator key alone): there
 * is no user to write for, so hide the controls.
 */
export function useSessionTriage() {
  const { userId } = useCurrentUser();
  const queryClient = useQueryClient();
  const mutation = useMutation<unknown, Error, TriageVariables, TriageContext>({
    mutationKey: TRIAGE_MUTATION_KEY,
    mutationFn: async ({ targets, action }) => {
      if (!userId) throw new Error("Pick a user to triage sessions.");
      const now = new Date().toISOString();
      const items = targets.map((target) => ({
        itemType: "to_read" as const,
        itemId: target.rootId,
        ...writeFor(action, target, now),
      }));
      if (items.length === 1) {
        await api.patchInboxState({ userId, ...items[0] });
        return;
      }
      for (let i = 0; i < items.length; i += BULK_LIMIT) {
        await api.patchInboxStateBulk({ userId, items: items.slice(i, i + BULK_LIMIT) });
      }
    },
    onMutate: async ({ targets, action }) => {
      // Only this user's pages: the rows carry this user's read state.
      const listKey = [...SESSION_LIST_KEY, userId ?? null];
      const treeKey = [...SESSION_TREE_KEY, userId ?? null];
      const ids = new Set(targets.map((target) => target.rootId));
      // A poll that started before the write would bring the old state back.
      await Promise.all([
        queryClient.cancelQueries({ queryKey: listKey }),
        queryClient.cancelQueries({ queryKey: treeKey }),
        ...[...ids].map((id) =>
          queryClient.cancelQueries({ queryKey: sessionDetailKey(id, userId ?? null) }),
        ),
      ]);
      const pages = queryClient.getQueriesData<SessionsListResponse>({ queryKey: listKey });
      const patch = optimisticRow(action);
      // The open session's header shows the new state at once, too.
      const details: TriageContext["details"] = [];
      for (const id of ids) {
        // This user's detail (the pane header reads its read state).
        const key = sessionDetailKey(id, userId ?? null);
        const detail = queryClient.getQueryData<SessionDetailResponse>(key);
        if (!detail?.readState) continue;
        details.push({ key, before: detail.readState });
        queryClient.setQueryData<SessionDetailResponse>(key, {
          ...detail,
          readState: patch.readState,
        });
      }
      const changes: PageChange[] = [];
      // A row that leaves its list (Done or Later out of the Inbox and the
      // groups, back to the Inbox out of Later and Done) drops out at once,
      // so the next row moves up. The other rows show the new state.
      for (const [key, page] of pages) {
        if (!page?.sessions.some((row) => ids.has(row.root.id))) continue;
        const holds = listHolds(sessionListParamsOf(key), patch.readState);
        const change: PageChange = { key, patched: new Map(), removed: [] };
        const sessions: SessionListItem[] = [];
        page.sessions.forEach((row, index) => {
          if (!ids.has(row.root.id)) sessions.push(row);
          else if (holds) {
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
      // A row that moves into Later or Done shows there at once. Without
      // this, a Later or Done list that was empty shows its empty state
      // ("Nothing snoozed.") until the refetch after the write. The section
      // count goes up by the rows that arrive, and the sidebar's list of
      // that section gets them (it may not be loaded yet: it was empty).
      let arrival: Arrival | null = null;
      if (patch.readState === "later" || patch.readState === "done") {
        const section = patch.readState;
        const moved = new Map<string, SessionListItem>();
        for (const [, page] of pages) {
          for (const row of page?.sessions ?? []) {
            if (ids.has(row.root.id) && row.readState !== section && !moved.has(row.root.id)) {
              moved.set(row.root.id, { ...row, ...patch });
            }
          }
        }
        if (moved.size > 0) {
          const params = sidebarListParams(section);
          const sectionKey = sessionsQueryOptions(userId ?? null, params).queryKey;
          queryClient.setQueryData<SessionTreeResponse>(treeKey, (tree) =>
            tree
              ? {
                  ...tree,
                  [section]: { ...tree[section], total: tree[section].total + moved.size },
                }
              : tree,
          );
          queryClient.setQueryData<SessionsListResponse>(sectionKey, (page) => {
            const base = page ?? { sessions: [], total: 0, limit: params.limit, offset: 0 };
            let sessions = base.sessions;
            for (const row of moved.values()) {
              if (!sessions.some((other) => other.root.id === row.root.id)) {
                sessions = insertArrived(sessions, row, section);
              }
            }
            return {
              ...base,
              sessions,
              total: base.total + sessions.length - base.sessions.length,
            };
          });
          arrival = { section, listKey: sectionKey, treeKey, ids: [...moved.keys()] };
        }
      }
      return { patch, changes, details, arrival };
    },
    onError: (error, _variables, context) => {
      for (const change of context?.changes ?? []) {
        queryClient.setQueryData<SessionsListResponse>(change.key, (page) =>
          page ? rollBack(page, change, context!.patch) : page,
        );
      }
      // The rows that arrived in Later or Done leave again, while they still
      // show this write's state.
      if (context?.arrival) {
        const { section, listKey, treeKey, ids } = context.arrival;
        const arrived = new Set(ids);
        queryClient.setQueryData<SessionsListResponse>(listKey, (page) => {
          if (!page) return page;
          const sessions = page.sessions.filter(
            (row) => !(arrived.has(row.root.id) && row.readState === context.patch.readState),
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
                [section]: {
                  ...tree[section],
                  total: Math.max(0, tree[section].total - ids.length),
                },
              }
            : tree,
        );
      }
      // A newer write to the same session keeps its own state.
      for (const { key, before } of context?.details ?? []) {
        queryClient.setQueryData<SessionDetailResponse>(key, (detail) =>
          detail && detail.readState === context!.patch.readState
            ? { ...detail, readState: before }
            : detail,
        );
      }
      // Bottom left, over the sidebar: bottom right covers the composer's Send button.
      toast.error(error.message || "Couldn't update the session", {
        position: SESSIONS_TOAST_POSITION,
      });
    },
    onSettled: (_data, _error, { targets }) => {
      // Each session's detail refetches once no other write to it is in
      // flight (this write still counts), so a fast toggle never shows the
      // first answer over the second.
      for (const { rootId } of targets) {
        const writes = queryClient.isMutating({
          mutationKey: TRIAGE_MUTATION_KEY,
          predicate: (m) =>
            (m.state.variables as TriageVariables | undefined)?.targets.some(
              (target) => target.rootId === rootId,
            ) ?? false,
        });
        if (writes <= 1) void queryClient.invalidateQueries({ queryKey: ["session", rootId] });
      }
      // Fast triage (keys, the bulk bar) overlaps writes. A refetch after an
      // early one would bring back rows that a later write already changed,
      // and the rows would flicker. Refetch once, after the last one.
      if (queryClient.isMutating({ mutationKey: TRIAGE_MUTATION_KEY }) > 1) return;
      void queryClient.invalidateQueries({ queryKey: SESSION_TREE_KEY });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      // The dashboard inbox (and the pane's Later wake time) read the same rows.
      void queryClient.invalidateQueries({ queryKey: ["inbox-state"] });
    },
  });

  const { mutate, isPending } = mutation;
  return useMemo(() => {
    const run = (targets: TriageTarget | TriageTarget[], action: TriageAction) => {
      const list = Array.isArray(targets) ? targets : [targets];
      if (list.length > 0) mutate({ targets: list, action });
    };
    return {
      canTriage: Boolean(userId),
      isPending,
      markRead: (targets: TriageTarget | TriageTarget[]) => run(targets, { kind: "read" }),
      markUnread: (targets: TriageTarget | TriageTarget[]) => run(targets, { kind: "unread" }),
      done: (targets: TriageTarget | TriageTarget[]) => run(targets, { kind: "done" }),
      /** `until` is an ISO time: the session comes back to the Inbox as unread then. */
      later: (targets: TriageTarget | TriageTarget[], until: string) =>
        run(targets, { kind: "later", until }),
      backToInbox: (targets: TriageTarget | TriageTarget[]) => run(targets, { kind: "inbox" }),
    };
  }, [mutate, isPending, userId]);
}
