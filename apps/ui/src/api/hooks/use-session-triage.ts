import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { useCurrentUser } from "@/contexts/current-user-context";
import { getSessionsHiddenSources, getSessionsShow } from "@/lib/sessions-show";
import { plural, SESSIONS_TOAST_POSITION, sidebarListParams } from "@/lib/sessions-v2";
import { api } from "../client";
import type { InboxItemStatus } from "../types";
import { SESSION_LIST_KEY, SESSION_TREE_KEY, sessionDetailKey } from "./session-query-keys";
import {
  patchTriageCaches,
  rollBackTriageCaches,
  type TriageAction,
  type TriageContext,
} from "./session-triage-cache";

export type { TriageAction } from "./session-triage-cache";

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

interface TriageVariables {
  targets: TriageTarget[];
  action: TriageAction;
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
      const ids = new Set(targets.map((target) => target.rootId));
      // Only this user's caches: the rows carry this user's read state. A
      // poll that started before the write would bring the old state back.
      await Promise.all([
        queryClient.cancelQueries({ queryKey: [...SESSION_LIST_KEY, userId ?? null] }),
        queryClient.cancelQueries({ queryKey: [...SESSION_TREE_KEY, userId ?? null] }),
        ...[...ids].map((id) =>
          queryClient.cancelQueries({ queryKey: sessionDetailKey(id, userId ?? null) }),
        ),
      ]);
      return patchTriageCaches(queryClient, userId ?? null, ids, action);
    },
    onError: (error, _variables, context) => {
      if (context) rollBackTriageCaches(queryClient, context);
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

/** A whole-list action of "Select all N". */
export type SessionListAction = "done" | "inbox" | "read" | "unread";

const LIST_ACTION_DONE: Record<SessionListAction, string> = {
  done: "marked Done",
  inbox: "moved back to the Inbox",
  read: "marked read",
  unread: "marked unread",
};

/**
 * "Select all N": one action on every session of a sidebar list, loaded or
 * not (`POST /api/session-triage`, with the list's filter: Mine / All and
 * the hidden sources). No optimistic patch and no Undo: the rows were never
 * loaded. The tree, the lists, and the open details refetch when it lands.
 */
export function useSessionListTriage() {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({ container, action }: { container: string; action: SessionListAction }) => {
      const { triage, noGroup, groupKey } = sidebarListParams(container);
      const hidden = getSessionsHiddenSources();
      return api.triageSessionList({
        action,
        ...(triage === "inbox" || triage === "later" || triage === "done" ? { triage } : {}),
        ...(noGroup ? { noGroup } : {}),
        ...(groupKey ? { groupKey } : {}),
        ...(getSessionsShow() === "all" ? { show: "all" as const } : {}),
        ...(hidden.length > 0 ? { hideSource: [...hidden] } : {}),
      });
    },
    onSuccess: ({ updated }, { action }) => {
      toast(`${plural(updated, "session")} ${LIST_ACTION_DONE[action]}.`, {
        position: SESSIONS_TOAST_POSITION,
      });
    },
    onError: (error) => {
      toast.error(error.message || "Couldn't update the sessions", {
        position: SESSIONS_TOAST_POSITION,
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: SESSION_TREE_KEY });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      void queryClient.invalidateQueries({ queryKey: ["session"] });
      void queryClient.invalidateQueries({ queryKey: ["inbox-state"] });
    },
  });
  const { mutate, isPending } = mutation;
  return useMemo(
    () => ({
      isPending,
      run: (container: string, action: SessionListAction) => mutate({ container, action }),
    }),
    [mutate, isPending],
  );
}
