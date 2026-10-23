// The sessions v2 sidebar as one flat row list (SPEC R4, R5, R6).
//
// Relative imports only: `bun:test` runs this from the repo root.

import type {
  SessionListItem,
  SessionSectionCounts,
  SessionsListResponse,
  SessionTreeResponse,
} from "../../../api/types";
import { type GroupNode, personalOwner, type SessionGroupTree } from "../../../lib/session-groups";
import {
  type SessionSection,
  SIDEBAR_LIST_LIMIT,
  SIDEBAR_LIST_STEP,
} from "../../../lib/sessions-v2";

/** A list in the sidebar: a section (`inbox`, `later`, `done`, `nogroup`) or a group key. */
export type ContainerId = string;

/**
 * Which centered empty state a list shows. `fresh`: a new group with no
 * sessions yet (plan D8). `search`: no session matches, with a `note`.
 */
export type EmptyKind = SessionSection | "group" | "groups" | "fresh" | "search" | "failed";

interface RowBase {
  /** Stable across polls: the cursor and React keys use it. */
  key: string;
  /** Indent level, 0 at the left edge. */
  level: number;
}

export type TreeRow =
  | (RowBase & {
      type: "box";
      id: SessionSection;
      counts: SessionSectionCounts;
      open: boolean;
    })
  | (RowBase & {
      type: "group";
      node: GroupNode;
      open: boolean;
      counts: SessionSectionCounts;
      /** Under Shared with me: no "+" (SPEC R3), and the name is the path below the owner. */
      sharedWithMe: boolean;
      /** A search match: the name is the whole path, and the row does not fold. */
      searchMatch?: boolean;
    })
  | (RowBase & {
      type: "owner";
      ownerId: string;
      open: boolean;
      /** Folded only: an open owner shows the counts on its groups. */
      counts: SessionSectionCounts | null;
    })
  | (RowBase & {
      type: "section";
      label: string;
      count: number;
      /** What `count` counts. Sessions unless said. */
      unit?: "group";
    })
  | (RowBase & {
      type: "session";
      container: ContainerId;
      session: SessionListItem;
      /** Inbox, Later, and Done are flat: each row names its group. */
      flat: boolean;
      /** Search results: the free words to mark in the title. */
      match?: readonly string[];
    })
  | (RowBase & { type: "more"; container: ContainerId; count: number })
  | (RowBase & { type: "all"; container: ContainerId; total: number })
  | (RowBase & {
      type: "empty";
      kind: EmptyKind;
      /** The row (or section) this state describes, for its `aria-describedby`. */
      parentKey: string;
      /** `fresh`: the group a new session starts in. */
      groupKey?: string;
      /** `search`: why nothing matches, in one sentence. */
      note?: string;
    })
  | (RowBase & { type: "loading"; parentKey: string })
  /** "New group" at the end of My groups. */
  | (RowBase & { type: "add" })
  /** The inline name field of a new group under `parent` (`shared/` or a group key). */
  | (RowBase & { type: "create"; parent: string });

export type NavRow = Extract<
  TreeRow,
  { type: "box" | "group" | "owner" | "session" | "more" | "all" | "add" }
>;

const NAV_TYPES = new Set<TreeRow["type"]>([
  "box",
  "group",
  "owner",
  "session",
  "more",
  "all",
  "add",
]);

/** Rows the keyboard cursor stops on. */
export function isNavRow(row: TreeRow): row is NavRow {
  return NAV_TYPES.has(row.type);
}

/** The fold id of an owner node under Shared with me. */
export const ownerFoldId = (ownerId: string) => `owner:${ownerId}`;

/** The fold id of a container row: a section, a group key, or an owner. */
export function foldId(row: TreeRow): string | null {
  if (row.type === "box") return row.id;
  if (row.type === "group") return row.node.key;
  if (row.type === "owner") return ownerFoldId(row.ownerId);
  return null;
}

/**
 * A Shift+click range: the session ids of the rows from `fromKey` to `toKey`,
 * both included, in row order. Group, list, and state rows in between are
 * skipped. With no `fromKey` row, only `toKey`'s session.
 */
export function sessionRange(rows: TreeRow[], fromKey: string | null, toKey: string): string[] {
  const at = (key: string | null) => (key === null ? -1 : rows.findIndex((row) => row.key === key));
  const end = at(toKey);
  if (end < 0) return [];
  const start = at(fromKey);
  const [low, high] = start < 0 ? [end, end] : [Math.min(start, end), Math.max(start, end)];
  return rows
    .slice(low, high + 1)
    .flatMap((row) => (row.type === "session" ? [row.session.root.id] : []));
}

/** Whether a list's loaded rows are all, some, or none selected (its checkbox). */
export type ListSelectState = "all" | "some" | "none";

/** The loaded session ids of each list, in row order. */
export function listSessionIds(rows: TreeRow[]): Map<ContainerId, string[]> {
  const found = new Map<ContainerId, string[]>();
  for (const row of rows) {
    if (row.type !== "session") continue;
    const ids = found.get(row.container) ?? [];
    ids.push(row.session.root.id);
    found.set(row.container, ids);
  }
  return found;
}

/** A list's checkbox state from its loaded `ids`. Null: no loaded rows to select. */
export function listSelectState(
  ids: readonly string[] | undefined,
  selected: ReadonlySet<string>,
): ListSelectState | null {
  if (!ids?.length) return null;
  const count = ids.filter((id) => selected.has(id)).length;
  return count === 0 ? "none" : count === ids.length ? "all" : "some";
}

/** `list` when its loaded rows (`ids`) are exactly the selection, else null. */
export function fullListOf(
  list: ContainerId | null,
  ids: readonly string[] | undefined,
  selected: ReadonlySet<string>,
): ContainerId | null {
  return list && ids?.length === selected.size && ids.every((id) => selected.has(id)) ? list : null;
}

/**
 * The N of "Select all N" for a list: its "View all N" total when the list
 * has more sessions than it loaded, else null. A list that "Show 10 more"
 * loaded in full keeps its "View all" row, so the row alone is not enough.
 */
export function wholeListTotal(rows: TreeRow[], container: ContainerId): number | null {
  let loaded = 0;
  let total: number | null = null;
  for (const row of rows) {
    if (row.type === "session" && row.container === container) loaded++;
    else if (row.type === "all" && row.container === container) total = row.total;
  }
  return total !== null && total > loaded ? total : null;
}

/** Open until folded: the Inbox, Later (the mockup default), and other people's groups. */
export function openByDefault(id: string, me: string | null): boolean {
  if (id === "inbox" || id === "later") return true;
  const owner = personalOwner(id);
  return owner !== null && owner !== me;
}

/** Every fold id the tree can show: the sections, each group, and each owner. */
export function foldIds(groups: SessionGroupTree): Set<string> {
  const ids = new Set<string>(["inbox", "later", "done", "nogroup"]);
  const walk = (node: GroupNode) => {
    ids.add(node.key);
    for (const child of node.children) walk(child);
  };
  for (const node of groups.myGroups) walk(node);
  for (const owner of groups.sharedWithMe) {
    ids.add(ownerFoldId(owner.ownerId));
    for (const node of owner.groups) ids.add(node.key);
  }
  return ids;
}

export interface ListState {
  data?: SessionsListResponse;
  failed: boolean;
}

interface BuildTreeRowsInput {
  tree: SessionTreeResponse;
  groups: SessionGroupTree;
  isOpen: (id: string) => boolean;
  /** Lists that show 20 rows ("Show 10 more" was used). */
  expanded: ReadonlySet<ContainerId>;
  /** The loaded lists. Missing means not loaded yet. */
  lists: ReadonlyMap<ContainerId, ListState>;
  /** A new group's name field shows under this parent (`shared/` for the top level). */
  creating?: string | null;
  /** Groups that live only in this browser (plan D8): their empty state invites a move. */
  localGroups?: ReadonlySet<string>;
}

/**
 * The sidebar as one flat row list (SPEC R4, R5, R6): Inbox, Later, Done,
 * No group, My groups, Shared with me. `containers` names the lists to
 * load: open lists with sessions only, so a poll never loads a folded one.
 * Run it once with no lists to learn `containers`, then again with them.
 */
export function buildTreeRows({
  tree,
  groups,
  isOpen,
  expanded,
  lists,
  creating = null,
  localGroups,
}: BuildTreeRowsInput): {
  rows: TreeRow[];
  containers: ContainerId[];
} {
  const rows: TreeRow[] = [];
  const containers: ContainerId[] = [];

  /** The rows of one open list: 10 (or 20), then "Show 10 more" once, then "View all N". */
  const fill = (
    container: ContainerId,
    parentKey: string,
    total: number,
    level: number,
    flat: boolean,
    emptyKind: EmptyKind | null,
  ) => {
    const empty = (kind: EmptyKind | null) => {
      if (!kind) return;
      const groupKey = kind === "fresh" ? container : undefined;
      rows.push({ type: "empty", key: `empty:${container}`, level, kind, parentKey, groupKey });
    };
    if (total === 0) return empty(emptyKind);
    containers.push(container);
    const list = lists.get(container);
    if (!list?.data) {
      if (list?.failed) empty("failed");
      else rows.push({ type: "loading", key: `loading:${container}`, level, parentKey });
      return;
    }
    const { sessions, total: listTotal } = list.data;
    if (sessions.length === 0) return empty(emptyKind);
    const more = expanded.has(container);
    for (const session of sessions.slice(0, more ? SIDEBAR_LIST_LIMIT : SIDEBAR_LIST_STEP)) {
      rows.push({
        type: "session",
        key: `s:${container}:${session.root.id}`,
        level,
        container,
        session,
        flat,
      });
    }
    if (listTotal <= SIDEBAR_LIST_STEP) return;
    if (!more) {
      const count = Math.min(SIDEBAR_LIST_STEP, listTotal - SIDEBAR_LIST_STEP);
      rows.push({ type: "more", key: `more:${container}`, level, container, count });
    }
    rows.push({ type: "all", key: `all:${container}`, level, container, total: listTotal });
  };

  const box = (id: SessionSection, counts: SessionSectionCounts, flat: boolean) => {
    const open = isOpen(id);
    const key = `box:${id}`;
    rows.push({ type: "box", key, level: 0, id, counts, open });
    if (open) fill(id, key, counts.total, 1, flat, id);
  };
  box("inbox", tree.inbox, true);
  box("later", tree.later, true);
  box("done", tree.done, true);
  box("nogroup", tree.noGroup, false);

  // My groups. A folded group shows its whole subtree in its counts, an open
  // one its own sessions only (they list under it, after its subgroups).
  const mine = "section:mine";
  rows.push({
    type: "section",
    key: mine,
    level: 0,
    label: "My groups",
    count: groups.myGroupsTotal,
  });
  const groupNode = (node: GroupNode, level: number) => {
    const open = isOpen(node.key);
    const key = `group:${node.key}`;
    rows.push({
      type: "group",
      key,
      level,
      node,
      open,
      counts: open ? node.own : node.subtree,
      sharedWithMe: false,
    });
    if (creating === node.key) {
      rows.push({ type: "create", key: `create:${node.key}`, level: level + 1, parent: node.key });
    }
    if (!open) return;
    for (const child of node.children) groupNode(child, level + 1);
    const emptyKind =
      node.children.length > 0 ? null : localGroups?.has(node.key) ? "fresh" : "group";
    fill(node.key, key, node.own.total, level + 1, false, emptyKind);
  };
  for (const node of groups.myGroups) groupNode(node, 0);
  // The name field of a new top-level group, else "New group" (after the
  // first-run invite when there are no groups yet). "New group" is a row the
  // keys reach, so the invite holds text only.
  if (creating === "shared/") {
    rows.push({ type: "create", key: "create:shared/", level: 0, parent: "shared/" });
  } else {
    if (groups.myGroups.length === 0) {
      rows.push({ type: "empty", key: "empty:groups", level: 0, kind: "groups", parentKey: mine });
    }
    rows.push({ type: "add", key: "add:group", level: 0 });
  }

  // Shared with me: other people's personal groups, one node per owner.
  if (groups.sharedWithMe.length > 0) {
    rows.push({
      type: "section",
      key: "section:shared",
      level: 0,
      label: "Shared with me",
      count: groups.sharedWithMeTotal,
    });
    for (const owner of groups.sharedWithMe) {
      const open = isOpen(ownerFoldId(owner.ownerId));
      rows.push({
        type: "owner",
        key: `owner:${owner.ownerId}`,
        level: 0,
        ownerId: owner.ownerId,
        open,
        counts: open ? null : owner.subtree,
      });
      if (!open) continue;
      for (const node of owner.groups) {
        const groupOpen = isOpen(node.key);
        const key = `group:${node.key}`;
        rows.push({
          type: "group",
          key,
          level: 1,
          node,
          open: groupOpen,
          counts: node.own,
          sharedWithMe: true,
        });
        if (groupOpen) fill(node.key, key, node.own.total, 2, false, "group");
      }
    }
  }

  return { rows, containers };
}
