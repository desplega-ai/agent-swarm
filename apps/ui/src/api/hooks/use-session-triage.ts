import { type QueryKey, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { useCurrentUser } from "@/contexts/current-user-context";
import { api } from "../client";
import type { InboxItemStatus, SessionListItem, SessionsListResponse } from "../types";
import { SESSION_TREE_KEY } from "./use-session-tree";
import { SESSION_LIST_KEY } from "./use-sessions";

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
function optimisticRow(action: TriageAction): Pick<SessionListItem, "readState" | "snoozeUntil"> {
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

interface TriageVariables {
  targets: TriageTarget[];
  action: TriageAction;
}

interface TriageContext {
  snapshots: Array<[QueryKey, SessionsListResponse | undefined]>;
}

/**
 * Read, unread, Done, Later, and back to the Inbox for one session or a
 * selection. One session writes `PATCH /api/inbox-state`; a selection writes
 * the bulk route. Rows in the cached list pages change at once and roll back
 * with a toast on failure. The tree is not recounted here (that would repeat
 * the server's read rule): the tree and the lists refetch when the last
 * write in flight settles.
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
      // A poll that started before the write would bring the old state back.
      await queryClient.cancelQueries({ queryKey: SESSION_LIST_KEY });
      const snapshots = queryClient.getQueriesData<SessionsListResponse>({
        queryKey: SESSION_LIST_KEY,
      });
      const ids = new Set(targets.map((target) => target.rootId));
      const patch = optimisticRow(action);
      queryClient.setQueriesData<SessionsListResponse>({ queryKey: SESSION_LIST_KEY }, (page) =>
        page
          ? {
              ...page,
              sessions: page.sessions.map((row) =>
                ids.has(row.root.id) ? { ...row, ...patch } : row,
              ),
            }
          : page,
      );
      return { snapshots };
    },
    onError: (error, _variables, context) => {
      for (const [key, data] of context?.snapshots ?? []) queryClient.setQueryData(key, data);
      toast.error(error.message || "Couldn't update the session");
    },
    onSettled: () => {
      // Fast triage (keys, the bulk bar) overlaps writes. A refetch after an
      // early one would bring back rows that a later write already changed,
      // and the rows would flicker. Refetch once, after the last one.
      if (queryClient.isMutating({ mutationKey: TRIAGE_MUTATION_KEY }) > 1) return;
      void queryClient.invalidateQueries({ queryKey: SESSION_TREE_KEY });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      // The dashboard inbox reads the same rows.
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
