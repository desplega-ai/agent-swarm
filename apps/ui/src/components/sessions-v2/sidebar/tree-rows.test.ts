import { describe, expect, test } from "bun:test";
import type {
  SessionListItem,
  SessionSectionCounts,
  SessionsListResponse,
  SessionTreeGroup,
  SessionTreeResponse,
} from "../../../api/types";
import { buildSessionGroupTree } from "../../../lib/session-groups";
import { buildTreeRows, foldIds, isNavRow, type ListState, openByDefault } from "./tree-rows";

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
  } = {},
) {
  return buildTreeRows({
    tree: t,
    groups: buildSessionGroupTree(t.groups, ME),
    isOpen: (id) => options.open?.[id] ?? openByDefault(id, ME),
    expanded: new Set(options.expanded ?? []),
    lists: new Map(Object.entries(options.lists ?? {})),
  });
}
const keys = (rows: { key: string }[]) => rows.map((row) => row.key);

describe("buildTreeRows", () => {
  test("sections come in order, and only open lists with sessions load", () => {
    const { rows, containers } = build(
      tree([group("shared/a/", 2)], { inbox: counts(3), later: counts(0), noGroup: counts(1) }),
    );
    expect(keys(rows)).toEqual([
      "box:inbox",
      "loading:inbox",
      "box:later",
      "empty:later",
      "box:done",
      "box:nogroup",
      "section:mine",
      "group:shared/a/",
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
    expect(keys(rows).slice(4)).toEqual([
      "section:mine",
      "group:shared/a/",
      "group:shared/a/b/",
      "s:shared/a/:s0",
      "group:shared/x/",
      "empty:shared/x/",
    ]);
    expect(containers).toEqual(["shared/a/"]);
    expect(rows.find((row) => row.key === "group:shared/a/b/")?.level).toBe(1);
  });

  test("no groups: the My groups empty state describes its section", () => {
    const row = build(tree()).rows.find((r) => r.key === "empty:groups");
    expect(row).toMatchObject({ kind: "groups", parentKey: "section:mine" });
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
    expect(rows.filter(isNavRow).map((row) => row.type)).toEqual(["box", "box", "box", "box"]);
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
      ].sort(),
    );
  });
});
