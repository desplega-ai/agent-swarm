import { type UseQueryResult, useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { useSessionTree } from "@/api/hooks/use-session-tree";
import { sessionsQueryOptions } from "@/api/hooks/use-sessions";
import type { SessionsListResponse } from "@/api/types";
import { buildSessionGroupTree } from "@/lib/session-groups";
import { sidebarListParams } from "@/lib/sessions-v2";
import { buildTreeRows, type ContainerId, type ListState, type TreeRow } from "./tree-rows";

const NO_LISTS: ReadonlyMap<ContainerId, ListState> = new Map();

/** Only what the rows need from each list query, so a fetch status change builds nothing. */
function listStates(results: UseQueryResult<SessionsListResponse>[]): ListState[] {
  return results.map((result) => ({ data: result.data, failed: result.isError }));
}

/**
 * The sidebar data: the tree counts, the group tree, the open lists, and the
 * flat row list. Only open lists with sessions load (`containers`), so a
 * poll never loads a folded list.
 */
export function useTreeRows({
  me,
  isOpen,
  expanded,
}: {
  me: string | null;
  isOpen: (id: string) => boolean;
  expanded: ReadonlySet<ContainerId>;
}) {
  const treeQuery = useSessionTree();
  const tree = treeQuery.data;
  const groups = useMemo(() => (tree ? buildSessionGroupTree(tree.groups, me) : null), [tree, me]);

  // Learn which open lists to load, load them, then build the rows with them.
  const containers = useMemo(
    () =>
      tree && groups
        ? buildTreeRows({ tree, groups, isOpen, expanded, lists: NO_LISTS }).containers
        : [],
    [tree, groups, isOpen, expanded],
  );
  const states = useQueries({
    queries: containers.map((container) => sessionsQueryOptions(me, sidebarListParams(container))),
    combine: listStates,
  });
  const rows = useMemo((): TreeRow[] => {
    if (!tree || !groups) return [];
    const lists = new Map(containers.map((container, i) => [container, states[i]]));
    return buildTreeRows({ tree, groups, isOpen, expanded, lists }).rows;
  }, [tree, groups, isOpen, expanded, containers, states]);

  return { treeQuery, groups, rows };
}
