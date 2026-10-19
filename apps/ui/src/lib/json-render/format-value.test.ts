import { describe, expect, mock, test } from "bun:test";

mock.module("@/lib/utils", () => require("../utils"));

const { formatValue } = await import("./format-value");

describe("formatValue — json kind", () => {
  test("stringifies objects and arrays on a single line", () => {
    expect(formatValue("json", { a: 1, b: [1, 2], c: { d: null } })).toBe(
      '{"a":1,"b":[1,2],"c":{"d":null}}',
    );
    expect(formatValue("json", ["x", { y: true }])).toBe('["x",{"y":true}]');
  });

  test("renders scalars in their JSON form and null/undefined as empty", () => {
    expect(formatValue("json", "plain")).toBe('"plain"');
    expect(formatValue("json", 42)).toBe("42");
    expect(formatValue("json", false)).toBe("false");
    expect(formatValue("json", null)).toBe("");
    expect(formatValue("json", undefined)).toBe("");
  });

  test("truncates past 120 characters with an ellipsis", () => {
    const value = { text: "x".repeat(200) };
    const serialized = JSON.stringify(value);
    const out = formatValue("json", value);
    expect(serialized.length).toBeGreaterThan(120);
    expect(out).toHaveLength(121);
    expect(out).toBe(`${serialized.slice(0, 120)}…`);
  });

  test("keeps a value of exactly 120 characters intact", () => {
    // `{"s":"` + n + `"}` → n + 8 characters.
    const value = { s: "x".repeat(112) };
    const serialized = JSON.stringify(value);
    expect(serialized).toHaveLength(120);
    expect(formatValue("json", value)).toBe(serialized);
  });
});

describe("formatValue — other kinds are unaffected", () => {
  test("booleans, numbers and text keep their formatting", () => {
    expect(formatValue("boolean", true)).toBe("yes");
    expect(formatValue("boolean", false)).toBe("no");
    expect(formatValue("number", 1234.5)).toBe((1234.5).toLocaleString());
    expect(formatValue("text", "hello")).toBe("hello");
    expect(formatValue(undefined, "hello")).toBe("hello");
  });

  test("objects under a non-json kind are stringified without truncation", () => {
    const value = { text: "x".repeat(200) };
    expect(formatValue("text", value)).toBe(JSON.stringify(value));
    expect(formatValue(undefined, value)).toBe(JSON.stringify(value));
  });
});
