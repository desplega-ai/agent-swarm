import { describe, expect, test } from "bun:test";
import {
  CARD_GRID_PAGE_SIZE,
  CARD_TITLE_MAX_CHARS,
  cardGridCapText,
  cardGridFieldKind,
  cardGridRowKey,
  cardGridTitleText,
  cardGridVisibleRows,
  safeHttpUrl,
} from "./card-grid-model";
import { JSON_PREVIEW_MAX_CHARS } from "./json-preview";

describe("safeHttpUrl", () => {
  test("accepts absolute http and https URLs", () => {
    expect(safeHttpUrl("https://example.com/a.png")).toBe("https://example.com/a.png");
    expect(safeHttpUrl("http://example.com/a.png?x=1")).toBe("http://example.com/a.png?x=1");
  });

  test("rejects script, data, relative and protocol-relative URLs", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("JavaScript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(safeHttpUrl("/images/a.png")).toBeNull();
    expect(safeHttpUrl("images/a.png")).toBeNull();
    expect(safeHttpUrl("//evil.example/a.png")).toBeNull();
    expect(safeHttpUrl("ftp://example.com/a.png")).toBeNull();
  });

  test("rejects non-strings and empty values", () => {
    expect(safeHttpUrl("")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
    expect(safeHttpUrl(42)).toBeNull();
    expect(safeHttpUrl({ href: "https://example.com" })).toBeNull();
  });
});

describe("cardGridRowKey", () => {
  test("combines the position with the row id", () => {
    expect(cardGridRowKey({ id: "a" }, 0)).toBe("0:a");
    expect(cardGridRowKey({ id: 7 }, 3)).toBe("3:7");
  });

  test("duplicate or missing ids still give unique keys", () => {
    expect(cardGridRowKey({ id: "dup" }, 0)).not.toBe(cardGridRowKey({ id: "dup" }, 1));
    expect(cardGridRowKey({}, 2)).toBe("2:");
    expect(cardGridRowKey({ id: null }, 4)).toBe("4:");
  });
});

describe("cardGridTitleText", () => {
  test("empty values render a dash", () => {
    expect(cardGridTitleText(undefined)).toBe("—");
    expect(cardGridTitleText(null)).toBe("—");
    expect(cardGridTitleText("")).toBe("—");
  });

  test("scalars are stringified", () => {
    expect(cardGridTitleText("Alpha")).toBe("Alpha");
    expect(cardGridTitleText(0)).toBe("0");
    expect(cardGridTitleText(false)).toBe("false");
  });

  test("objects and arrays render a bounded JSON preview", () => {
    expect(cardGridTitleText({ a: 1 })).toBe('{"a":1}');
    expect(cardGridTitleText(["x"])).toBe('["x"]');
    const big = { text: "x".repeat(500) };
    expect(cardGridTitleText(big)).toBe(`${JSON.stringify(big).slice(0, JSON_PREVIEW_MAX_CHARS)}…`);
  });

  test("long titles are capped with an ellipsis", () => {
    expect(cardGridTitleText("t".repeat(CARD_TITLE_MAX_CHARS + 10))).toBe(
      `${"t".repeat(CARD_TITLE_MAX_CHARS)}…`,
    );
  });
});

describe("cardGridFieldKind", () => {
  test("a declared kind wins", () => {
    expect(cardGridFieldKind("date", { a: 1 })).toBe("date");
  });

  test("an object or array without a kind renders as json", () => {
    expect(cardGridFieldKind(undefined, { a: 1 })).toBe("json");
    expect(cardGridFieldKind(undefined, [1])).toBe("json");
    expect(cardGridFieldKind(undefined, null)).toBeUndefined();
    expect(cardGridFieldKind(undefined, "text")).toBeUndefined();
  });
});

describe("cardGridVisibleRows", () => {
  const rows = Array.from({ length: 450 }, (_, index) => ({ id: index }));

  test("shows one page and counts the rest", () => {
    const { visible, remaining } = cardGridVisibleRows(rows, CARD_GRID_PAGE_SIZE);
    expect(visible).toHaveLength(200);
    expect(remaining).toBe(250);
  });

  test("a raised limit shows more, never past the end", () => {
    expect(cardGridVisibleRows(rows, 400).remaining).toBe(50);
    const all = cardGridVisibleRows(rows, 600);
    expect(all.visible).toHaveLength(450);
    expect(all.remaining).toBe(0);
  });

  test("fewer rows than a page shows them all", () => {
    expect(cardGridVisibleRows(rows.slice(0, 3), CARD_GRID_PAGE_SIZE)).toEqual({
      visible: rows.slice(0, 3),
      remaining: 0,
    });
  });
});

describe("cardGridCapText", () => {
  test("short text is unchanged", () => {
    expect(cardGridCapText("active")).toBe("active");
  });

  test("long text is cut at CARD_TITLE_MAX_CHARS with an ellipsis", () => {
    const capped = cardGridCapText("x".repeat(CARD_TITLE_MAX_CHARS + 50));
    expect(capped).toBe(`${"x".repeat(CARD_TITLE_MAX_CHARS)}…`);
  });
});
