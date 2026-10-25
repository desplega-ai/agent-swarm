import { describe, expect, test } from "bun:test";
import { readLines, splitFrontmatter, toValue } from "./frontmatter";

const asText = (value: string) => ({ kind: "text", text: value });

describe("splitFrontmatter", () => {
  test("no frontmatter leaves the text untouched", () => {
    const text = "# Title\n\nBody.";
    expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text });
  });

  test("an empty block is stripped and has no entries", () => {
    const { frontmatter, body } = splitFrontmatter("---\n---\nBody.");
    expect(frontmatter).toEqual({ raw: "", entries: [], error: null, lenient: false });
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
      { key: "date", value: asText("2026-10-14") },
      { key: "author", value: asText("Researcher") },
      {
        key: "builds_on",
        value: { kind: "list", items: ["thoughts/a/research/one.md", "thoughts/b/plans/two.md"] },
      },
      { key: "status", value: asText("complete") },
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
    expect(frontmatter?.entries).toEqual([{ key: "a", value: asText("1") }]);
    expect(body).toBe("\n\n\nText\n\n---\n\nMore");
  });

  test("an unclosed fence is not frontmatter", () => {
    const text = "---\ntitle: Notes\n\nBody.";
    expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text });
  });

  test("YAML that does not parse is read line by line, never throws", () => {
    const { frontmatter, body } = splitFrontmatter("---\ntitle: [unclosed\n  bad: : x\n---\nBody.");
    expect(frontmatter?.lenient).toBe(true);
    expect(frontmatter?.error).toBeTruthy();
    expect(frontmatter?.entries).toEqual([{ key: "title", value: asText("[unclosed bad: : x") }]);
    expect(frontmatter?.raw).toBe("title: [unclosed\n  bad: : x");
    expect(body).toBe("\n\n\n\nBody.");
  });

  test("a value with ': ' in it stays one string (the seed deck research file)", () => {
    const raw = [
      "date: 2026-10-14",
      "researcher: Researcher (16990304)",
      "requester: Taras",
      "topic: Seed deck ($5M raise): companies using Agent Swarm, and competitors",
      "as_of: 2026-10-14 01:10 Europe/Madrid (telemetry snapshot)",
      "status: v3 (complete)",
    ].join("\n");
    const { frontmatter } = splitFrontmatter(`---\n${raw}\n---\n# Body`);
    expect(frontmatter?.lenient).toBe(true);
    expect(frontmatter?.error).toContain("Nested mappings");
    expect(frontmatter?.entries?.map((entry) => entry.key)).toEqual([
      "date",
      "researcher",
      "requester",
      "topic",
      "as_of",
      "status",
    ]);
    expect(frontmatter?.entries?.[3]?.value).toEqual(
      asText("Seed deck ($5M raise): companies using Agent Swarm, and competitors"),
    );
  });

  test("text with no key at all keeps the raw block", () => {
    const { frontmatter } = splitFrontmatter("---\n: : [\n---\n");
    expect(frontmatter?.entries).toBeNull();
    expect(frontmatter?.lenient).toBe(false);
    expect(frontmatter?.error).toBeTruthy();
  });

  test("YAML that is not a mapping falls back to the raw block", () => {
    const { frontmatter } = splitFrontmatter("---\n- a\n- b\n---\n");
    expect(frontmatter?.entries).toBeNull();
    expect(frontmatter?.error).toBe("Frontmatter is not a key/value mapping");
  });

  test("CRLF line endings and a BOM are accepted", () => {
    const { frontmatter, body } = splitFrontmatter("\uFEFF---\r\ntitle: Notes\r\n---\r\nBody.");
    expect(frontmatter?.entries).toEqual([{ key: "title", value: asText("Notes") }]);
    expect(body).toBe("\n\n\nBody.");
  });
});

describe("toValue", () => {
  test("scalars are text, scalar lists are chips, nested values are a YAML block", () => {
    expect(toValue(true)).toEqual(asText("true"));
    expect(toValue(null)).toEqual(asText(""));
    expect(toValue(["a", 2, null])).toEqual({ kind: "list", items: ["a", "2", ""] });
    expect(toValue({ a: 1, b: [1, 2] })).toEqual({ kind: "block", text: "a: 1\nb:\n  - 1\n  - 2" });
    expect(toValue([{ a: 1 }])).toEqual({ kind: "block", text: "- a: 1" });
  });
});

describe("readLines", () => {
  test("lists, quotes, folded lines and nested blocks", () => {
    const raw = [
      "# a comment",
      "tags:",
      "  - one",
      '  - "two"',
      "inline: ['a', b]",
      "title: 'Quoted: yes'",
      "summary: first part",
      "  second part",
      "owner:",
      "  name: Taras",
      "  team: core",
      "empty:",
    ].join("\n");
    expect(readLines(raw)).toEqual([
      { key: "tags", value: { kind: "list", items: ["one", "two"] } },
      { key: "inline", value: { kind: "list", items: ["a", "b"] } },
      { key: "title", value: asText("Quoted: yes") },
      { key: "summary", value: asText("first part second part") },
      { key: "owner", value: { kind: "block", text: "name: Taras\nteam: core" } },
      { key: "empty", value: asText("") },
    ]);
  });
});
