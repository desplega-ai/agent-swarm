import { useCallback, useEffect, useMemo } from "react";
import { useSessionTree } from "@/api/hooks/use-session-tree";
import { useConfig } from "@/hooks/use-config";
import { isUserTokenApiKey } from "@/lib/config";
import { stillEmpty, useEmptyGroups, withEmptyGroups } from "@/lib/empty-groups";
import { buildSessionGroupTree, groupTargets, groupWriteBlock } from "@/lib/session-groups";

/**
 * The groups of the sessions v2 view, from one place: the server tree plus
 * the empty groups of this browser (plan D8), nested, and My groups as move
 * and Start in targets. A local group goes once the server has it.
 * `writeBlock` says why a write into a group fails on this connection
 * (personal groups need a user token), or null.
 */
export function useMyGroups(me: string | null) {
  const { config } = useConfig();
  const treeQuery = useSessionTree();
  const emptyGroups = useEmptyGroups(config.apiUrl, me);
  const tree = treeQuery.data;
  /** Group keys the server has: a rename or delete of anything else stays in this browser. */
  const serverKeys = useMemo(() => tree?.groups.map((group) => group.key) ?? [], [tree]);
  const localGroups = useMemo(
    () => new Set(stillEmpty(emptyGroups.keys, serverKeys)),
    [emptyGroups.keys, serverKeys],
  );
  const groups = useMemo(
    () =>
      tree
        ? buildSessionGroupTree(withEmptyGroups(tree.groups, [...localGroups]), me, tree.labels)
        : null,
    [tree, localGroups, me],
  );
  const targets = useMemo(() => (groups ? groupTargets(groups, me) : []), [groups, me]);

  // A group made here is done once a session moved in: the server has it now.
  const { prune } = emptyGroups;
  useEffect(() => {
    if (tree) prune(serverKeys);
  }, [tree, serverKeys, prune]);

  const userToken = isUserTokenApiKey(config.apiKey);
  const writeBlock = useCallback(
    (key: string | null) => groupWriteBlock(key, userToken),
    [userToken],
  );

  return { treeQuery, emptyGroups, serverKeys, localGroups, groups, targets, writeBlock };
}

export type MyGroups = ReturnType<typeof useMyGroups>;
