import { describe, expect, test } from "bun:test";
import { CSV_MAX_ROWS, compareCells, delimiterFor, parseDelimited } from "./csv";

describe("parseDelimited", () => {
  test("header and rows", () => {
    expect(parseDelimited("a,b\n1,2\n3,4")).toEqual({
      header: ["a", "b"],
      rows: [
        ["1", "2"],
        ["3", "4"],
      ],
      truncated: false,
    });
  });

  test("a quoted comma stays in one field", () => {
    const table = parseDelimited('name,city\nAda,"London, UK"\n');
    expect(table.rows).toEqual([["Ada", "London, UK"]]);
  });

  test("escaped quotes", () => {
    const table = parseDelimited('q\n"She said ""hi"""\n""\n');
    expect(table.rows).toEqual([['She said "hi"'], [""]]);
  });

  test("line breaks inside quotes", () => {
    const table = parseDelimited('id,note\n1,"line one\nline two"\n2,"a\r\nb"\n');
    expect(table.rows).toEqual([
      ["1", "line one\nline two"],
      ["2", "a\r\nb"],
    ]);
  });

  test("CRLF line ends and a final line break", () => {
    const table = parseDelimited("a,b\r\n1,2\r\n3,4\r\n");
    expect(table.header).toEqual(["a", "b"]);
    expect(table.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  test("TSV with a tab delimiter keeps commas as text", () => {
    const table = parseDelimited("a\tb\n1,5\t2\n", { delimiter: "\t" });
    expect(table).toEqual({ header: ["a", "b"], rows: [["1,5", "2"]], truncated: false });
  });

  test("an empty file", () => {
    expect(parseDelimited("")).toEqual({ header: [], rows: [], truncated: false });
    expect(parseDelimited("\n\r\n")).toEqual({ header: [], rows: [], truncated: false });
  });

  test("ragged rows keep their own length", () => {
    const table = parseDelimited("a,b,c\n1\n1,2,3,4\n");
    expect(table.rows).toEqual([["1"], ["1", "2", "3", "4"]]);
  });

  test("empty fields, empty lines, and a BOM", () => {
    const table = parseDelimited("﻿a,b\n\n,\n1,\n");
    expect(table.header).toEqual(["a", "b"]);
    expect(table.rows).toEqual([
      ["", ""],
      ["1", ""],
    ]);
  });

  test("a quote inside an unquoted field is text", () => {
    expect(parseDelimited('a\n5"2\n').rows).toEqual([['5"2']]);
  });

  test("an unclosed quote runs to the end of the text", () => {
    expect(parseDelimited('a\n"open\nstill').rows).toEqual([["open\nstill"]]);
  });

  test(`stops at ${CSV_MAX_ROWS.toLocaleString()} rows`, () => {
    const lines = ["n", ...Array.from({ length: CSV_MAX_ROWS + 50 }, (_, index) => String(index))];
    const table = parseDelimited(lines.join("\n"));
    expect(table.rows).toHaveLength(CSV_MAX_ROWS);
    expect(table.rows.at(-1)).toEqual([String(CSV_MAX_ROWS - 1)]);
    expect(table.truncated).toBe(true);
  });

  test("exactly the row cap is not truncated", () => {
    const lines = ["n", ...Array.from({ length: CSV_MAX_ROWS }, (_, index) => String(index))];
    const table = parseDelimited(`${lines.join("\n")}\n`);
    expect(table.rows).toHaveLength(CSV_MAX_ROWS);
    expect(table.truncated).toBe(false);
  });

  test("a custom row cap", () => {
    const table = parseDelimited("h\n1\n2\n3\n", { maxRows: 2 });
    expect(table).toEqual({ header: ["h"], rows: [["1"], ["2"]], truncated: true });
  });
});

describe("delimiterFor", () => {
  test("tab for .tsv, comma for other files", () => {
    expect(delimiterFor("/data/report.TSV", "a,b\n")).toBe("\t");
    expect(delimiterFor("/data/notes.txt", "a;b;c\n")).toBe(",");
  });

  test(".csv picks the most frequent delimiter on the header line", () => {
    expect(delimiterFor("/data/report.csv", "a,b,c\n1;2;3;4;5\n")).toBe(",");
    expect(delimiterFor("/data/report.csv", "a\tb\tc\n")).toBe("\t");
    expect(delimiterFor("/data/report.csv", "")).toBe(",");
    expect(delimiterFor("/data/report.csv", "only\n")).toBe(",");
  });

  test("a tie keeps the comma, and quoted delimiters do not count", () => {
    expect(delimiterFor("/data/report.csv", "a,b;c\n")).toBe(",");
    expect(delimiterFor("/data/report.csv", '"a;b;c",d\n')).toBe(",");
  });

  test("a semicolon export (comma decimals) parses into its columns", () => {
    const text = '\uFEFFName;Amount;City\n"Smith, J";1,5;Paris\nLee;-2,25;"Rome; IT"\n';
    const delimiter = delimiterFor("/exports/sales.CSV", text);
    expect(delimiter).toBe(";");
    expect(parseDelimited(text, { delimiter })).toEqual({
      header: ["Name", "Amount", "City"],
      rows: [
        ["Smith, J", "1,5", "Paris"],
        ["Lee", "-2,25", "Rome; IT"],
      ],
      truncated: false,
    });
  });
});

describe("compareCells", () => {
  const sorted = (cells: string[]) => [...cells].sort(compareCells);

  test("decimals sort by value", () => {
    expect(sorted(["1.5", "10", "1.25", "2", "0.75"])).toEqual(["0.75", "1.25", "1.5", "2", "10"]);
  });

  test("negatives sort by value", () => {
    expect(sorted(["-2", "3", "-10", "0", "-2.5"])).toEqual(["-10", "-2.5", "-2", "0", "3"]);
  });

  test("padded numbers compare as numbers", () => {
    expect(compareCells(" 5 ", "10")).toBeLessThan(0);
    expect(compareCells("1e3", "999")).toBeGreaterThan(0);
  });

  test("a mixed column: numbers by value, text by the collator", () => {
    expect(sorted(["n/a", "10", "b10", "", "2.5", "b2", "-1", "abc"])).toEqual([
      "",
      "-1",
      "2.5",
      "10",
      "abc",
      "b2",
      "b10",
      "n/a",
    ]);
  });
});
