import { describe, expect, test } from "bun:test";
import { formatDebugCell } from "./format-cell";

describe("formatDebugCell", () => {
  test("JSON-stringifies objects and arrays (AG Grid warning #48)", () => {
    expect(formatDebugCell({ value: { a: 1 } })).toBe('{"a":1}');
    expect(formatDebugCell({ value: [1, 2] })).toBe("[1,2]");
  });

  test("renders primitives and null as text", () => {
    expect(formatDebugCell({ value: null })).toBe("");
    expect(formatDebugCell({ value: undefined })).toBe("");
    expect(formatDebugCell({ value: 42 })).toBe("42");
    expect(formatDebugCell({ value: "x" })).toBe("x");
  });
});
