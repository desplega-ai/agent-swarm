import { useQuery } from "@tanstack/react-query";
import {
  AlarmClock,
  Archive,
  ArrowDownToDot,
  CircleHelp,
  Columns2,
  FolderInput,
  History,
  Inbox,
  Mail,
  MailOpen,
  MessageSquare,
  Pencil,
  Plus,
  SquareX,
} from "lucide-react";
import { useLayoutEffect, useMemo, useRef } from "react";
import { sessionsQueryOptions, useSession } from "@/api/hooks/use-sessions";
import { useUsers } from "@/api/hooks/use-users";
import type { SessionListItem } from "@/api/types";
import {
  type CommandMenuItem,
  useCommandMenuGroup,
  useCommandMenuSearch,
} from "@/components/shared/command-menu";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { searchableGroups } from "@/lib/session-groups";
import {
  paletteSearchParams,
  parseSessionSearch,
  type SessionSearchParams,
} from "@/lib/session-search";
import { useSessionsFilter } from "@/lib/sessions-show";
import { isSessionTab, itemFromDetail, userName } from "@/lib/sessions-v2";
import { sessionDisplayTitle } from "@/lib/utils";
import type { RowMenuActions } from "./sidebar/row-menu";
import type { TreeRow } from "./sidebar/tree-rows";
import { useMyGroups } from "./use-my-groups";

/** Jump to: this many sessions with an empty palette, and this many from the server for text. */
const JUMP_IDLE = 5;
const JUMP_SEARCH = 8;

/**
 * The sessions the server finds for some text, with the sidebar search
 * tokens (`with:lena is:unread`). `idle` is what to ask for with no text
 * (keep it a stable object); without it, no text asks for nothing. The
 * last matches stay while the next ones load, so the list holds still.
 */
export function useServerSessionSearch(
  text: string,
  { limit, idle }: { limit: number; idle?: SessionSearchParams },
) {
  const { userId } = useCurrentUser();
  const me = userId ?? null;
  // The search query reads the filter (Mine / All, hidden sources): re-render on a change.
  useSessionsFilter();
  const wantsPeople = parseSessionSearch(text).with.length > 0;
  const users = useUsers({ enabled: wantsPeople });
  const { groups } = useMyGroups(me);
  const params = useMemo(() => {
    if (!text.trim() && idle) return idle;
    const people = users.data ?? [];
    const nameOf = (id: string) => userName(people, id);
    const searchGroups = groups ? searchableGroups(groups, me, nameOf) : [];
    return paletteSearchParams(text, { people, groups: searchGroups });
  }, [text, idle, users.data, groups, me]);
  const found = useQuery({
    ...sessionsQueryOptions(me, { ...params, scope: "tree", limit, enabled: params !== null }),
    placeholderData: (previous) => previous,
  });
  return {
    params,
    sessions: params ? (found.data?.sessions ?? []) : [],
    /** The sessions on hand answer earlier text: the server has not answered this text yet. */
    stale: params !== null && (found.isPlaceholderData || found.isPending),
  };
}

/** What the commands do in the sidebar. The commands pass the focused session. */
export interface SessionsCommandsApi {
  open: (id: string) => void;
  /** A New session tab in the group under the cursor (as `c`), else No group. */
  newSession: () => void;
  /** Pick a group, then open a New session tab there. */
  newSessionIn: () => void;
  nextUnread: () => void;
  /** Open the move dialog for these sessions. */
  move: (sessions: SessionListItem[]) => void;
  rename: () => void;
  /** Read, Done, and back to the Inbox: the row menu's actions. */
  triage: Pick<RowMenuActions, "toggleRead" | "done" | "backToInbox">;
  /** Open the Later choices for the session, at its row. */
  later: (session: SessionListItem) => void;
  legacy: () => void;
  /** "Open in split…": pick a session for the split pane. */
  pickSplit: () => void;
  /** "Close the split": only while a split is open. */
  closeSplit?: () => void;
  /** "Show the guide". */
  showGuide: () => void;
}

/** Each session once: the loaded rows of the tree, in row order. */
function sessionsOf(rows: TreeRow[]): SessionListItem[] {
  const found = new Map<string, SessionListItem>();
  for (const row of rows) if (row.type === "session") found.set(row.session.root.id, row.session);
  return [...found.values()];
}

/** Needs you first, then unread, then the newest. */
function byAttention(a: SessionListItem, b: SessionListItem): number {
  const rank = (s: SessionListItem) => (s.needsYou ? 2 : s.readState === "unread" ? 1 : 0);
  return rank(b) - rank(a) || b.lastActivityAt.localeCompare(a.lastActivityAt);
}

/**
 * The "Sessions" group of the Cmd+K palette while the v2 view is open (plan
 * Phase 5). Jump to: with an empty palette, the 5 sessions that need you
 * most from the loaded lists; with text, the server's 8 best matches, so
 * the palette finds every session, not only the loaded rows (brainstorm
 * decision 15). Then the actions on the focused session, "Open in split…",
 * "Close the split", "Show the guide" (Phase 8), and the switch to the
 * Legacy view.
 *
 * It owns the one registration of the group id `sessions` in the v2 view
 * (the legacy page registers its own only in the legacy view).
 */
export function useSessionsCommands({
  focused,
  rows,
  treeRows,
  canTriage,
  api,
}: {
  /** The focused tab: a session id or `NEW_SESSION_TAB`. */
  focused: string;
  /** The rows on screen (the tree, or the search results). */
  rows: TreeRow[];
  /** The tree rows: the sessions the sidebar holds now, for Jump to with an empty palette. */
  treeRows: TreeRow[];
  canTriage: boolean;
  api: SessionsCommandsApi;
}) {
  // Through a ref: a new api object never registers the group again.
  const latest = useRef(api);
  useLayoutEffect(() => {
    latest.current = api;
  });

  const search = useCommandMenuSearch();
  const text = useDebouncedValue(search.trim(), 200);
  // The palette text takes the sidebar search tokens (`with:lena is:unread`).
  const jump = useServerSessionSearch(text, { limit: JUMP_SEARCH });
  // The pane polls the focused session: this reader adds no timer.
  const detail = useSession(isSessionTab(focused) ? focused : undefined, { poll: "off" }).data;

  const loaded = useMemo(() => sessionsOf(treeRows), [treeRows]);
  const target = useMemo(() => {
    const row =
      sessionsOf(rows).find((session) => session.root.id === focused) ??
      loaded.find((session) => session.root.id === focused);
    return row ?? (detail ? itemFromDetail(detail) : null);
  }, [rows, loaded, focused, detail]);
  const canRename = detail !== undefined && detail.access !== "read";
  const jumpSessions = useMemo(() => {
    if (search.trim()) return jump.sessions;
    return loaded
      .filter((session) => session.readState !== "done" && session.readState !== "later")
      .filter((session) => session.root.id !== focused)
      .sort(byAttention)
      .slice(0, JUMP_IDLE);
  }, [search, jump.sessions, loaded, focused]);

  const splitOpen = api.closeSplit !== undefined;
  const items = useMemo((): CommandMenuItem[] => {
    const run = (pick: (a: SessionsCommandsApi) => void) => () => pick(latest.current);
    const actions: CommandMenuItem[] = [
      {
        id: "new",
        label: "New session",
        icon: Plus,
        shortcut: "C",
        onSelect: run((a) => a.newSession()),
      },
      {
        id: "new-in",
        label: "New session in group…",
        icon: Plus,
        keywords: ["start", "group"],
        onSelect: run((a) => a.newSessionIn()),
      },
      {
        id: "next-unread",
        label: "Next unread",
        icon: ArrowDownToDot,
        shortcut: "N",
        onSelect: run((a) => a.nextUnread()),
      },
    ];
    if (target) {
      const title = sessionDisplayTitle(target.root);
      actions.push({
        id: "move",
        label: "Move to group…",
        icon: FolderInput,
        shortcut: "M",
        keywords: [title],
        onSelect: run((a) => a.move([target])),
      });
      if (canRename) {
        actions.push({
          id: "rename",
          label: "Rename session",
          icon: Pencil,
          keywords: ["title", title],
          onSelect: run((a) => a.rename()),
        });
      }
      if (canTriage) {
        const unread = target.readState === "unread";
        actions.push({
          id: "read",
          label: unread ? "Mark read" : "Mark unread",
          icon: unread ? MailOpen : Mail,
          shortcut: "U",
          onSelect: run((a) => a.triage.toggleRead([target])),
        });
        actions.push(
          target.readState === "done"
            ? {
                id: "done",
                label: "Move back to the Inbox",
                icon: Inbox,
                shortcut: "E",
                onSelect: run((a) => a.triage.backToInbox([target])),
              }
            : {
                id: "done",
                label: "Done",
                icon: Archive,
                shortcut: "E",
                keywords: ["archive"],
                onSelect: run((a) => a.triage.done([target])),
              },
        );
        actions.push(
          target.readState === "later"
            ? {
                id: "later",
                label: "Move back to the Inbox",
                icon: Inbox,
                shortcut: "L",
                onSelect: run((a) => a.triage.backToInbox([target])),
              }
            : {
                id: "later",
                label: "Later…",
                icon: AlarmClock,
                shortcut: "L",
                keywords: ["snooze"],
                onSelect: run((a) => a.later(target)),
              },
        );
      }
    }
    actions.push({
      id: "split",
      label: "Open in split…",
      icon: Columns2,
      shortcut: "V",
      keywords: ["pane", "side by side"],
      onSelect: run((a) => a.pickSplit()),
    });
    if (splitOpen) {
      actions.push({
        id: "close-split",
        label: "Close the split",
        icon: SquareX,
        keywords: ["pane"],
        onSelect: run((a) => a.closeSplit?.()),
      });
    }
    actions.push({
      id: "guide",
      label: "Show the guide",
      icon: CircleHelp,
      shortcut: "?",
      keywords: ["help", "keys", "shortcuts"],
      onSelect: run((a) => a.showGuide()),
    });
    actions.push({
      id: "legacy",
      label: "Legacy sessions",
      icon: History,
      onSelect: run((a) => a.legacy()),
    });
    const jumps = jumpSessions.map(
      (session): CommandMenuItem => ({
        id: `jump:${session.root.id}`,
        label: sessionDisplayTitle(session.root),
        icon: MessageSquare,
        // The server already matched these on the text: keep them past the palette filter.
        keywords: search ? [search] : undefined,
        onSelect: run((a) => a.open(session.root.id)),
      }),
    );
    return [...actions, ...jumps];
  }, [target, canRename, canTriage, jumpSessions, search, splitOpen]);

  useCommandMenuGroup("sessions", "Sessions", items);
}
