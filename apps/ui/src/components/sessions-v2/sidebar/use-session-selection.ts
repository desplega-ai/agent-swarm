import { useCallback, useMemo, useRef, useState } from "react";
import type { SessionListItem } from "@/api/types";
import { useStableHandler } from "@/hooks/use-stable-handler";
import {
  type ContainerId,
  fullListOf,
  type ListSelectState,
  listSelectState,
  listSessionIds,
  sessionRange,
  type TreeRow,
} from "./tree-rows";

/**
 * The selected sessions of the sidebar (SPEC R5): one checked row turns on
 * selection mode and the bulk bar. Only rows on screen count, so a row that
 * left (a fold, a poll, a search, another client) never keeps selection
 * mode on.
 *
 * Shift+click adds a range (as in Gmail): every session row from the anchor
 * to the clicked row. The anchor is the row checked last, else the row the
 * click started from (the cursor).
 *
 * A list's checkbox (and Cmd+A) selects the loaded rows of one list. Then
 * "Select all N" (`selectWholeList`) stands for every session of that list,
 * loaded or not: the bulk bar acts on the server by list. Any other change
 * to the selection ends it.
 */
export function useSessionSelection(rows: TreeRow[]) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  /** The list of the last selection change: "Select all N" offers it. */
  const [list, setList] = useState<ContainerId | null>(null);
  /** "Select all N" is on for `list`. */
  const [wholeList, setWholeList] = useState(false);
  const visible = useMemo(() => {
    const found = new Map<string, SessionListItem>();
    for (const row of rows) {
      if (row.type === "session" && !found.has(row.session.root.id)) {
        found.set(row.session.root.id, row.session);
      }
    }
    return found;
  }, [rows]);
  /** The loaded session ids of each list, in row order. */
  const byList = useMemo(() => listSessionIds(rows), [rows]);
  const selected = useMemo(
    () => new Set([...picked].filter((id) => visible.has(id))),
    [picked, visible],
  );

  // The row key a Shift+click range starts at.
  const anchor = useRef<string | null>(null);
  const listOf = (rowKey: string | undefined) => {
    const row = rowKey ? rows.find((r) => r.key === rowKey) : undefined;
    return row?.type === "session" ? row.container : null;
  };
  const pick = (next: ReadonlySet<string>, nextList: ContainerId | null) => {
    setPicked(next);
    setList(nextList);
    setWholeList(false);
  };
  const clear = useCallback(() => {
    anchor.current = null;
    setPicked(new Set());
    setList(null);
    setWholeList(false);
  }, []);
  /** `rowKey`: the checked row, the anchor of the next range. */
  const toggle = useStableHandler((id: string, rowKey?: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    if (rowKey) anchor.current = rowKey;
    pick(next, listOf(rowKey) ?? list);
  });
  /** Shift+click on `rowKey`. `from`: the cursor's row, for a range with no anchor on screen. */
  const selectRange = useStableHandler((rowKey: string, from: string | null) => {
    const anchorOnScreen = rows.some((row) => row.key === anchor.current);
    const ids = sessionRange(rows, anchorOnScreen ? anchor.current : from, rowKey);
    if (ids.length === 0) return;
    anchor.current = rowKey;
    pick(new Set([...selected, ...ids]), listOf(rowKey));
  });
  /** A list's selection state, for its checkbox. Null: no loaded rows to select. */
  const listState = (container: ContainerId): ListSelectState | null =>
    listSelectState(byList.get(container), selected);
  /** Cmd+A: the loaded rows of one list, and nothing else. */
  const selectList = useStableHandler((container: ContainerId) => {
    const ids = byList.get(container) ?? [];
    if (ids.length === 0) return;
    anchor.current = null;
    pick(new Set(ids), container);
  });
  /** The list's checkbox: select its loaded rows, or unselect them when all are selected. */
  const toggleList = useStableHandler((container: ContainerId) => {
    if (listState(container) === "all") {
      const ids = byList.get(container) ?? [];
      pick(new Set([...selected].filter((id) => !ids.includes(id))), container);
    } else selectList(container);
  });
  /** The selected sessions, in row order. */
  const sessions = (): SessionListItem[] =>
    [...visible.values()].filter((session) => selected.has(session.root.id));
  /** The list whose loaded rows are exactly the selection, or null. */
  const fullList = (): ContainerId | null =>
    fullListOf(list, list ? byList.get(list) : undefined, selected);

  return {
    selected,
    selectionMode: selected.size > 0,
    toggle,
    selectRange,
    clear,
    sessions,
    listState,
    toggleList,
    selectList,
    fullList,
    /** The list of the last selection change (for the phone's "Select all"). */
    list,
    /** "Select all N": the whole list (`fullList`), on the server. */
    selectWholeList: () => setWholeList(fullList() !== null),
    /** The list that "Select all N" covers, while it is on. A poll that loads new rows keeps it. */
    wholeList: wholeList && selected.size > 0 ? list : null,
    /** What a key acts on: the selection, else the cursor's session. */
    keyTargets: (cursorSession: SessionListItem | null): SessionListItem[] =>
      selected.size > 0 ? sessions() : cursorSession ? [cursorSession] : [],
    /** What a row's menu acts on: the selection when the row is in it, else the row. */
    menuTargets: (session: SessionListItem): SessionListItem[] =>
      selected.has(session.root.id) ? sessions() : [session],
  };
}

export type SessionSelection = ReturnType<typeof useSessionSelection>;
