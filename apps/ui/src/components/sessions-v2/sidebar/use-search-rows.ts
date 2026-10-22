import { type UseQueryResult, useQueries } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { sessionsQueryOptions } from "@/api/hooks/use-sessions";
import { useUsers } from "@/api/hooks/use-users";
import type { SessionsListResponse } from "@/api/types";
import { type GroupNode, type SessionGroupTree, searchableGroups } from "@/lib/session-groups";
import { matchingGroups, parseSessionSearch, resolveSessionSearch } from "@/lib/session-search";
import type { TreeRow } from "./tree-rows";

/** Search results load 50 at a time (plan Phase 5). */
const SEARCH_PAGE = 50;

/** The container of search result rows, for "Show 50 more". */
export const SEARCH_CONTAINER = "search";

function pageStates(results: UseQueryResult<SessionsListResponse>[]) {
  return results.map((result) => ({ data: result.data, failed: result.isError }));
}

/** Every group node by key, with whether it sits under Shared with me. */
function nodesByKey(groups: SessionGroupTree) {
  const found = new Map<string, { node: GroupNode; sharedWithMe: boolean }>();
  const walk = (node: GroupNode) => {
    found.set(node.key, { node, sharedWithMe: false });
    for (const child of node.children) walk(child);
  };
  for (const node of groups.myGroups) walk(node);
  for (const owner of groups.sharedWithMe) {
    for (const node of owner.groups) found.set(node.key, { node, sharedWithMe: true });
  }
  return found;
}

/**
 * The sidebar search (SPEC R6): while the search has text, the tree gives
 * way to one flat list of matching sessions from the server (newest first,
 * 50 at a time), then the groups whose path holds every free word. Tokens:
 * `with:`, `in:`, `is:` (see `lib/session-search.ts`). Every call sends
 * `scope=tree`, so it finds what the tree holds, loaded or not.
 */
export function useSearchRows({
  me,
  query,
  groups,
  nameOf,
}: {
  me: string | null;
  query: string;
  groups: SessionGroupTree | null;
  nameOf: (userId: string) => string;
}) {
  const parsed = useMemo(() => parseSessionSearch(query), [query]);
  const active = !parsed.empty;
  // A new search starts at its first page.
  const [paging, setPaging] = useState({ query, pages: 1 });
  const pages = paging.query === query ? paging.pages : 1;

  const users = useUsers({ enabled: active && parsed.with.length > 0 });
  const people = users.data;
  const searchGroups = useMemo(
    () => (groups ? searchableGroups(groups, me, nameOf) : []),
    [groups, me, nameOf],
  );
  // With `with:`, the people must load first. If they cannot, say so instead of loading forever.
  const peopleFailed = parsed.with.length > 0 && users.isError;
  const waitingForPeople = parsed.with.length > 0 && !people && !peopleFailed;
  const result = useMemo(
    () => resolveSessionSearch(parsed, { people: people ?? [], groups: searchGroups }),
    [parsed, people, searchGroups],
  );
  const params = result.ok && !waitingForPeople ? result.params : null;

  const states = useQueries({
    queries: Array.from({ length: pages }, (_, page) =>
      sessionsQueryOptions(me, {
        ...params,
        scope: "tree",
        limit: SEARCH_PAGE,
        offset: page * SEARCH_PAGE,
        enabled: active && params !== null,
      }),
    ),
    combine: pageStates,
  });

  const rows = useMemo((): TreeRow[] => {
    if (!active) return [];
    const section = "section:search";
    const out: TreeRow[] = [];
    const empty = (kind: "search" | "failed", note?: string) =>
      out.push({ type: "empty", key: "empty:search", level: 0, kind, parentKey: section, note });
    const first = states[0];
    const total = first?.data?.total ?? 0;
    out.push({ type: "section", key: section, level: 0, label: "Sessions", count: total });

    if (peopleFailed) empty("failed");
    else if (!result.ok) empty("search", result.message);
    else if (waitingForPeople || (!first?.data && !first?.failed)) {
      out.push({ type: "loading", key: "loading:search", level: 0, parentKey: section });
    } else if (first?.failed) empty("failed");
    else if (total === 0) empty("search", "Try fewer words, or with:, in:, is:unread.");
    else {
      const seen = new Set<string>();
      for (const state of states) {
        for (const session of state.data?.sessions ?? []) {
          if (seen.has(session.root.id)) continue;
          seen.add(session.root.id);
          out.push({
            type: "session",
            key: `s:${SEARCH_CONTAINER}:${session.root.id}`,
            level: 0,
            container: SEARCH_CONTAINER,
            session,
            flat: true,
            match: parsed.words,
          });
        }
      }
      const loading = states.some((state) => !state.data && !state.failed);
      if (seen.size < total && !loading) {
        const count = Math.min(SEARCH_PAGE, total - seen.size);
        out.push({
          type: "more",
          key: "more:search",
          level: 0,
          container: SEARCH_CONTAINER,
          count,
        });
      }
    }

    // Groups whose path holds every free word, as rows that open the group.
    const byKey = groups ? nodesByKey(groups) : new Map();
    const matches = matchingGroups(parsed, searchGroups).filter((group) => byKey.has(group.key));
    if (matches.length > 0) {
      out.push({
        type: "section",
        key: "section:search-groups",
        level: 0,
        label: "Groups",
        count: matches.length,
        unit: "group",
      });
      for (const match of matches) {
        const { node, sharedWithMe } = byKey.get(match.key);
        out.push({
          type: "group",
          key: `match:${match.key}`,
          level: 0,
          node: { ...node, name: match.label, children: [] },
          open: false,
          counts: node.subtree,
          sharedWithMe,
          searchMatch: true,
        });
      }
    }
    return out;
  }, [active, states, result, waitingForPeople, peopleFailed, groups, parsed, searchGroups]);

  return {
    active,
    rows,
    /** "Show 50 more". */
    more: () => setPaging({ query, pages: pages + 1 }),
  };
}
