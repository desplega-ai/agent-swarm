import { describe, expect, test } from "bun:test";
import type { SessionTreeGroup } from "../api/types";
import {
  buildSessionGroupTree,
  groupCrumb,
  groupLabel,
  isNoGroupKey,
  personalOwner,
} from "./session-groups";

const ME = "me-1";

function group(
  key: string,
  lastActivityAt: string,
  counts: Partial<Omit<SessionTreeGroup, "key" | "lastActivityAt">> = {},
): SessionTreeGroup {
  return { key, lastActivityAt, total: 1, unread: 0, running: 0, needsYou: 0, ...counts };
}

describe("buildSessionGroupTree", () => {
  test("nests groups by slash and adds a parent for every prefix", () => {
    const tree = buildSessionGroupTree(
      [
        group("shared/northwind/pricing/", "2026-10-21T10:00:00.000Z", { total: 4, unread: 2 }),
        group("shared/northwind/ios/", "2026-10-21T09:00:00.000Z", { total: 3, running: 1 }),
        group("shared/infra/", "2026-10-20T09:00:00.000Z", { total: 2, needsYou: 1 }),
      ],
      ME,
    );
    expect(tree.myGroups.map((node) => node.key)).toEqual(["shared/northwind/", "shared/infra/"]);
    const northwind = tree.myGroups[0];
    expect(northwind.name).toBe("northwind");
    expect(northwind.own).toEqual({ total: 0, unread: 0, running: 0, needsYou: 0 });
    expect(northwind.children.map((node) => node.name)).toEqual(["pricing", "ios"]);
    expect(northwind.lastActivityAt).toBe("2026-10-21T10:00:00.000Z");
  });

  test("a folded group shows its subtree, an open one its own sessions", () => {
    const tree = buildSessionGroupTree(
      [
        group("shared/a/", "2026-10-21T08:00:00.000Z", { total: 1, unread: 1 }),
        group("shared/a/b/", "2026-10-21T09:00:00.000Z", { total: 2, unread: 1, running: 1 }),
        group("shared/a/b/c/", "2026-10-21T07:00:00.000Z", { total: 3, needsYou: 2 }),
      ],
      ME,
    );
    const a = tree.myGroups[0];
    expect(a.own).toEqual({ total: 1, unread: 1, running: 0, needsYou: 0 });
    expect(a.subtree).toEqual({ total: 6, unread: 2, running: 1, needsYou: 2 });
    expect(a.children[0].subtree).toEqual({ total: 5, unread: 1, running: 1, needsYou: 2 });
    expect(tree.myGroupsTotal).toBe(6);
  });

  test("my personal groups sit in My groups by name, with no namespace prefix", () => {
    const tree = buildSessionGroupTree(
      [group(`personal/${ME}/notes/`, "2026-10-21T10:00:00.000Z")],
      ME,
    );
    expect(tree.myGroups).toHaveLength(1);
    expect(tree.myGroups[0].name).toBe("notes");
    expect(tree.myGroups[0].privateClash).toBe(false);
    expect(tree.sharedWithMe).toEqual([]);
  });

  test("a personal group whose path a shared group also uses gets the lock", () => {
    const tree = buildSessionGroupTree(
      [
        group(`personal/${ME}/infra/`, "2026-10-21T10:00:00.000Z"),
        group("shared/infra/", "2026-10-21T09:00:00.000Z"),
        group(`personal/${ME}/notes/`, "2026-10-21T08:00:00.000Z"),
      ],
      ME,
    );
    const byKey = new Map(tree.myGroups.map((node) => [node.key, node]));
    expect(byKey.get(`personal/${ME}/infra/`)?.privateClash).toBe(true);
    expect(byKey.get("shared/infra/")?.privateClash).toBe(false);
    expect(byKey.get(`personal/${ME}/notes/`)?.privateClash).toBe(false);
  });

  test("other people's personal groups go under Shared with me, one node per owner", () => {
    const tree = buildSessionGroupTree(
      [
        group("personal/lena/notes/q4/", "2026-10-21T08:00:00.000Z", { total: 2, unread: 1 }),
        group("personal/lena/", "2026-10-21T09:00:00.000Z"),
        group("personal/marco/drafts/", "2026-10-21T10:00:00.000Z", { total: 3 }),
      ],
      ME,
    );
    expect(tree.myGroups).toEqual([]);
    expect(tree.sharedWithMe.map((owner) => owner.ownerId)).toEqual(["marco", "lena"]);
    const lena = tree.sharedWithMe[1];
    expect(lena.groups.map((node) => node.name)).toEqual(["", "notes › q4"]);
    expect(lena.subtree).toEqual({ total: 3, unread: 1, running: 0, needsYou: 0 });
    expect(tree.sharedWithMeTotal).toBe(6);
  });

  test("No group keys stay out of the tree", () => {
    const tree = buildSessionGroupTree(
      [
        group("shared/", "2026-10-21T10:00:00.000Z"),
        group(`personal/${ME}/`, "2026-10-21T10:00:00.000Z"),
      ],
      ME,
    );
    expect(tree.myGroups).toEqual([]);
    expect(tree.sharedWithMe).toEqual([]);
  });

  test("with no picked user, every personal group belongs to another person", () => {
    const tree = buildSessionGroupTree(
      [
        group(`personal/${ME}/notes/`, "2026-10-21T10:00:00.000Z"),
        group("shared/x/", "2026-10-21T09:00:00.000Z"),
      ],
      null,
    );
    expect(tree.myGroups.map((node) => node.key)).toEqual(["shared/x/"]);
    expect(tree.sharedWithMe.map((owner) => owner.ownerId)).toEqual([ME]);
  });

  test("groups with the same activity sort by name, so polls never reorder them", () => {
    const at = "2026-10-21T10:00:00.000Z";
    const tree = buildSessionGroupTree([group("shared/b/", at), group("shared/a/", at)], ME);
    expect(tree.myGroups.map((node) => node.name)).toEqual(["a", "b"]);
  });
});

describe("group keys", () => {
  test("isNoGroupKey matches shared/ and my own personal root only", () => {
    expect(isNoGroupKey("shared/", ME)).toBe(true);
    expect(isNoGroupKey(`personal/${ME}/`, ME)).toBe(true);
    expect(isNoGroupKey("personal/lena/", ME)).toBe(false);
    expect(isNoGroupKey(`personal/${ME}/`, null)).toBe(false);
    expect(isNoGroupKey("shared/a/", ME)).toBe(false);
  });

  test("personalOwner reads the owner of a personal key", () => {
    expect(personalOwner("personal/lena/notes/")).toBe("lena");
    expect(personalOwner("shared/a/")).toBeNull();
  });

  test("groupLabel is the last segment, empty for No group", () => {
    expect(groupLabel("shared/northwind/pricing/", ME)).toBe("pricing");
    expect(groupLabel(`personal/${ME}/notes/`, ME)).toBe("notes");
    expect(groupLabel("shared/release:v2/", ME)).toBe("release:v2");
    expect(groupLabel("shared/", ME)).toBe("");
    expect(groupLabel(`personal/${ME}/`, ME)).toBe("");
    expect(groupLabel("personal/lena/", ME)).toBe("");
    expect(groupLabel(undefined, ME)).toBe("");
  });

  test("groupCrumb joins the path and names the owner of another person's group", () => {
    const nameOf = (id: string) => (id === "lena" ? "Lena" : id);
    expect(groupCrumb("shared/northwind/pricing/", ME, nameOf)).toBe("northwind › pricing");
    expect(groupCrumb(`personal/${ME}/notes/`, ME, nameOf)).toBe("notes");
    expect(groupCrumb("personal/lena/notes/", ME, nameOf)).toBe("Lena › notes");
    expect(groupCrumb("shared/", ME, nameOf)).toBe("No group");
  });
});
