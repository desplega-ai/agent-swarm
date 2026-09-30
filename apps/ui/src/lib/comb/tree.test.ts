import { describe, expect, test } from "bun:test";
import type { LsEntry } from "../agent-fs/types";
import { type FolderListing, flattenTree, sortEntries, visibleFolders } from "./tree";

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
