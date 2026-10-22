import { useCallback, useMemo, useRef, useState } from "react";
import type { SessionListItem } from "@/api/types";
import { useStableHandler } from "@/hooks/use-stable-handler";
import { sessionRange, type TreeRow } from "./tree-rows";

/**
 * The selected sessions of the sidebar (SPEC R5): one checked row turns on
 * selection mode and the bulk bar. Only rows on screen count, so a row that
 * left (a fold, a poll, a search, another client) never keeps selection
 * mode on.
 *
 * Shift+click adds a range (as in Gmail): every session row from the anchor
 * to the clicked row. The anchor is the row checked last, else the row the
 * click started from (the cursor).
 */
export function useSessionSelection(rows: TreeRow[]) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const visible = useMemo(() => {
    const found = new Map<string, SessionListItem>();
    for (const row of rows) {
      if (row.type === "session" && !found.has(row.session.root.id)) {
        found.set(row.session.root.id, row.session);
      }
    }
    return found;
  }, [rows]);
  const selected = useMemo(
    () => new Set([...picked].filter((id) => visible.has(id))),
    [picked, visible],
  );

  // The row key a Shift+click range starts at.
  const anchor = useRef<string | null>(null);
  const clear = useCallback(() => {
    anchor.current = null;
    setPicked(new Set());
  }, []);
  /** `rowKey`: the checked row, the anchor of the next range. */
  const toggle = useStableHandler((id: string, rowKey?: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    if (rowKey) anchor.current = rowKey;
    setPicked(next);
  });
  /** Shift+click on `rowKey`. `from`: the cursor's row, for a range with no anchor on screen. */
  const selectRange = useStableHandler((rowKey: string, from: string | null) => {
    const anchorOnScreen = rows.some((row) => row.key === anchor.current);
    const ids = sessionRange(rows, anchorOnScreen ? anchor.current : from, rowKey);
    if (ids.length === 0) return;
    anchor.current = rowKey;
    setPicked(new Set([...selected, ...ids]));
  });
  /** The selected sessions, in row order. */
  const sessions = (): SessionListItem[] =>
    [...visible.values()].filter((session) => selected.has(session.root.id));

  return {
    selected,
    selectionMode: selected.size > 0,
    toggle,
    selectRange,
    clear,
    sessions,
    /** What a key acts on: the selection, else the cursor's session. */
    keyTargets: (cursorSession: SessionListItem | null): SessionListItem[] =>
      selected.size > 0 ? sessions() : cursorSession ? [cursorSession] : [],
    /** What a row's menu acts on: the selection when the row is in it, else the row. */
    menuTargets: (session: SessionListItem): SessionListItem[] =>
      selected.has(session.root.id) ? sessions() : [session],
  };
}

export type SessionSelection = ReturnType<typeof useSessionSelection>;
