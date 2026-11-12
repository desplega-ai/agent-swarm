import { describe, expect, test } from "bun:test";
import type {
  SessionListItem,
  SessionSectionCounts,
  SessionsListResponse,
  SessionTreeGroup,
  SessionTreeResponse,
} from "../../../api/types";
import { buildSessionGroupTree } from "../../../lib/session-groups";
import {
  type BuildTreeRowsOptions,
  buildTreeRows,
  foldId,
  foldIds,
  fullListOf,
  groupStarKey,
  isMyGroupRow,
  isNavRow,
  type ListState,
  listSelectState,
  listSessionIds,
  openByDefault,
  sessionRange,
  type TreeRow,
  wholeListOn,
  wholeListTotal,
} from "./tree-rows";

const ME = "me-1";
const counts = (total: number, extra: Partial<SessionSectionCounts> = {}) => ({
  total,
  unread: 0,
  running: 0,
  needsYou: 0,
  ...extra,
});
const group = (key: string, total: number): SessionTreeGroup => ({
  key,
  lastActivityAt: "2026-10-21T10:00:00.000Z",
  ...counts(total),
});
const tree = (
  groups: SessionTreeGroup[] = [],
  sections: Partial<SessionTreeResponse> = {},
): SessionTreeResponse => ({
  groups,
  inbox: counts(0),
  later: counts(0),
  done: counts(0),
  noGroup: counts(0),
  ...sections,
});
const session = (id: string) => ({ root: { id } }) as unknown as SessionListItem;
const page = (n: number, total = n): SessionsListResponse => ({
  sessions: Array.from({ length: n }, (_, i) => session(`s${i}`)),
  total,
  limit: 20,
  offset: 0,
});

function build(
  t: SessionTreeResponse,
  options: {
    open?: Record<string, boolean>;
    expanded?: string[];
    lists?: Record<string, ListState>;
  } & Pick<BuildTreeRowsOptions, "starredGroups" | "hiddenGroups" | "showHidden" | "starred"> = {},
) {
  return buildTreeRows({
    tree: t,
    groups: buildSessionGroupTree(t.groups, ME),
    isOpen: (id) => options.open?.[id] ?? openByDefault(id, ME),
    expanded: new Set(options.expanded ?? []),
    lists: new Map(Object.entries(options.lists ?? {})),
    starredGroups: options.starredGroups,
    hiddenGroups: options.hiddenGroups,
    showHidden: options.showHidden,
    starred: options.starred,
  });
}
const keys = (rows: { key: string }[]) => rows.map((row) => row.key);

describe("buildTreeRows", () => {
  test("sections come in order, and only open lists with sessions load", () => {
    const { rows, containers } = build(
      tree([group("shared/a/", 2)], { inbox: counts(3), later: counts(0), noGroup: counts(1) }),
    );
    // Inbox, then the groups (ongoing work), then Later and Done.
    expect(keys(rows)).toEqual([
      "box:inbox",
      "loading:inbox",
      "section:mine",
      "group:shared/a/",
      "add:group",
      "box:nogroup",
      "box:later",
      "empty:later",
      "box:done",
    ]);
    // Later is open but empty, No group and the group are folded.
    expect(containers).toEqual(["inbox"]);
  });

  test("10 rows, then Show 10 more once, then View all N", () => {
    const t = tree([], { inbox: counts(35) });
    const lists = { inbox: { data: page(20, 35), failed: false } };
    const first = build(t, { lists }).rows.filter((row) => row.key !== "section:mine");
    const inbox = first.filter((row) => row.key.startsWith("s:inbox:"));
    expect(inbox).toHaveLength(10);
    expect(first.find((row) => row.type === "more")).toMatchObject({ count: 10 });
    expect(first.find((row) => row.type === "all")).toMatchObject({ total: 35 });

    const more = build(t, { lists, expanded: ["inbox"] }).rows;
    expect(more.filter((row) => row.key.startsWith("s:inbox:"))).toHaveLength(20);
    expect(more.some((row) => row.type === "more")).toBe(false);
    expect(more.find((row) => row.type === "all")).toMatchObject({ total: 35 });

    // 13 sessions: 3 more, and View all still opens the group tab.
    const few = build(tree([], { inbox: counts(13) }), {
      lists: { inbox: { data: page(13), failed: false } },
    }).rows;
    expect(few.find((row) => row.type === "more")).toMatchObject({ count: 3 });
    // 10 or fewer: neither row.
    const ten = build(tree([], { inbox: counts(10) }), {
      lists: { inbox: { data: page(10), failed: false } },
    }).rows;
    expect(ten.some((row) => row.type === "more" || row.type === "all")).toBe(false);
  });

  test("an empty list, a failed load, and an emptied list each show their state", () => {
    const empty = build(tree()).rows.find((row) => row.key === "empty:inbox");
    expect(empty).toMatchObject({ type: "empty", kind: "inbox", parentKey: "box:inbox" });

    const failed = build(tree([], { inbox: counts(2) }), {
      lists: { inbox: { failed: true } },
    }).rows.find((row) => row.key === "empty:inbox");
    expect(failed).toMatchObject({ kind: "failed", parentKey: "box:inbox" });

    // The tree still counts 2, but Done just took both: the list is empty.
    const drained = build(tree([], { inbox: counts(2) }), {
      lists: { inbox: { data: page(0), failed: false } },
    }).rows.find((row) => row.key === "empty:inbox");
    expect(drained).toMatchObject({ kind: "inbox" });
  });

  test("an open group lists its subgroups, then its own sessions; a parent holds no state", () => {
    const t = tree([group("shared/a/", 1), group("shared/a/b/", 2), group("shared/x/", 0)]);
    const { rows, containers } = build(t, {
      open: { inbox: false, later: false, "shared/a/": true, "shared/x/": true },
      lists: { "shared/a/": { data: page(1), failed: false } },
    });
    expect(keys(rows).slice(1, -3)).toEqual([
      "section:mine",
      "group:shared/a/",
      "group:shared/a/b/",
      "s:shared/a/:s0",
      "group:shared/x/",
      "empty:shared/x/",
      "add:group",
    ]);
    expect(containers).toEqual(["shared/a/"]);
    expect(rows.find((row) => row.key === "group:shared/a/b/")?.level).toBe(1);
  });

  test("no groups: the My groups empty state describes its section", () => {
    const row = build(tree()).rows.find((r) => r.key === "empty:groups");
    expect(row).toMatchObject({ kind: "groups", parentKey: "section:mine" });
    // "New group" stays a row the keys reach, after the invite.
    const all = keys(build(tree()).rows);
    expect(all.slice(all.indexOf("empty:groups"), all.indexOf("empty:groups") + 2)).toEqual([
      "empty:groups",
      "add:group",
    ]);
  });

  test("a new group's name field takes the place of New group, or sits under its parent", () => {
    const t = tree([group("shared/a/", 1)]);
    const top = (creating: string) =>
      keys(
        buildTreeRows({
          tree: t,
          groups: buildSessionGroupTree(t.groups, ME),
          isOpen: () => false,
          expanded: new Set(),
          lists: new Map(),
          creating,
        }).rows,
      ).slice(-6, -3);
    expect(top("shared/")).toEqual(["section:mine", "group:shared/a/", "create:shared/"]);
    expect(top("shared/a/")).toEqual(["group:shared/a/", "create:shared/a/", "add:group"]);
    // With no groups yet, the field replaces the first-run invite.
    const none = buildTreeRows({
      tree: tree(),
      groups: buildSessionGroupTree([], ME),
      isOpen: () => false,
      expanded: new Set(),
      lists: new Map(),
      creating: "shared/",
    }).rows;
    expect(none.some((r) => r.key === "empty:groups")).toBe(false);
    expect(none.at(-4)?.type).toBe("create");
  });

  test("a group that lives only in this browser invites a move", () => {
    const t = tree([group("shared/a/", 0)]);
    const rows = buildTreeRows({
      tree: t,
      groups: buildSessionGroupTree(t.groups, ME),
      isOpen: (id) => id === "shared/a/",
      expanded: new Set(),
      lists: new Map(),
      localGroups: new Set(["shared/a/"]),
    }).rows;
    expect(rows.find((r) => r.key === "empty:shared/a/")).toMatchObject({
      kind: "fresh",
      groupKey: "shared/a/",
    });
  });

  test("Shared with me shows owners, open owners list their groups open", () => {
    const t = tree([group("personal/lena/notes/", 2)]);
    const folded = build(t).rows;
    expect(folded.find((row) => row.type === "owner")).toMatchObject({
      ownerId: "lena",
      open: false,
      counts: counts(2),
    });
    const open = build(t, { open: { "owner:lena": true } }).rows;
    expect(open.find((row) => row.type === "owner")).toMatchObject({ counts: null });
    expect(open.find((row) => row.key === "group:personal/lena/notes/")).toMatchObject({
      level: 1,
      open: true,
      sharedWithMe: true,
    });
    expect(open.some((row) => row.key === "loading:personal/lena/notes/")).toBe(true);
  });

  test("sections, empty states, and loading rows are not cursor stops", () => {
    const { rows } = build(tree([], { inbox: counts(1) }));
    expect(rows.filter(isNavRow).map((row) => row.type)).toEqual([
      "box",
      "add",
      "box",
      "box",
      "box",
    ]);
  });

  test("foldIds lists every section, group, and owner the tree can show", () => {
    const groups = buildSessionGroupTree(
      [group("shared/a/b/", 1), group("personal/lena/notes/", 1)],
      ME,
    );
    expect([...foldIds(groups)].sort()).toEqual(
      [
        "done",
        "inbox",
        "later",
        "nogroup",
        "owner:lena",
        "personal/lena/notes/",
        "shared/a/",
        "shared/a/b/",
        "working",
      ].sort(),
    );
  });
});

describe("source sections (sources Phase 5)", () => {
  const t = tree([
    group("shared/a/", 1),
    group("personal/lena/notes/", 1),
    group("shared/telegram/-1001/", 2),
    group("shared/slack/c0eng00001/", 3),
    group("shared/slack/d0dm000001/", 1),
  ]);

  test("sections follow Shared with me in source order, folded by default", () => {
    const { rows, containers } = build(t, { open: { inbox: false, later: false } });
    expect(keys(rows).slice(1, -3)).toEqual([
      "section:mine",
      "group:shared/a/",
      "add:group",
      "section:shared",
      "owner:lena",
      "source:slack",
      "source:telegram",
    ]);
    expect(rows.find((row) => row.key === "source:slack")).toMatchObject({
      type: "source",
      source: "slack",
      level: 0,
      open: false,
      counts: counts(4),
    });
    // A folded source loads nothing.
    expect(containers).toEqual([]);
  });

  test("an open source lists its groups as read-only level 1 rows", () => {
    const { rows, containers } = build(t, {
      open: { inbox: false, later: false, "source:slack": true, "shared/slack/c0eng00001/": true },
    });
    const slack = rows.slice(rows.findIndex((row) => row.key === "source:slack"));
    expect(keys(slack)).toEqual([
      "source:slack",
      "group:shared/slack/c0eng00001/",
      "loading:shared/slack/c0eng00001/",
      "group:shared/slack/d0dm000001/",
      "source:telegram",
      "box:nogroup",
      "box:later",
      "box:done",
    ]);
    expect(slack[1]).toMatchObject({ type: "group", level: 1, readOnly: true, open: true });
    expect(slack[3]).toMatchObject({ type: "group", level: 1, readOnly: true, open: false });
    expect(containers).toEqual(["shared/slack/c0eng00001/"]);
    // My groups stay writable.
    expect(rows.find((row) => row.key === "group:shared/a/")).toMatchObject({ readOnly: false });
  });

  test("a source header is a cursor stop that folds its section", () => {
    const { rows } = build(t, { open: { inbox: false, later: false } });
    const source = rows.find((row) => row.key === "source:telegram");
    expect(source && isNavRow(source)).toBe(true);
    expect(source && foldId(source)).toBe("source:telegram");
  });

  test("foldIds keeps the source folds and the source groups", () => {
    const ids = foldIds(buildSessionGroupTree(t.groups, ME));
    for (const id of [
      "source:slack",
      "source:telegram",
      "shared/slack/c0eng00001/",
      "shared/slack/d0dm000001/",
      "shared/telegram/-1001/",
    ]) {
      expect(ids.has(id)).toBe(true);
    }
    expect(openByDefault("source:slack", ME)).toBe(false);
    expect(openByDefault("shared/slack/c0eng00001/", ME)).toBe(false);
  });
});

describe("sessionRange", () => {
  const { rows } = build(tree([], { inbox: counts(3), noGroup: counts(2) }), {
    open: { nogroup: true },
    lists: {
      inbox: { data: page(3), failed: false },
      nogroup: {
        data: { sessions: [session("n0"), session("n1")], total: 2, limit: 20, offset: 0 },
        failed: false,
      },
    },
  });

  test("selects the sessions between two rows, in row order, either way", () => {
    expect(sessionRange(rows, "s:inbox:s0", "s:inbox:s2")).toEqual(["s0", "s1", "s2"]);
    expect(sessionRange(rows, "s:inbox:s2", "s:inbox:s0")).toEqual(["s0", "s1", "s2"]);
  });

  test("skips the section and state rows between two sections", () => {
    expect(sessionRange(rows, "s:inbox:s1", "s:nogroup:n1")).toEqual(["s1", "s2", "n0", "n1"]);
  });

  test("with no start row, only the clicked session; an unknown clicked row selects nothing", () => {
    expect(sessionRange(rows, null, "s:inbox:s1")).toEqual(["s1"]);
    expect(sessionRange(rows, "s:gone", "s:inbox:s1")).toEqual(["s1"]);
    expect(sessionRange(rows, "s:inbox:s0", "s:gone")).toEqual([]);
  });
});

describe("list selection", () => {
  const { rows } = build(tree([], { inbox: counts(3), noGroup: counts(2) }), {
    open: { nogroup: true },
    lists: {
      inbox: { data: page(3), failed: false },
      nogroup: {
        data: { sessions: [session("n0"), session("n1")], total: 2, limit: 20, offset: 0 },
        failed: false,
      },
    },
  });
  const byList = listSessionIds(rows);

  test("listSessionIds holds each list's loaded sessions in row order", () => {
    expect([...byList]).toEqual([
      ["inbox", ["s0", "s1", "s2"]],
      ["nogroup", ["n0", "n1"]],
    ]);
  });

  test("listSelectState: all, some, none, or null with no loaded rows", () => {
    const ids = byList.get("inbox");
    expect(listSelectState(ids, new Set(["s0", "s1", "s2", "n0"]))).toBe("all");
    expect(listSelectState(ids, new Set(["s1", "n0"]))).toBe("some");
    expect(listSelectState(ids, new Set(["n0"]))).toBe("none");
    expect(listSelectState(byList.get("later"), new Set(["s0"]))).toBeNull();
    expect(listSelectState([], new Set())).toBeNull();
  });

  test("fullListOf: the list only when its loaded rows are exactly the selection", () => {
    const ids = byList.get("inbox");
    expect(fullListOf("inbox", ids, new Set(["s0", "s1", "s2"]))).toBe("inbox");
    expect(fullListOf("inbox", ids, new Set(["s0", "s1"]))).toBeNull();
    expect(fullListOf("inbox", ids, new Set(["s0", "s1", "s2", "n0"]))).toBeNull();
    expect(fullListOf(null, ids, new Set(["s0", "s1", "s2"]))).toBeNull();
  });

  test("wholeListTotal: the View all N total only while the list has unloaded sessions", () => {
    const longer = build(tree([], { inbox: counts(50) }), {
      lists: { inbox: { data: page(20, 50), failed: false } },
    }).rows;
    expect(wholeListTotal(longer, "inbox")).toBe(50);
    // Show 10 more loaded all 15: the View all row stays, but nothing is left to select.
    const loaded = build(tree([], { inbox: counts(15) }), {
      expanded: ["inbox"],
      lists: { inbox: { data: page(15), failed: false } },
    }).rows;
    expect(loaded.some((row) => row.type === "all")).toBe(true);
    expect(wholeListTotal(loaded, "inbox")).toBeNull();
    // No View all row: the list fits in 10.
    expect(wholeListTotal(rows, "inbox")).toBeNull();
  });

  test("wholeListOn: Select all 12 with all 10 loaded rows unchecked still holds the 2 unloaded", () => {
    expect(wholeListOn(0, 12, 10)).toBe(true);
    expect(wholeListOn(9, 12, 1)).toBe(true);
    // Every session unchecked, or nothing past the loaded rows: the selection ends.
    expect(wholeListOn(0, 12, 12)).toBe(false);
    expect(wholeListOn(0, null, 10)).toBe(false);
    expect(wholeListOn(1, null, 9)).toBe(true);
  });
});

describe("resource sections", () => {
  const t = tree([
    group("shared/a/", 1),
    group("shared/slack/c0eng00001/", 1),
    group("shared/workflow:w1/", 3),
    group("shared/page:p1/", 2),
  ]);

  test("one read-only section per kind after the sources, named by kind", () => {
    const { rows } = build(t, {
      open: { inbox: false, later: false, "source:page": true },
    });
    expect(keys(rows).slice(1, -3)).toEqual([
      "section:mine",
      "group:shared/a/",
      "add:group",
      "source:slack",
      "source:page",
      "group:shared/page:p1/",
      "source:workflow",
    ]);
    expect(rows.find((row) => row.key === "source:page")).toMatchObject({
      type: "source",
      source: "page",
      label: "Pages",
      counts: counts(2),
    });
    expect(rows.find((row) => row.key === "source:workflow")).toMatchObject({
      label: "Workflows",
      open: false,
    });
    expect(rows.find((row) => row.key === "source:slack")).toMatchObject({ label: "Slack" });
    const pageGroup = rows.find((row) => row.key === "group:shared/page:p1/");
    expect(pageGroup).toMatchObject({ level: 1, readOnly: true });
    expect(isMyGroupRow(pageGroup)).toBe(false);
  });

  test("foldIds keeps the resource folds and groups", () => {
    const ids = foldIds(buildSessionGroupTree(t.groups, ME));
    expect(ids.has("source:workflow")).toBe(true);
    expect(ids.has("shared/workflow:w1/")).toBe(true);
  });
});

describe("groupStarKey", () => {
  const groupRow = (key: string, thread?: boolean) =>
    ({
      type: "group",
      key: `group:${key}`,
      level: 1,
      node: { key, thread },
      open: false,
      counts: counts(1),
      sharedWithMe: false,
    }) as unknown as TreeRow;

  test("stars real group rows only, not thread rows or other rows", () => {
    expect(groupStarKey(groupRow("shared/a/"))).toBe("shared/a/");
    expect(groupStarKey(groupRow("shared/slack/c1/", false))).toBe("shared/slack/c1/");
    expect(groupStarKey(groupRow("shared/slack/c1/thread:1/", true))).toBeNull();
    expect(groupStarKey({ type: "add", key: "add:group", level: 1 } as TreeRow)).toBeNull();
  });
});

describe("sidebar stars, hidden groups, source paging, and Working", () => {
  const closed = { inbox: false, later: false };
  const groupKeys = (rows: TreeRow[]) =>
    rows.flatMap((row) => (row.type === "group" ? [row.node.key] : []));
  const at = (minute: number) => `2026-10-21T10:${String(minute).padStart(2, "0")}:00.000Z`;
  const dated = (key: string, minute: number): SessionTreeGroup => ({
    ...group(key, 1),
    lastActivityAt: at(minute),
  });

  test("starred groups come first in My groups, the rest stay newest first", () => {
    const t = tree([dated("shared/a/", 3), dated("shared/b/", 2), dated("shared/c/", 1)]);
    expect(groupKeys(build(t, { open: closed }).rows)).toEqual([
      "shared/a/",
      "shared/b/",
      "shared/c/",
    ]);
    const { rows } = build(t, { open: closed, starredGroups: new Set(["shared/c/"]) });
    expect(groupKeys(rows)).toEqual(["shared/c/", "shared/a/", "shared/b/"]);
  });

  test("starred groups come first inside a source section too", () => {
    const t = tree([dated("shared/slack/c01/", 5), dated("shared/slack/c02/", 1)]);
    const { rows } = build(t, {
      open: { ...closed, "source:slack": true },
      starredGroups: new Set(["shared/slack/c02/"]),
    });
    expect(groupKeys(rows)).toEqual(["shared/slack/c02/", "shared/slack/c01/"]);
  });

  test("a hidden group leaves the tree; Show N hidden brings it back dimmed", () => {
    const t = tree([dated("shared/a/", 2), dated("shared/b/", 1)]);
    const hiddenGroups = new Set(["shared/a/", "shared/gone/"]);
    const hidden = build(t, { open: closed, hiddenGroups }).rows;
    expect(groupKeys(hidden)).toEqual(["shared/b/"]);
    // Only hidden groups that still exist count.
    expect(hidden.find((row) => row.type === "hidden")).toMatchObject({ count: 1, open: false });

    const shown = build(t, { open: closed, hiddenGroups, showHidden: true }).rows;
    expect(groupKeys(shown)).toEqual(["shared/a/", "shared/b/"]);
    expect(shown.find((row) => row.key === "group:shared/a/")).toMatchObject({ hidden: true });
    expect(shown.find((row) => row.type === "hidden")).toMatchObject({ count: 1, open: true });
    expect(isNavRow(shown.find((row) => row.type === "hidden")!)).toBe(true);
  });

  test("a source section shows its 10 newest groups, then Show 10 more, then the rest", () => {
    const t = tree(Array.from({ length: 25 }, (_, i) => dated(`shared/slack/c${100 + i}/`, i)));
    const open = { ...closed, "source:slack": true };
    const newest = Array.from({ length: 25 }, (_, i) => `shared/slack/c${124 - i}/`);

    const first = build(t, { open }).rows;
    expect(groupKeys(first)).toEqual(newest.slice(0, 10));
    expect(first.find((row) => row.type === "more")).toMatchObject({
      container: "groups:source:slack",
      count: 10,
    });

    const second = build(t, { open, expanded: ["groups:source:slack"] }).rows;
    expect(groupKeys(second)).toEqual(newest.slice(0, 20));
    expect(second.find((row) => row.type === "more")).toMatchObject({
      container: "groups:source:slack:all",
      count: 5,
    });

    const all = build(t, {
      open,
      expanded: ["groups:source:slack", "groups:source:slack:all"],
    }).rows;
    expect(groupKeys(all)).toEqual(newest);
    expect(all.some((row) => row.type === "more")).toBe(false);
  });

  test("a source group pages its threads the same way", () => {
    const channel = "shared/slack/c0dm/";
    const threads = Array.from({ length: 12 }, (_, i) =>
      dated(`${channel}thread:17000000${i}.1/`, i),
    );
    const t = tree([dated(channel, 0), ...threads]);
    const { rows } = build(t, { open: { ...closed, "source:slack": true, [channel]: true } });
    expect(groupKeys(rows).filter((key) => key.includes("thread:"))).toHaveLength(10);
    expect(rows.find((row) => row.type === "more")).toMatchObject({
      container: `groups:${channel}`,
      count: 2,
    });
  });

  test("a source group whose sessions are all Done still lists them (the server counts them)", () => {
    // The server counts a source group's Done sessions (item 5): total > 0 loads its list.
    const key = "shared/slack/c0done/";
    const t = tree([group(key, 2)]);
    const { rows, containers } = build(t, {
      open: { ...closed, "source:slack": true, [key]: true },
      lists: { [key]: { data: page(2), failed: false } },
    });
    expect(containers).toEqual([key]);
    expect(rows.filter((row) => row.type === "session")).toHaveLength(2);
    expect(rows.some((row) => row.key === `empty:${key}`)).toBe(false);
  });

  test("Working sits right under the Inbox, and hides while empty", () => {
    const empty = build(tree([], { inbox: counts(1) })).rows;
    expect(empty.some((row) => row.key === "box:working")).toBe(false);

    const { rows, containers } = build(tree([], { inbox: counts(1), working: counts(2) }));
    const boxes = rows.flatMap((row) => (row.type === "box" ? [row.id] : []));
    expect(boxes.slice(0, 2)).toEqual(["inbox", "working"]);
    expect(containers).toContain("working");
    expect(rows.find((row) => row.key === "box:working")).toMatchObject({ open: true });
  });

  test("starred sessions list under Starred after the Inbox", () => {
    const { rows } = build(tree([], { inbox: counts(0) }), {
      open: closed,
      starred: { data: page(2), failed: false },
    });
    const at = rows.findIndex((row) => row.key === "section:starred");
    expect(at).toBe(1);
    expect(rows.slice(at + 1, at + 3).map((row) => row.key)).toEqual([
      "s:starred:s0",
      "s:starred:s1",
    ]);
  });
});
