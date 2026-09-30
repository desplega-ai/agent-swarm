import { describe, expect, test } from "bun:test";
import {
  ancestorFolders,
  baseName,
  childPath,
  combPath,
  drivePins,
  parentFolder,
  parseCombSplat,
  parsePinId,
  pinIdFor,
  pinLabel,
  resolveRelative,
} from "./paths";

const IDS = { orgId: "org-1", driveId: "drive-1" };

describe("parseCombSplat", () => {
  test("an empty splat is the drive root", () => {
    expect(parseCombSplat({ ...IDS, splat: "" })).toEqual({ ...IDS, path: "/", isFolder: true });
    expect(parseCombSplat({ ...IDS, splat: undefined })).toEqual({
      ...IDS,
      path: "/",
      isFolder: true,
    });
  });

  test("a trailing slash means a folder", () => {
    expect(parseCombSplat({ ...IDS, splat: "comb-qa/" })).toEqual({
      ...IDS,
      path: "/comb-qa/",
      isFolder: true,
    });
    expect(parseCombSplat({ ...IDS, splat: "a/b/" }).path).toBe("/a/b/");
  });

  test("no trailing slash means a file", () => {
    expect(parseCombSplat({ ...IDS, splat: "comb-qa/notes.md" })).toEqual({
      ...IDS,
      path: "/comb-qa/notes.md",
      isFolder: false,
    });
  });

  test("duplicate slashes collapse", () => {
    expect(parseCombSplat({ ...IDS, splat: "a//b.md" }).path).toBe("/a/b.md");
  });
});

describe("combPath", () => {
  test("files and folders", () => {
    expect(combPath({ ...IDS, path: "/comb-qa/notes.md" })).toBe(
      "/file/~/org-1/drive-1/comb-qa/notes.md",
    );
    expect(combPath({ ...IDS, path: "/comb-qa/" })).toBe("/file/~/org-1/drive-1/comb-qa/");
    expect(combPath({ ...IDS, path: "/" })).toBe("/file/~/org-1/drive-1/");
  });

  test("encodes each segment and keeps existing %HH escapes", () => {
    expect(combPath({ ...IDS, path: "/my docs/a b#1?.md" })).toBe(
      "/file/~/org-1/drive-1/my%20docs/a%20b%231%3F.md",
    );
    expect(combPath({ ...IDS, path: "/already%20encoded/100%.md" })).toBe(
      "/file/~/org-1/drive-1/already%20encoded/100%25.md",
    );
  });

  test("round-trips through a decoded splat", () => {
    const path = "/my docs/notes (v2).md";
    const url = combPath({ ...IDS, path });
    const splat = decodeURIComponent(url.slice("/file/~/org-1/drive-1/".length));
    expect(parseCombSplat({ ...IDS, splat }).path).toBe(path);
  });
});

describe("path helpers", () => {
  test("baseName and parentFolder", () => {
    expect(baseName("/a/b/c.md")).toBe("c.md");
    expect(baseName("/a/b/")).toBe("b");
    expect(baseName("/")).toBe("");
    expect(parentFolder("/a/b/c.md")).toBe("/a/b/");
    expect(parentFolder("/a/b/")).toBe("/a/");
    expect(parentFolder("/c.md")).toBe("/");
    expect(parentFolder("/")).toBe("/");
  });

  test("ancestorFolders", () => {
    expect(ancestorFolders("/a/b/c.md")).toEqual(["/", "/a/", "/a/b/"]);
    expect(ancestorFolders("/a/b/")).toEqual(["/", "/a/", "/a/b/"]);
    expect(ancestorFolders("/c.md")).toEqual(["/"]);
    expect(ancestorFolders("/")).toEqual(["/"]);
  });

  test("childPath", () => {
    expect(childPath("/", "a", true)).toBe("/a/");
    expect(childPath("/a/", "b.md", false)).toBe("/a/b.md");
  });
});

describe("resolveRelative", () => {
  const from = "/docs/guide/notes.md";

  test("same-folder links", () => {
    expect(resolveRelative(from, "./b.md")).toEqual({ path: "/docs/guide/b.md", suffix: "" });
    expect(resolveRelative(from, "b.md")).toEqual({ path: "/docs/guide/b.md", suffix: "" });
  });

  test("parent links", () => {
    expect(resolveRelative(from, "../x/c.md")).toEqual({ path: "/docs/x/c.md", suffix: "" });
    expect(resolveRelative(from, "../../../../up.md")).toEqual({ path: "/up.md", suffix: "" });
  });

  test("a leading slash is the drive root", () => {
    expect(resolveRelative(from, "/top.md")).toEqual({ path: "/top.md", suffix: "" });
  });

  test("folders keep a trailing slash", () => {
    expect(resolveRelative(from, "./sub/")).toEqual({ path: "/docs/guide/sub/", suffix: "" });
    expect(resolveRelative(from, "..")).toEqual({ path: "/docs/", suffix: "" });
  });

  test("keeps the query and hash, decodes escapes", () => {
    expect(resolveRelative(from, "./my%20file.md#part-2")).toEqual({
      path: "/docs/guide/my file.md",
      suffix: "#part-2",
    });
    expect(resolveRelative(from, "b.md?comment=1")).toEqual({
      path: "/docs/guide/b.md",
      suffix: "?comment=1",
    });
  });

  test("anchors and absolute URLs stay untouched", () => {
    expect(resolveRelative(from, "#anchor")).toBeNull();
    expect(resolveRelative(from, "https://example.com/a.md")).toBeNull();
    expect(resolveRelative(from, "mailto:a@b.c")).toBeNull();
    expect(resolveRelative(from, "//cdn.example.com/x.js")).toBeNull();
    expect(resolveRelative(from, "")).toBeNull();
  });
});

describe("pins", () => {
  test("pinIdFor and parsePinId round-trip files, folders, and the root", () => {
    for (const path of [
      "/comb-qa/",
      "/comb-qa/notes.md",
      "/",
      "/my docs/Q3 plan 100%.md",
      "/a/%20literal/",
      "/%E2%9C%93 done.md",
    ]) {
      const id = pinIdFor({ ...IDS, path });
      expect(parsePinId(id)).toEqual({ ...IDS, path });
    }
    expect(pinIdFor({ ...IDS, path: "/comb-qa/" })).toBe("org-1/drive-1/comb-qa/");
    expect(pinIdFor({ ...IDS, path: "/" })).toBe("org-1/drive-1/");
  });

  test("parsePinId rejects ids without an org and a drive, and dot segments", () => {
    expect(parsePinId("")).toBeNull();
    expect(parsePinId("org-1")).toBeNull();
    expect(parsePinId("org-1/drive-1")).toBeNull();
    expect(parsePinId("/drive-1/a.md")).toBeNull();
    expect(parsePinId("org-1//a.md")).toBeNull();
    expect(parsePinId("org-1/drive-1/../a.md")).toBeNull();
    expect(parsePinId("org-1/drive-1/a/./b.md")).toBeNull();
    for (const id of [
      "o/d/%2e%2e/x",
      "o/d/.%2e/x",
      "o/d/%2E%2e/settings",
      "o/d/a%2Fb",
      "o/d/a%5Cb",
    ]) {
      expect(parsePinId(id)).toBeNull();
    }
  });

  test("pinLabel", () => {
    expect(pinLabel("/comb-qa/")).toBe("comb-qa/");
    expect(pinLabel("/comb-qa/notes.md")).toBe("notes.md");
    expect(pinLabel("/")).toBe("/");
  });

  test("drivePins keeps one drive, the newest `limit` pins, sorted by label", () => {
    const ids = [
      "org-1/drive-1/z.md",
      "org-1/drive-2/other.md",
      "org-1/drive-1/b/",
      "not-a-pin",
      "org-1/drive-1/docs/a10.md",
      "org-1/drive-1/a2.md",
    ];
    expect(drivePins(ids, IDS).map((pin) => pin.path)).toEqual([
      "/a2.md",
      "/docs/a10.md",
      "/b/",
      "/z.md",
    ]);
    expect(drivePins(ids, IDS, 2).map((pin) => pin.path)).toEqual(["/b/", "/z.md"]);
  });
});
