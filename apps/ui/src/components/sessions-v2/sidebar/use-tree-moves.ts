import { toast } from "sonner";
import { useMovePrefix, useMoveSessions } from "@/api/hooks/use-session-moves";
import type {
  SessionListItem,
  SessionMoveResult,
  SessionMoveSkip,
  SessionPrefixMoveResult,
} from "@/api/types";
import type { EmptyGroups } from "@/lib/empty-groups";
import {
  childGroupKey,
  groupCrumb,
  isNoGroupKey,
  personalOwner,
  renamedGroupKey,
  restoreKey,
} from "@/lib/session-groups";
import { plural, SESSIONS_TOAST_POSITION } from "@/lib/sessions-v2";
import { sessionDisplayTitle } from "@/lib/utils";
import { ownerFoldId } from "./tree-rows";

/** An Undo toast stays long enough to reach (UX review R9 P0). */
const UNDO_TOAST_MS = 5200;

const say = (message: string) => toast(message, { position: SESSIONS_TOAST_POSITION });

/** A toast names one session in one line: a long title is cut (SPEC R10.3). */
function toastTitle(session: SessionListItem): string {
  const title = sessionDisplayTitle(session.root);
  return title.length > 44 ? `${title.slice(0, 43).trimEnd()}…` : title;
}

/** "2 sessions stayed: Session write access required." One reason when they share it. */
function skippedText(skipped: SessionMoveSkip[]): string {
  if (skipped.length === 0) return "";
  const reasons = new Set(skipped.map((skip) => skip.reason));
  const why = reasons.size === 1 ? [...reasons][0] : "you can't move them";
  return ` ${plural(skipped.length, "session")} stayed: ${why.replace(/\.$/, "")}.`;
}

/** Each key and its parent groups, so a landing row is on screen. */
function withParents(key: string): string[] {
  const parts = key.split("/").filter(Boolean);
  const base = parts[0] === "personal" ? 2 : 1;
  const keys: string[] = [];
  for (let i = base + 1; i <= parts.length; i++) keys.push(`${parts.slice(0, i).join("/")}/`);
  return keys;
}

/**
 * Run a move and wait for it. A failure is already a toast with the
 * server's message (the moves hooks), so it gives null and changes nothing.
 * Each call waits for its own answer, so a second move never takes the
 * first one's toast or Undo.
 */
async function settle<T>(run: Promise<T>): Promise<T | null> {
  try {
    return await run;
  } catch {
    return null;
  }
}

/**
 * Moves and group edits from the sidebar (plan Phase 5): move sessions into
 * a group or to No group, and create, rename, or delete a group. Rename and
 * delete call the prefix move only when the server has sessions under the
 * group. A group with none lives in this browser (plan D8). Every toast
 * names what moved and what stayed (D9, D10).
 */
export function useTreeMoves({
  me,
  nameOf,
  emptyGroups,
  serverKeys,
  targetKeys,
  writeBlock,
  isOpen,
  setOpen,
  clearSelection,
}: {
  me: string | null;
  nameOf: (userId: string) => string;
  emptyGroups: EmptyGroups;
  /** Group keys the server has. */
  serverKeys: readonly string[];
  /** Every group in My groups, local ones included. */
  targetKeys: ReadonlySet<string>;
  /** Why a write into a key fails on this connection, or null. */
  writeBlock: (key: string | null) => string | null;
  isOpen: (id: string) => boolean;
  setOpen: (id: string, open: boolean) => void;
  clearSelection: () => void;
}) {
  const moveSessions = useMoveSessions();
  const movePrefix = useMovePrefix();

  const labelOf = (key: string | null) => (key === null ? "No group" : groupCrumb(key, me, nameOf));
  /** The group a session sits in, null for No group. */
  const groupOf = (session: SessionListItem) =>
    session.groupKey && !isNoGroupKey(session.groupKey, me) ? session.groupKey : null;
  /**
   * Open a group and its parents (No group for null), so a landing row is
   * on screen. Another person's group also opens its owner under Shared
   * with me.
   */
  const reveal = (key: string | null) => {
    if (key === null) {
      setOpen("nogroup", true);
      return;
    }
    const owner = personalOwner(key);
    if (owner && owner !== me) setOpen(ownerFoldId(owner), true);
    for (const id of withParents(key)) setOpen(id, true);
  };
  const hasServerSessions = (key: string) => serverKeys.some((server) => server.startsWith(key));
  /** A blocked write toasts why and stops (the controls already hide it; this is the guard). */
  const blocked = (key: string | null) => {
    const reason = writeBlock(key);
    if (reason) say(reason);
    return reason !== null;
  };

  /**
   * Undo puts each session back on its exact key: `null` only when the
   * server's default for `null` is that key. Null when a key cannot be
   * written here (a personal key on the operator key): then there is no Undo.
   */
  const undoFor = (sessions: SessionListItem[]) => {
    const byKey = new Map<string | null, string[]>();
    for (const session of sessions) {
      const key = session.root.key
        ? restoreKey(session.root.id, session.root.key)
        : groupOf(session);
      if (writeBlock(key)) return null;
      byKey.set(key, [...(byKey.get(key) ?? []), session.root.id]);
    }
    return () => {
      for (const [groupKey, rootTaskIds] of byKey) {
        void settle(moveSessions.mutateAsync({ rootTaskIds, groupKey }));
      }
    };
  };

  /** Move sessions into `key`, or to No group (`null`). */
  const move = async (sessions: SessionListItem[], key: string | null) => {
    if (blocked(key)) return;
    const todo = sessions.filter((session) => groupOf(session) !== key);
    if (todo.length === 0) {
      say(
        sessions.length === 1 ? `Already in ${labelOf(key)}.` : `All already in ${labelOf(key)}.`,
      );
      return;
    }
    clearSelection();
    const result: SessionMoveResult | null = await settle(
      moveSessions.mutateAsync({ rootTaskIds: todo.map((s) => s.root.id), groupKey: key }),
    );
    if (!result) return;
    const movedSessions = todo.filter((session) => result.moved.includes(session.root.id));
    if (movedSessions.length === 0) {
      say(`Nothing moved.${skippedText(result.skipped)}`);
      return;
    }
    reveal(key);
    const what =
      movedSessions.length === 1
        ? `"${toastTitle(movedSessions[0])}"`
        : plural(movedSessions.length, "session");
    const undo = undoFor(movedSessions);
    toast(`Moved ${what} to ${labelOf(key)}.${skippedText(result.skipped)}`, {
      position: SESSIONS_TOAST_POSITION,
      duration: UNDO_TOAST_MS,
      action: undo ? { label: "Undo", onClick: undo } : undefined,
    });
  };

  /**
   * A new group under `parent`. It lives in this browser until a session
   * moves in. Null for a name with no letters or numbers (said in a toast).
   */
  const create = (parent: string, name: string): { key: string; existed: boolean } | null => {
    const key = childGroupKey(parent, name);
    if (!key) {
      if (name.trim()) say("Use letters or numbers in a group name.");
      return null;
    }
    const existed = targetKeys.has(key);
    if (!existed) emptyGroups.add(key);
    reveal(key);
    return { key, existed };
  };

  const rename = async (key: string, name: string) => {
    const to = renamedGroupKey(key, name);
    if (!to) {
      if (name.trim()) say("Use letters or numbers in a group name.");
      return;
    }
    if (to === key || blocked(to)) return;
    if (targetKeys.has(to)) {
      say("A group with that name already exists.");
      return;
    }
    const renamed = (extra = "") => {
      emptyGroups.rename(key, to);
      setOpen(to, isOpen(key));
      say(`Renamed ${labelOf(key)} to ${labelOf(to)}.${extra}`);
    };
    if (!hasServerSessions(key)) return renamed();
    const result: SessionPrefixMoveResult | null = await settle(
      movePrefix.mutateAsync({ from: key, to }),
    );
    if (!result) return;
    // Every session stayed: the group keeps its name, so say that instead.
    if (result.moved.length === 0) say(`Nothing moved.${skippedText(result.skipped)}`);
    else renamed(skippedText(result.skipped));
  };

  const remove = async (key: string) => {
    if (!hasServerSessions(key)) {
      emptyGroups.remove(key);
      say(`Deleted ${labelOf(key)}.`);
      return;
    }
    const result: SessionPrefixMoveResult | null = await settle(
      movePrefix.mutateAsync({ from: key, to: null }),
    );
    if (!result) return;
    emptyGroups.remove(key);
    const lead =
      result.skipped.length > 0
        ? `Kept ${labelOf(key)} for the sessions you don't own.`
        : `Deleted ${labelOf(key)}.`;
    say(
      `${lead} ${plural(result.moved.length, "session")} moved to No group.${skippedText(result.skipped)}`,
    );
  };

  return { move, create, rename, remove, labelOf, reveal };
}

export type TreeMoves = ReturnType<typeof useTreeMoves>;
