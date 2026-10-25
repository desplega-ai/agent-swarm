import { describe, expect, test } from "bun:test";
import type { LsEntry } from "../agent-fs/types";
import {
  type FolderListing,
  flattenTree,
  matchTree,
  nameParts,
  sortEntries,
  visibleFolders,
} from "./tree";

const file = (name: string): LsEntry => ({ name, type: "file", size: 1 });
const dir = (name: string): LsEntry => ({ name, type: "directory", size: 0 });

describe("sortEntries", () => {
  test("folders first, then natural name order", () => {
    const sorted = sortEntries([file("b10.md"), dir("z"), file("b2.md"), dir("a"), file("A.md")]);
    expect(sorted.map((e) => e.name)).toEqual(["a", "z", "A.md", "b2.md", "b10.md"]);
  });
});

describe("visibleFolders", () => {
  test("skips open folders under a closed parent", () => {
    const expanded = new Set(["/a/", "/a/b/", "/c/d/"]);
    expect(visibleFolders(expanded)).toEqual(["/", "/a/", "/a/b/"]);
  });
});

describe("flattenTree", () => {
  const listings: Record<string, FolderListing> = {
    "/": [file("readme.md"), dir("docs"), dir("empty")],
    "/docs/": [file("b.md"), dir("deep")],
    "/docs/deep/": "loading",
    "/empty/": [],
  };
  const listing = (folder: string) => listings[folder] ?? "loading";

  test("closed folders hide their children", () => {
    const rows = flattenTree(listing, new Set());
    expect(rows.map((r) => (r.kind === "entry" ? r.path : r.key))).toEqual([
      "/docs/",
      "/empty/",
      "/readme.md",
    ]);
  });

  test("open folders nest one level deeper, with status rows", () => {
    const rows = flattenTree(listing, new Set(["/docs/", "/docs/deep/", "/empty/"]));
    expect(
      rows.map((r) => (r.kind === "entry" ? `${r.level}:${r.path}` : `${r.level}:${r.key}`)),
    ).toEqual([
      "1:/docs/",
      "2:/docs/deep/",
      "3:/docs/deep/:loading",
      "2:/docs/b.md",
      "1:/empty/",
      "2:/empty/:empty",
      "1:/readme.md",
    ]);
    const deep = rows.find((r) => r.kind === "entry" && r.path === "/docs/deep/");
    expect(deep).toMatchObject({ posinset: 1, setsize: 2, isFolder: true });
    const status = rows.filter((r) => r.kind === "status");
    expect(status.map((r) => r.folder)).toEqual(["/docs/deep/", "/empty/"]);
  });

  test("a root that is not listed yet is one status row", () => {
    expect(flattenTree(() => "error", new Set())).toEqual([
      { kind: "status", key: "/:error", folder: "/", level: 1, status: "error" },
    ]);
  });
});

describe("matchTree", () => {
  test("matched files under their folders, all open, sorted like the drive", () => {
    const rows = matchTree(["/b/x.md", "/a.md", "/b/c/y.md", "/b/a.md"]);
    expect(rows.map((row) => (row.kind === "entry" ? `${row.level}:${row.path}` : ""))).toEqual([
      "1:/b/",
      "2:/b/c/",
      "3:/b/c/y.md",
      "2:/b/a.md",
      "2:/b/x.md",
      "1:/a.md",
    ]);
    const b = rows[0];
    expect(b?.kind === "entry" && [b.posinset, b.setsize]).toEqual([1, 2]);
  });

  test("no matches, no rows", () => {
    expect(matchTree([])).toEqual([]);
  });
});

describe("nameParts", () => {
  test("marks each query word, case-insensitive, merging touching marks", () => {
    expect(nameParts("Seed-Deck-v3.md", "deck seed")).toEqual([
      { text: "Seed", hit: true },
      { text: "-", hit: false },
      { text: "Deck", hit: true },
      { text: "-v3.md", hit: false },
    ]);
    expect(nameParts("abc", "  ")).toEqual([{ text: "abc", hit: false }]);
    expect(nameParts("aaa", "aa")).toEqual([
      { text: "aa", hit: true },
      { text: "a", hit: false },
    ]);
  });
});
