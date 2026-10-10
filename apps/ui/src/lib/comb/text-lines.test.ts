import { describe, expect, test } from "bun:test";
import { splitTextLines, TEXT_VIEWER_MAX_LINES } from "./text-lines";

function numbered(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");
}

describe("splitTextLines", () => {
  test("LF and CRLF, and a final newline ends the last line", () => {
    expect(splitTextLines("a\r\nb\nc\n")).toEqual({
      shown: ["a", "b", "c"],
      total: 3,
      truncated: false,
    });
    expect(splitTextLines("")).toEqual({ shown: [""], total: 1, truncated: false });
    expect(splitTextLines("a\n\n").shown).toEqual(["a", ""]);
  });

  test("exactly 20,000 lines are all shown", () => {
    const result = splitTextLines(`${numbered(TEXT_VIEWER_MAX_LINES)}\n`);
    expect(TEXT_VIEWER_MAX_LINES).toBe(20_000);
    expect(result.truncated).toBe(false);
    expect(result.shown).toHaveLength(20_000);
  });

  test("longer files show the first 20,000 lines and count all of them", () => {
    const result = splitTextLines(numbered(20_500));
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(20_500);
    expect(result.shown).toHaveLength(20_000);
    expect(result.shown[0]).toBe("line 1");
    expect(result.shown.at(-1)).toBe("line 20000");
  });
});
