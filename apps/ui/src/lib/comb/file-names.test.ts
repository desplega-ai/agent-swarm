import { describe, expect, test } from "bun:test";
import { joinComb, normalizeRelativePath, renameValue, starterContent } from "./file-names";

describe("normalizeRelativePath", () => {
  test("cleans slashes, spaces and backslashes", () => {
    expect(normalizeRelativePath(" sub//dir\\ name.md ")).toEqual({ path: "sub/dir/name.md" });
  });

  test("an empty name or a dot segment is an error", () => {
    expect(normalizeRelativePath("  / ")).toEqual({ error: "Enter a name." });
    expect(normalizeRelativePath("a/../b")).toEqual({
      error: "Paths cannot contain . or .. segments.",
    });
    expect(normalizeRelativePath("./a")).toHaveProperty("error");
  });
});

describe("paths", () => {
  test("joinComb puts a relative path inside a folder", () => {
    expect(joinComb("/docs/", "a/b.md")).toBe("/docs/a/b.md");
    expect(joinComb("/", "a.md")).toBe("/a.md");
  });

  test("starterContent gives markdown a heading", () => {
    expect(starterContent("/docs/todo list.md")).toBe("# todo list\n");
    expect(starterContent("/notes.MDX")).toBe("# notes\n");
    expect(starterContent("/data.json")).toBe("");
  });

  test("renameValue drops the leading slash", () => {
    expect(renameValue("/docs/a.md")).toBe("docs/a.md");
  });
});
