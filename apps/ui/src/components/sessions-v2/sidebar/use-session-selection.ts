import { useCallback, useMemo, useState } from "react";
import type { SessionListItem } from "@/api/types";
import { useStableHandler } from "@/hooks/use-stable-handler";
import type { TreeRow } from "./tree-rows";

/**
 * The selected sessions of the sidebar (SPEC R5): one checked row turns on
 * selection mode and the bulk bar. Only rows on screen count, so a row that
 * left (a fold, a poll, a search, another client) never keeps selection
 * mode on.
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

  const clear = useCallback(() => setPicked(new Set()), []);
  const toggle = useStableHandler((id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  });
  /** The selected sessions, in row order. */
  const sessions = (): SessionListItem[] =>
    [...visible.values()].filter((session) => selected.has(session.root.id));

  return {
    selected,
    selectionMode: selected.size > 0,
    toggle,
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
