import { type UseQueryResult, useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { sessionsQueryOptions } from "@/api/hooks/use-sessions";
import type { SessionsListResponse } from "@/api/types";
import { sidebarListParams } from "@/lib/sessions-v2";
import type { MyGroups } from "../use-my-groups";
import { buildTreeRows, type ContainerId, type ListState, type TreeRow } from "./tree-rows";

const NO_LISTS: ReadonlyMap<ContainerId, ListState> = new Map();

/** Only what the rows need from each list query, so a fetch status change builds nothing. */
function listStates(results: UseQueryResult<SessionsListResponse>[]): ListState[] {
  return results.map((result) => ({ data: result.data, failed: result.isError }));
}

/**
 * The sidebar rows: the open lists and the flat row list over the group
 * tree of `useMyGroups`. Only open lists with sessions load (`containers`),
 * so a poll never loads a folded list. `paused` (search shows instead)
 * stops the list polls.
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
        : [],
    [tree, groups, isOpen, expanded],
  );
  const states = useQueries({
    queries: containers.map((container) =>
      sessionsQueryOptions(me, { ...sidebarListParams(container), enabled: !paused }),
    ),
    combine: listStates,
  });
  return useMemo((): TreeRow[] => {
    if (!tree || !groups) return [];
    const lists = new Map(containers.map((container, i) => [container, states[i]]));
    return buildTreeRows({ tree, groups, isOpen, expanded, lists, creating, localGroups }).rows;
  }, [tree, groups, isOpen, expanded, containers, states, creating, localGroups]);
}
