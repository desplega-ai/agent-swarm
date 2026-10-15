import { describe, expect, test } from "bun:test";
import { formatValue, splitFrontmatter } from "./frontmatter";

describe("splitFrontmatter", () => {
  test("no frontmatter leaves the text untouched", () => {
    const text = "# Title\n\nBody.";
    expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text });
  });

  test("an empty block is stripped and has no entries", () => {
    const { frontmatter, body } = splitFrontmatter("---\n---\nBody.");
    expect(frontmatter).toEqual({ raw: "", entries: [], error: null });
    expect(body).toBe("\n\nBody.");
  });

  test("a mapping parses into entries and keeps the body's line numbers", () => {
    const text = [
      "---",
      "date: 2026-10-14",
      "author: Researcher",
      "builds_on: [thoughts/a/research/one.md, thoughts/b/plans/two.md]",
      "status: complete",
      "---",
      "# Title",
    ].join("\n");
    const { frontmatter, body } = splitFrontmatter(text);
    expect(frontmatter?.error).toBeNull();
    expect(frontmatter?.entries).toEqual([
      { key: "date", value: "2026-10-14" },
      { key: "author", value: "Researcher" },
      { key: "builds_on", value: "thoughts/a/research/one.md, thoughts/b/plans/two.md" },
      { key: "status", value: "complete" },
    ]);
    const lines = body.split("\n");
    expect(lines).toHaveLength(7);
    expect(lines.slice(0, 6).every((line) => line === "")).toBe(true);
    expect(lines[6]).toBe("# Title");
  });

  test("a later --- stays in the body as a rule", () => {
    const text = "# Title\n\n---\n\nkey: value\n---\n";
    expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text });
  });

  test("only the first closing fence ends the block", () => {
    const { frontmatter, body } = splitFrontmatter("---\na: 1\n---\nText\n\n---\n\nMore");
    expect(frontmatter?.entries).toEqual([{ key: "a", value: "1" }]);
    expect(body).toBe("\n\n\nText\n\n---\n\nMore");
  });

  test("an unclosed fence is not frontmatter", () => {
    const text = "---\ntitle: Notes\n\nBody.";
    expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text });
  });

  test("malformed YAML keeps the raw block and an error, never throws", () => {
    const { frontmatter, body } = splitFrontmatter("---\ntitle: [unclosed\n  bad: : x\n---\nBody.");
    expect(frontmatter?.entries).toBeNull();
    expect(frontmatter?.raw).toBe("title: [unclosed\n  bad: : x");
    expect(frontmatter?.error).toBeTruthy();
    expect(body).toBe("\n\n\n\nBody.");
  });

  test("YAML that is not a mapping falls back to the raw block", () => {
    const { frontmatter } = splitFrontmatter("---\n- a\n- b\n---\n");
    expect(frontmatter?.entries).toBeNull();
    expect(frontmatter?.error).toBe("Frontmatter is not a key/value mapping");
  });

  test("CRLF line endings and a BOM are accepted", () => {
    const { frontmatter, body } = splitFrontmatter("\uFEFF---\r\ntitle: Notes\r\n---\r\nBody.");
    expect(frontmatter?.entries).toEqual([{ key: "title", value: "Notes" }]);
    expect(body).toBe("\n\n\nBody.");
  });
});

describe("formatValue", () => {
  test("nested values render as JSON", () => {
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
    expect(formatValue([{ a: 1 }])).toBe('[{"a":1}]');
    expect(formatValue(true)).toBe("true");
    expect(formatValue(null)).toBe("");
  });
});
