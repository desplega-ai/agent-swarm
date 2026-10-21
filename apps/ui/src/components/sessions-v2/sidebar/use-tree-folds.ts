import { useCallback, useEffect, useState } from "react";
import { useConfig } from "@/hooks/use-config";
import type { SessionGroupTree } from "@/lib/session-groups";
import { foldIds, openByDefault } from "./tree-rows";

type Folds = Record<string, boolean>;

function readFolds(storageKey: string): Folds {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    return stored && typeof stored === "object" ? stored : {};
  } catch {
    return {};
  }
}

/**
 * Which sections and groups are open. Each fold persists in this browser,
 * per connection and per user (the dashboard can switch swarms and users).
 * `prune` drops the folds of groups that no longer exist.
 */
export function useTreeFolds(me: string | null) {
  const { config } = useConfig();
  const storageKey = `agent-swarm-sessions-v2-folds:${config.apiUrl}:${me ?? "operator"}`;
  const [state, setState] = useState(() => ({ storageKey, folds: readFolds(storageKey) }));
  // Another connection or user: read its own folds (state from props, React docs).
  let folds = state.folds;
  if (state.storageKey !== storageKey) {
    folds = readFolds(storageKey);
    setState({ storageKey, folds });
  }

  useEffect(() => {
    try {
      localStorage.setItem(state.storageKey, JSON.stringify(state.folds));
    } catch {
      // Storage off: the folds hold until a reload.
    }
  }, [state]);

  /** Drop the folds of groups the tree no longer has. */
  const prune = useCallback((groups: SessionGroupTree) => {
    const live = foldIds(groups);
    setState((prev) => {
      const kept = Object.entries(prev.folds).filter(([id]) => live.has(id));
      if (kept.length === Object.keys(prev.folds).length) return prev;
      return { ...prev, folds: Object.fromEntries(kept) };
    });
  }, []);

  const isOpen = useCallback((id: string) => folds[id] ?? openByDefault(id, me), [folds, me]);
  const setOpen = useCallback((id: string, open: boolean) => {
    setState((prev) =>
      prev.folds[id] === open ? prev : { ...prev, folds: { ...prev.folds, [id]: open } },
    );
  }, []);
  return { isOpen, setOpen, prune };
}
