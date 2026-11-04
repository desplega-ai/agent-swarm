// "In progress" on Home: running sessions grouped by use case (Sessions group).
//
// Relative imports only: `bun:test` runs this from the repo root.

import type { SessionListItem, SessionTreeResponse } from "../api/types";
import { isNoGroupKey } from "./session-groups";

export interface InProgressGroup {
  /** The group key, or null for "No group". */
  key: string | null;
  /** Running sessions in the group, from the tree's counts. */
  running: number;
  /** Running sessions of the group on the fetched page, newest activity first. */
  sessions: SessionListItem[];
}

/**
 * The groups with a running session, most running first, then the latest
 * activity. "No group" comes last. A group's count comes from the tree, so
 * it stays right past the page of running sessions that fills its rows.
 */
export function inProgressGroups(
  tree: SessionTreeResponse | undefined,
  running: SessionListItem[] | undefined,
  me: string | null,
): InProgressGroup[] {
  if (!tree) return [];
  const byKey = new Map<string | null, SessionListItem[]>();
  for (const session of running ?? []) {
    const key = session.groupKey && !isNoGroupKey(session.groupKey, me) ? session.groupKey : null;
    const list = byKey.get(key) ?? [];
    list.push(session);
    byKey.set(key, list);
  }
  const groups: InProgressGroup[] = tree.groups
    .filter((group) => group.running > 0)
    .sort(
      (a, b) =>
        b.running - a.running ||
        b.lastActivityAt.localeCompare(a.lastActivityAt) ||
        a.key.localeCompare(b.key),
    )
    .map((group) => ({
      key: group.key,
      running: group.running,
      sessions: byKey.get(group.key) ?? [],
    }));
  if (tree.noGroup.running > 0) {
    groups.push({ key: null, running: tree.noGroup.running, sessions: byKey.get(null) ?? [] });
  }
  return groups;
}

/** The Sessions list of a group: `/sessions?view=<key>`, or the No group section. */
export function groupViewHref(key: string | null): string {
  return `/sessions?view=${encodeURIComponent(key ?? "nogroup")}`;
}
