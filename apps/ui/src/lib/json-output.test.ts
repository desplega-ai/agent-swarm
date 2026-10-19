import { describe, expect, test } from "bun:test";
import { formatJsonPath, jsonValueToClipboard, parseJsonOutput } from "./json-output";

describe("parseJsonOutput", () => {
  test("parses a JSON object, surrounding whitespace allowed", () => {
    expect(parseJsonOutput('\n  {"verdict":"APPROVE","n":2}\n')).toEqual({
      verdict: "APPROVE",
      n: 2,
    });
  });

  test("parses a JSON array", () => {
    expect(parseJsonOutput('[1, {"a": null}]')).toEqual([1, { a: null }]);
  });

  test("parses a message that is only one fenced json block", () => {
    expect(parseJsonOutput('```json\n{\n  "ok": true\n}\n```')).toEqual({ ok: true });
    expect(parseJsonOutput("  ```JSON\r\n[]\r\n```  ")).toEqual([]);
  });

  test("leaves prose and markdown alone", () => {
    expect(parseJsonOutput("PR opened, CI green.")).toBeNull();
    expect(parseJsonOutput('Here is the result:\n```json\n{"ok":true}\n```')).toBeNull();
    expect(parseJsonOutput('```json\n{"a":1}\n```\n\n```json\n{"b":2}\n```')).toBeNull();
    expect(parseJsonOutput('```ts\n{"a":1}\n```')).toBeNull();
    expect(parseJsonOutput("[link](https://example.com)")).toBeNull();
  });

  test("leaves scalars alone", () => {
    for (const scalar of ["42", '"hello"', "true", "null"]) {
      expect(parseJsonOutput(scalar)).toBeNull();
    }
    expect(parseJsonOutput('```json\n"hello"\n```')).toBeNull();
  });

  test("leaves malformed JSON alone", () => {
    expect(parseJsonOutput('{"a": 1,}')).toBeNull();
    expect(parseJsonOutput('{"a": 1} trailing')).toBeNull();
    expect(parseJsonOutput("```json\n{broken\n```")).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(parseJsonOutput("")).toBeNull();
    expect(parseJsonOutput("   ")).toBeNull();
    expect(parseJsonOutput(null)).toBeNull();
    expect(parseJsonOutput(undefined)).toBeNull();
  });
});

describe("formatJsonPath", () => {
  test("joins identifiers with dots and indexes with brackets", () => {
    expect(formatJsonPath(["items", 0, "name"])).toBe("items[0].name");
    expect(formatJsonPath([2, "id"])).toBe("[2].id");
  });

  test("quotes keys that are not identifiers", () => {
    expect(formatJsonPath(["first name", "x-y", "$ok"])).toBe('["first name"]["x-y"].$ok');
  });
});

describe("jsonValueToClipboard", () => {
  test("copies strings bare and everything else as indented JSON", () => {
    expect(jsonValueToClipboard("hi")).toBe("hi");
    expect(jsonValueToClipboard(3)).toBe("3");
    expect(jsonValueToClipboard(null)).toBe("null");
    expect(jsonValueToClipboard({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}');
  });
});
