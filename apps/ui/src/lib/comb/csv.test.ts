import { describe, expect, test } from "bun:test";
import { CSV_MAX_ROWS, delimiterFor, parseDelimited } from "./csv";

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
  test("tab for .tsv, comma otherwise", () => {
    expect(delimiterFor("/data/report.TSV")).toBe("\t");
    expect(delimiterFor("/data/report.csv")).toBe(",");
  });
});
