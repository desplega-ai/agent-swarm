import { describe, expect, test } from "bun:test";
import { parseNumberInputValue } from "./number-input-value";

describe("parseNumberInputValue", () => {
  test("a numeric string commits the parsed number", () => {
    expect(parseNumberInputValue("42")).toBe(42);
    expect(parseNumberInputValue(" 7 ")).toBe(7);
    expect(parseNumberInputValue("-3.5")).toBe(-3.5);
    expect(parseNumberInputValue("1e3")).toBe(1000);
  });

  test("an empty or whitespace-only string commits null", () => {
    expect(parseNumberInputValue("")).toBeNull();
    expect(parseNumberInputValue("   ")).toBeNull();
  });

  test("a non-numeric in-progress edit (e.g. a bare '-') commits nothing", () => {
    expect(parseNumberInputValue("-")).toBeUndefined();
    expect(parseNumberInputValue("abc")).toBeUndefined();
    expect(parseNumberInputValue("1.2.3")).toBeUndefined();
    expect(parseNumberInputValue("Infinity")).toBeUndefined();
  });

  test("min and max clamp the committed number", () => {
    expect(parseNumberInputValue("0", 1, 10)).toBe(1);
    expect(parseNumberInputValue("99", 1, 10)).toBe(10);
    expect(parseNumberInputValue("5", 1, 10)).toBe(5);
    expect(parseNumberInputValue("-5", undefined, 10)).toBe(-5);
    expect(parseNumberInputValue("", 1, 10)).toBeNull();
  });

  test("the blur snap shows the clamped number and leaves other text alone", () => {
    // NumberInput's onBlur: `String(parsed)` when a number comes back, else keep the text.
    const snap = (text: string) => {
      const settled = parseNumberInputValue(text, 1, 10);
      return typeof settled === "number" ? String(settled) : text;
    };
    expect(snap(" 99 ")).toBe("10");
    expect(snap("007")).toBe("7");
    expect(snap("")).toBe("");
    expect(snap("-")).toBe("-");
  });
});
