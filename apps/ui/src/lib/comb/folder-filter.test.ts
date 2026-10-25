import { describe, expect, test } from "bun:test";
import { matchesName, nestedMatches } from "./folder-filter";

describe("matchesName", () => {
  test("every word, any order, any case", () => {
    expect(matchesName("2026-10-19-Round16-screens", "screens round16")).toBe(true);
    expect(matchesName("2026-10-19-round16-screens", "round17")).toBe(false);
    expect(matchesName("anything", "  ")).toBe(true);
  });
});

describe("nestedMatches", () => {
  test("only files below a subfolder of the folder, with their relative path", () => {
    const hits = [
      { path: "/docs/a.md", size: 1 },
      { path: "/docs/sub/b.md", size: 2, modifiedAt: "2026-10-25T00:00:00Z" },
      { path: "/other/c.md" },
      { path: "/docs/sub/deep/d.md" },
    ];
    expect(nestedMatches(hits, "/docs/")).toEqual([
      { path: "/docs/sub/b.md", relative: "sub/b.md", size: 2, modifiedAt: "2026-10-25T00:00:00Z" },
      {
        path: "/docs/sub/deep/d.md",
        relative: "sub/deep/d.md",
        size: undefined,
        modifiedAt: undefined,
      },
    ]);
    expect(nestedMatches(hits, "/").map((match) => match.path)).toEqual([
      "/docs/a.md",
      "/docs/sub/b.md",
      "/other/c.md",
      "/docs/sub/deep/d.md",
    ]);
  });
});
