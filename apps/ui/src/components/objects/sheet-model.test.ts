import { describe, expect, test } from "bun:test";
import {
  colName,
  defaultWindow,
  displayOf,
  inputOf,
  parseInput,
  parseRange,
  parseTsv,
  qualify,
} from "./sheet-model";

describe("sheet-model", () => {
  test("column names", () => {
    expect([1, 26, 27, 52, 703].map(colName)).toEqual(["A", "Z", "AA", "AZ", "AAA"]);
  });

  test("ranges, with and without a tab", () => {
    expect(parseRange("B2:D10")).toEqual({ window: { r1: 2, c1: 2, r2: 10, c2: 4 } });
    expect(parseRange("Tasks!D10:B2")).toEqual({
      tab: "Tasks",
      window: { r1: 2, c1: 2, r2: 10, c2: 4 },
    });
    expect(parseRange("'It''s'!A1")?.tab).toBe("It's");
    expect(parseRange("nonsense")).toBeNull();
    expect(qualify("It's", "B2")).toBe("'It''s'!B2");
  });

  test("the window covers used cells plus room to type", () => {
    expect(defaultWindow({ name: "S", cells: {} })).toEqual({ r1: 1, c1: 1, r2: 20, c2: 8 });
    expect(defaultWindow({ name: "S", cells: { J30: { v: 1 } } })).toEqual({
      r1: 1,
      c1: 1,
      r2: 40,
      c2: 12,
    });
  });

  test("typed text becomes the value the server expects", () => {
    expect(parseInput("")).toBeNull();
    expect(parseInput("42")).toBe(42);
    expect(parseInput("-1.5e3")).toBe(-1500);
    expect(parseInput("true")).toBe(true);
    expect(parseInput("=B2*2")).toBe("=B2*2");
    expect(parseInput("'007")).toBe("007");
    expect(parseInput("'=not a formula")).toBe("'=not a formula");
    expect(parseInput("hello")).toBe("hello");
  });

  test("the editor text round-trips through parseInput", () => {
    for (const v of ["007", "=x", "'quoted", "TRUE", "plain", 12, false]) {
      const back = parseInput(inputOf({ v }));
      // '= stays escaped for the server, which stores it as the text "=x".
      expect(back).toEqual(v === "=x" ? "'=x" : v);
    }
    expect(inputOf({ v: 4, f: "=B2*2" })).toBe("=B2*2");
    expect(displayOf({ v: 4, f: "=B2*2" })).toBe("4");
    expect(displayOf({ v: 0.5, t: "50%" })).toBe("50%");
  });

  test("TSV paste is a padded rectangle", () => {
    expect(parseTsv("1\t2\nx\n")).toEqual([
      [1, 2],
      ["x", null],
    ]);
    expect(parseTsv("")).toEqual([]);
  });
});
