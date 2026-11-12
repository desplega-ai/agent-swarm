import { describe, expect, test } from "bun:test";
import {
  isLongPaste,
  LONG_PASTE_CHARS,
  LONG_PASTE_LINES,
  linkOverSelection,
  pastedFileName,
  pastedUrl,
  tsvToMarkdownTable,
} from "./composer-paste";

describe("smart paste", () => {
  test("long by characters or by lines", () => {
    expect(isLongPaste("short")).toBe(false);
    expect(isLongPaste("x".repeat(LONG_PASTE_CHARS + 1))).toBe(true);
    expect(isLongPaste(Array(LONG_PASTE_LINES).fill("l").join("\n"))).toBe(false);
    expect(
      isLongPaste(
        Array(LONG_PASTE_LINES + 1)
          .fill("l")
          .join("\n"),
      ),
    ).toBe(true);
  });

  test("a spreadsheet copy becomes a markdown table", () => {
    expect(tsvToMarkdownTable("name\tcount\r\nfoo\t1\nb|ar\t 2 \n")).toBe(
      ["| name | count |", "| --- | --- |", "| foo | 1 |", "| b\\|ar | 2 |"].join("\n"),
    );
  });

  test("anything else is not a table", () => {
    expect(tsvToMarkdownTable("one line\twith tab")).toBeNull();
    expect(tsvToMarkdownTable("a\tb\nno tab here")).toBeNull();
    expect(tsvToMarkdownTable("a\tb\nc\td\te")).toBeNull();
    expect(tsvToMarkdownTable("plain\ntext")).toBeNull();
  });

  test("a URL over a selection becomes a link", () => {
    expect(pastedUrl(" https://example.com/a?b=1 ")).toBe("https://example.com/a?b=1");
    expect(pastedUrl("see https://example.com")).toBeNull();
    expect(pastedUrl("javascript:alert(1)")).toBeNull();
    expect(linkOverSelection("the [docs]", "https://x.dev/a_(b)")).toBe(
      "[the \\[docs\\]](https://x.dev/a_%28b%29)",
    );
  });

  test("pasted files get the next free name", () => {
    expect(pastedFileName([])).toBe("pasted-1.txt");
    expect(pastedFileName([{ name: "pasted-1.txt" }, { name: "a.pdf" }])).toBe("pasted-2.txt");
  });
});
