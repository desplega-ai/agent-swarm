import { describe, expect, test } from "bun:test";
import { DESCRIPTION_CELL_CLASS, formatDescription } from "./description-cell";

describe("description cell", () => {
  test("lets the AG Grid cell wrapper shrink so long text ellipsizes on one line", () => {
    expect(DESCRIPTION_CELL_CLASS).toContain("[&>.ag-cell-wrapper]:min-w-0");
    expect(DESCRIPTION_CELL_CLASS).toContain("[&_.ag-cell-value]:block!");
  });

  test("shows a dash for a missing description", () => {
    expect(formatDescription({ value: null })).toBe("—");
    expect(formatDescription({ value: "" })).toBe("—");
    expect(formatDescription({ value: "Hello" })).toBe("Hello");
  });
});
