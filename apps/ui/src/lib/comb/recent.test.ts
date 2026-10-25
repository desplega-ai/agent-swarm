import { describe, expect, test } from "bun:test";
import type { RecentEntry } from "../agent-fs/types";
import {
  folderLabel,
  forgetViewed,
  readViewed,
  recentChanges,
  rememberViewed,
  VIEWED_MAX,
  viewedStorageKey,
  writeViewed,
} from "./recent";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

describe("recently viewed", () => {
  test("a file moves to the top and is never listed twice", () => {
    let list = rememberViewed([], "/a.md", 1);
    list = rememberViewed(list, "/b.md", 2);
    list = rememberViewed(list, "/a.md", 3);
    expect(list).toEqual([
      { path: "/a.md", at: 3 },
      { path: "/b.md", at: 2 },
    ]);
  });

  test("keeps at most VIEWED_MAX files, dropping the oldest", () => {
    let list = rememberViewed([], "/0.md", 0);
    for (let i = 1; i <= VIEWED_MAX; i++) list = rememberViewed(list, `/${i}.md`, i);
    expect(list).toHaveLength(VIEWED_MAX);
    expect(list[0]?.path).toBe(`/${VIEWED_MAX}.md`);
    expect(list.some((entry) => entry.path === "/0.md")).toBe(false);
  });

  test("forgetViewed drops one file", () => {
    expect(forgetViewed([{ path: "/a.md", at: 1 }], "/a.md")).toEqual([]);
  });

  test("the key is per swarm, per agent-fs user, and per drive", () => {
    const a = viewedStorageKey("https://api.one", "u1", { orgId: "o", driveId: "d1" });
    expect(a).not.toBe(viewedStorageKey("https://api.two", "u1", { orgId: "o", driveId: "d1" }));
    expect(a).not.toBe(viewedStorageKey("https://api.one", "u2", { orgId: "o", driveId: "d1" }));
    expect(a).not.toBe(viewedStorageKey("https://api.one", "u1", { orgId: "o", driveId: "d2" }));
  });

  test("reads back what it wrote, and reads junk as an empty list", () => {
    const storage = memoryStorage();
    const list = [{ path: "/a.md", at: 1 }];
    writeViewed(storage, "k", list);
    expect(readViewed(storage, "k")).toEqual(list);
    expect(readViewed(storage, "missing")).toEqual([]);
    storage.setItem("bad", "{not json");
    expect(readViewed(storage, "bad")).toEqual([]);
    storage.setItem(
      "odd",
      JSON.stringify([{ path: "no-slash", at: 1 }, { path: "/x", at: "1" }, 4]),
    );
    expect(readViewed(storage, "odd")).toEqual([]);
    expect(readViewed(null, "k")).toEqual([]);
  });
});

describe("recentChanges", () => {
  const entry = (path: string, version: number, operation: RecentEntry["operation"] = "write") =>
    ({
      path,
      version,
      author: "u1",
      createdAt: `2026-10-25T10:00:0${version}Z`,
      operation,
    }) satisfies RecentEntry;

  test("one row per file, its newest version, with a leading slash", () => {
    const changes = recentChanges(
      [entry("docs/a.md", 3), entry("/b.md", 2), entry("docs/a.md", 1)],
      10,
    );
    expect(changes).toEqual([
      { path: "/docs/a.md", author: "u1", at: "2026-10-25T10:00:03Z" },
      { path: "/b.md", author: "u1", at: "2026-10-25T10:00:02Z" },
    ]);
  });

  test("a file whose newest version is a delete is left out, older writes too", () => {
    const changes = recentChanges(
      [entry("old.md", 4, "delete"), entry("new.md", 3), entry("old.md", 2)],
      10,
    );
    expect(changes.map((change) => change.path)).toEqual(["/new.md"]);
  });

  test("stops at max", () => {
    const changes = recentChanges([entry("a", 3), entry("b", 2), entry("c", 1)], 2);
    expect(changes.map((change) => change.path)).toEqual(["/a", "/b"]);
  });
});

describe("folderLabel", () => {
  test("names the folder without slashes, or the drive root", () => {
    expect(folderLabel("/docs/plans/a.md")).toBe("docs/plans");
    expect(folderLabel("/a.md")).toBe("Drive root");
  });
});
