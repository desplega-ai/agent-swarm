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
  SIDEBAR_PIN_PREVIEW,
  sidebarPins,
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

  test("pinLabel drops a folder's trailing slash", () => {
    expect(pinLabel("/comb-qa/")).toBe("comb-qa");
    expect(pinLabel("/docs/specs/2026/")).toBe("2026");
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

  describe("sidebarPins", () => {
    // Newest first, as GET /api/favorites lists them.
    const pinIds = (count: number) =>
      Array.from({ length: count }, (_, i) => `org-1/drive-1/p${count - i}.md`);
    const paths = (result: ReturnType<typeof sidebarPins>) => result.pins.map((pin) => pin.path);

    test("lists every pin while folding would hide one pin at most", () => {
      for (const count of [0, 1, SIDEBAR_PIN_PREVIEW, SIDEBAR_PIN_PREVIEW + 1]) {
        const result = sidebarPins(pinIds(count), IDS, false);
        expect(result.pins).toHaveLength(count);
        expect(result.total).toBe(count);
        expect(result.foldable).toBe(false);
      }
    });

    test("folded, lists the newest pins sorted by label", () => {
      const result = sidebarPins(pinIds(12), IDS, false);
      expect(paths(result)).toEqual(["/p8.md", "/p9.md", "/p10.md", "/p11.md", "/p12.md"]);
      expect(result.total).toBe(12);
      expect(result.foldable).toBe(true);
    });

    test("with showAll, lists every pin sorted by label", () => {
      const result = sidebarPins(pinIds(7), IDS, true);
      expect(paths(result)).toEqual([
        "/p1.md",
        "/p2.md",
        "/p3.md",
        "/p4.md",
        "/p5.md",
        "/p6.md",
        "/p7.md",
      ]);
      expect(result.total).toBe(7);
      expect(result.foldable).toBe(true);
    });

    test("counts only the pins of the drive", () => {
      const ids = [...pinIds(6), "org-1/drive-2/a.md", "org-1/drive-2/b.md", "not-a-pin"];
      const result = sidebarPins(ids, IDS, false);
      expect(result.total).toBe(6);
      expect(result.foldable).toBe(false);
    });
  });
});
