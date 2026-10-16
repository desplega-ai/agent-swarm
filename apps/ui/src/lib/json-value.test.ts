import { describe, expect, test } from "bun:test";
import { compactJson, parseJsonContainer, prettyJson } from "./json-value";

describe("json-value", () => {
  test("detects objects and arrays only", () => {
    expect(parseJsonContainer('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonContainer(" [1, 2] ")).toEqual([1, 2]);
    expect(parseJsonContainer("123")).toBeUndefined();
    expect(parseJsonContainer('"text"')).toBeUndefined();
    expect(parseJsonContainer("{not json")).toBeUndefined();
    expect(parseJsonContainer("xoxb-token")).toBeUndefined();
  });

  test("pretty and compact round-trip; other text passes through", () => {
    const compact = '{"a":{"b":[1,2]},"c":"d"}';
    const pretty = prettyJson(compact);
    expect(pretty).toContain("\n  ");
    expect(compactJson(pretty)).toBe(compact);
    expect(prettyJson("plain")).toBe("plain");
    expect(compactJson("plain")).toBe("plain");
  });
});
