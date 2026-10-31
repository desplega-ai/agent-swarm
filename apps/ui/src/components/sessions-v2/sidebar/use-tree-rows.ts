import { type UseQueryResult, useQueries } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { sessionsQueryOptions } from "@/api/hooks/use-sessions";
import type { SessionsListResponse } from "@/api/types";
import { sidebarListParams } from "@/lib/sessions-v2";
import type { MyGroups } from "../use-my-groups";
import { buildTreeRows, type ContainerId, type ListState, type TreeRow } from "./tree-rows";

const NO_LISTS: ReadonlyMap<ContainerId, ListState> = new Map();

/**
 * The lists that open by default (`openByDefault`). They load with the tree,
 * not after it: until the tree says which lists hold sessions, the open
 * ones among these are the guess.
 */
const EARLY_CONTAINERS: readonly ContainerId[] = ["inbox", "later"];

/** Only what the rows need from each list query, so a fetch status change builds nothing. */
function listStates(results: UseQueryResult<SessionsListResponse>[]): ListState[] {
  return results.map((result) => ({ data: result.data, failed: result.isError }));
}

/**
 * The sidebar rows: the open lists and the flat row list over the group
 * tree of `useMyGroups`. Only open lists with sessions load (`containers`),
 * so a poll never loads a folded list. `paused` (search shows instead)
 * stops the list polls. `updating`: the tree or a list still shows the
 * previous Mine / All view while the new one loads.
 */
export function useTreeRows({
  me,
  myGroups,
  isOpen,
  expanded,
  creating,
  paused,
}: {
  me: string | null;
  myGroups: MyGroups;
  isOpen: (id: string) => boolean;
  expanded: ReadonlySet<ContainerId>;
  /** A new group's name field shows under this parent. */
  creating: string | null;
  paused: boolean;
}) {
  const tree = myGroups.treeQuery.data;
  const { groups, localGroups } = myGroups;

  // Learn which open lists to load, load them, then build the rows with them.
  const containers = useMemo(
    () =>
      tree && groups
        ? buildTreeRows({ tree, groups, isOpen, expanded, lists: NO_LISTS }).containers
        : EARLY_CONTAINERS.filter(isOpen),
    [tree, groups, isOpen, expanded],
  );
  const states = useQueries({
    queries: containers.map((container) =>
      sessionsQueryOptions(me, { ...sidebarListParams(container), enabled: !paused }),
    ),
    combine: listStates,
  });
  // The last loaded page of each list, for this viewer. A Mine / All or
  // source switch changes every list key, and `useQueries` starts fresh
  // observers for new keys, so `placeholderData` never sees the old page.
  const shown = useRef<{ me: string | null; lists: ReadonlyMap<ContainerId, ListState> }>({
    me,
    lists: NO_LISTS,
  });
  const lists = useMemo(() => {
    const previous = shown.current.me === me ? shown.current.lists : NO_LISTS;
    return new Map(
      containers.map((container, i): [ContainerId, ListState] => {
        const state = states[i]!;
        const old = previous.get(container)?.data;
        return [
          container,
          !state.data && !state.failed && old ? { data: old, failed: false, stale: true } : state,
        ];
      }),
    );
  }, [me, containers, states]);
  useEffect(() => {
    shown.current = { me, lists };
  }, [me, lists]);

  const treeStale = myGroups.treeQuery.isPlaceholderData;
  return useMemo((): { rows: TreeRow[]; updating: boolean } => {
    const updating = treeStale || [...lists.values()].some((state) => state.stale);
    if (!tree || !groups) return { rows: [], updating };
    const { rows } = buildTreeRows({
      tree,
      groups,
      isOpen,
      expanded,
      lists,
      creating,
      localGroups,
    });
    return { rows, updating };
  }, [tree, groups, isOpen, expanded, lists, creating, localGroups, treeStale]);
}
