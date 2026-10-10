import { describe, expect, test } from "bun:test";
import { activeHeadingIndex, extractOutline, hasOutline, plainHeadingText } from "./outline";

const lines = (...rows: string[]) => rows.join("\n");

describe("extractOutline", () => {
  test("ATX headings h1 to h4 with their source lines", () => {
    const doc = lines(
      "# Title",
      "",
      "Intro.",
      "",
      "## Goals",
      "### Detail",
      "#### Deep",
      "##### Too deep",
    );
    expect(extractOutline(doc)).toEqual([
      { level: 1, text: "Title", line: 1 },
      { level: 2, text: "Goals", line: 5 },
      { level: 3, text: "Detail", line: 6 },
      { level: 4, text: "Deep", line: 7 },
    ]);
  });

  test("ATX closing hashes, indentation, and non-headings", () => {
    const doc = lines(
      "  ## Plan ##",
      "#NoSpace",
      "    # indented code",
      "# C#",
      "#",
      "## \\#1 pick",
    );
    expect(extractOutline(doc)).toEqual([
      { level: 2, text: "Plan", line: 1 },
      { level: 1, text: "C#", line: 4 },
      { level: 2, text: "#1 pick", line: 6 },
    ]);
  });

  test("setext headings take the line of their first text line", () => {
    const doc = lines("Big title", "=========", "", "Two line", "section", "---", "", "Text");
    expect(extractOutline(doc)).toEqual([
      { level: 1, text: "Big title", line: 1 },
      { level: 2, text: "Two line section", line: 4 },
    ]);
  });

  test("a rule after a blank line, a list, or a quote is not a setext underline", () => {
    const doc = lines(
      "Para",
      "",
      "---",
      "Intro:",
      "- one",
      "- two",
      "---",
      "> quoted",
      "---",
      "* * *",
    );
    expect(extractOutline(doc)).toEqual([]);
  });

  test("headings inside fenced code blocks are skipped", () => {
    const doc = lines(
      "# Real",
      "```md",
      "# not a heading",
      "Setext in code",
      "---",
      "```",
      "~~~~",
      "## still code",
      "~~~",
      "## still code (a shorter fence does not close)",
      "~~~~",
      "## After",
    );
    expect(extractOutline(doc)).toEqual([
      { level: 1, text: "Real", line: 1 },
      { level: 2, text: "After", line: 12 },
    ]);
  });

  test("an unclosed fence runs to the end", () => {
    expect(extractOutline(lines("# A", "```", "# B"))).toEqual([{ level: 1, text: "A", line: 1 }]);
  });

  test("a backtick fence info string cannot hold a backtick", () => {
    // "``` a`b" is an inline code span, not a fence, so "# Next" is a heading.
    expect(extractOutline(lines("``` a`b", "# Next"))).toEqual([
      { level: 1, text: "Next", line: 2 },
    ]);
  });

  test("CRLF line endings count lines the same way", () => {
    expect(extractOutline("# A\r\n\r\n## B")).toEqual([
      { level: 1, text: "A", line: 1 },
      { level: 2, text: "B", line: 3 },
    ]);
  });

  test("a heading ends a paragraph, and a setext heading can follow a heading", () => {
    const doc = lines("Text", "# Heading", "Next", "===");
    expect(extractOutline(doc)).toEqual([
      { level: 1, text: "Heading", line: 2 },
      { level: 1, text: "Next", line: 3 },
    ]);
  });
});

describe("plainHeadingText", () => {
  test("drops inline markdown and keeps the words", () => {
    expect(plainHeadingText("The **bold** and *em* and _under_ part")).toBe(
      "The bold and em and under part",
    );
    expect(plainHeadingText("See [the docs](./docs.md) and ![logo](a.png)")).toBe(
      "See the docs and logo",
    );
    expect(plainHeadingText("Use `__init__` and ~~old~~ <b>new</b>")).toBe(
      "Use __init__ and old new",
    );
    expect(plainHeadingText("snake_case_name stays")).toBe("snake_case_name stays");
    expect(plainHeadingText("Q&amp;A \\*literal\\*")).toBe("Q&A *literal*");
  });
});

describe("hasOutline", () => {
  test("needs at least two headings", () => {
    expect(hasOutline([])).toBe(false);
    expect(hasOutline(extractOutline("# One"))).toBe(false);
    expect(hasOutline(extractOutline("# One\n## Two"))).toBe(true);
  });
});

describe("activeHeadingIndex", () => {
  const options = { threshold: 100, height: 600, atEnd: false };

  test("the last heading at or above the threshold", () => {
    expect(activeHeadingIndex([-400, -20, 90, 300], options)).toBe(2);
    expect(activeHeadingIndex([-400, 150, 300], options)).toBe(0);
  });

  test("before the first heading, the first heading is active", () => {
    expect(activeHeadingIndex([200, 500], options)).toBe(0);
  });

  test("headings missing from the page are skipped", () => {
    expect(activeHeadingIndex([null, 250, null], options)).toBe(1);
    expect(activeHeadingIndex([null, null], options)).toBe(-1);
  });

  test("at the end of the pane, the last heading that shows", () => {
    expect(activeHeadingIndex([-400, 250, 500, 700], { ...options, atEnd: true })).toBe(2);
  });
});
