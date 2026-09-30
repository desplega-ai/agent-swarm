import { describe, expect, test } from "bun:test";
import {
  ancestorFolders,
  baseName,
  childPath,
  combPath,
  parentFolder,
  parseCombSplat,
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

  test("dot segments are dropped", () => {
    expect(parseCombSplat({ ...IDS, splat: "../../x" }).path).toBe("/x");
    expect(parseCombSplat({ ...IDS, splat: "a/./../b.md" }).path).toBe("/a/b.md");
    expect(parseCombSplat({ ...IDS, splat: "../" })).toEqual({ ...IDS, path: "/", isFolder: true });
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

  test("encodes each segment once, a literal % included", () => {
    expect(combPath({ ...IDS, path: "/my docs/a b#1?.md" })).toBe(
      "/file/~/org-1/drive-1/my%20docs/a%20b%231%3F.md",
    );
    expect(combPath({ ...IDS, path: "/a%20b/100%.md" })).toBe(
      "/file/~/org-1/drive-1/a%2520b/100%25.md",
    );
  });

  test("round-trips through a decoded splat", () => {
    for (const path of ["/my docs/notes (v2).md", "/a%20b.md", "/q/100%.md"]) {
      const url = combPath({ ...IDS, path });
      const splat = decodeURIComponent(url.slice("/file/~/org-1/drive-1/".length));
      expect(parseCombSplat({ ...IDS, splat }).path).toBe(path);
    }
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

  test("escaped dot segments and separators never leave the drive", () => {
    expect(resolveRelative(from, "%2e%2e/%2e%2e/%2e%2e/settings")).toBeNull();
    expect(resolveRelative(from, "%2E%2E/x.md")).toBeNull();
    expect(resolveRelative(from, ".%2e/x.md")).toBeNull();
    expect(resolveRelative(from, "%2e/x.md")).toBeNull();
    expect(resolveRelative(from, "..%2F..%2Fx")).toBeNull();
    expect(resolveRelative(from, "a%2Fb.md")).toBeNull();
    expect(resolveRelative(from, "..%5C..%5Cx")).toBeNull();
    expect(resolveRelative(from, "..\\..\\x")).toBeNull();
  });

  test("every resolved path stays a drive path with no dot segments", () => {
    for (const href of ["./b.md", "../x/c.md", "../../../../../../settings", "a/../../b/./c.md"]) {
      const target = resolveRelative(from, href);
      expect(target).not.toBeNull();
      expect(target?.path.startsWith("/")).toBe(true);
      expect(target?.path.split("/")).not.toContain("..");
      expect(target?.path.split("/")).not.toContain(".");
    }
    expect(resolveRelative(from, "a/../../b/./c.md")?.path).toBe("/docs/b/c.md");
  });

  test("anchors and absolute URLs stay untouched", () => {
    expect(resolveRelative(from, "#anchor")).toBeNull();
    expect(resolveRelative(from, "https://example.com/a.md")).toBeNull();
    expect(resolveRelative(from, "mailto:a@b.c")).toBeNull();
    expect(resolveRelative(from, "//cdn.example.com/x.js")).toBeNull();
    expect(resolveRelative(from, "")).toBeNull();
  });
});
