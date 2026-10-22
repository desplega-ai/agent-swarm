import { describe, expect, test } from "bun:test";
import { applyTemplate, TEMPLATE_MAX_CHARS } from "./apply-template";
import { JSON_PREVIEW_MAX_CHARS } from "./json-preview";

describe("applyTemplate", () => {
  test("replaces each {{field}} with the row value", () => {
    expect(applyTemplate("{{first}} {{last}}", { first: "Ada", last: "Lovelace" })).toBe(
      "Ada Lovelace",
    );
  });

  test("a missing field becomes an empty string", () => {
    expect(applyTemplate("{{name}} ({{status}})", { name: "Alpha" })).toBe("Alpha ()");
  });

  test("a null or undefined row value becomes an empty string", () => {
    expect(applyTemplate("[{{a}}|{{b}}]", { a: null, b: undefined })).toBe("[|]");
  });

  test("text without placeholders is returned unchanged", () => {
    expect(applyTemplate("Plain label", { name: "Alpha" })).toBe("Plain label");
    expect(applyTemplate("", { name: "Alpha" })).toBe("");
  });

  test("whitespace inside the braces is allowed", () => {
    expect(applyTemplate("{{ name }} / {{  status}}", { name: "Alpha", status: "open" })).toBe(
      "Alpha / open",
    );
  });

  test("a repeated placeholder is replaced every time", () => {
    expect(applyTemplate("{{id}}-{{id}}", { id: 7 })).toBe("7-7");
  });

  test("numbers and booleans are stringified", () => {
    expect(
      applyTemplate("v{{version}} · {{active}} · {{zero}}", {
        version: 3,
        active: false,
        zero: 0,
      }),
    ).toBe("v3 · false · 0");
  });

  test("objects and arrays are JSON-encoded", () => {
    expect(applyTemplate("{{meta}} {{tags}}", { meta: { a: 1 }, tags: ["x", "y"] })).toBe(
      '{"a":1} ["x","y"]',
    );
  });

  test("a dotted key reads the literal column name, not a nested path", () => {
    expect(
      applyTemplate("{{owner.name}}", { "owner.name": "flat", owner: { name: "nested" } }),
    ).toBe("flat");
    expect(applyTemplate("{{owner.name}}", { owner: { name: "nested" } })).toBe("");
  });

  test("malformed placeholders are left as-is", () => {
    expect(applyTemplate("{{}} {{a-b}} {name}", { name: "Alpha" })).toBe("{{}} {{a-b}} {name}");
  });

  test("inherited names such as constructor and __proto__ read nothing", () => {
    expect(applyTemplate("[{{constructor}}|{{__proto__}}|{{toString}}]", { name: "Alpha" })).toBe(
      "[||]",
    );
  });

  test("an object substitution is cut to the json preview length", () => {
    const big = { text: "x".repeat(500) };
    const out = applyTemplate("{{big}}", { big });
    expect(out).toBe(`${JSON.stringify(big).slice(0, JSON_PREVIEW_MAX_CHARS)}…`);
  });

  test("the whole result is capped with an ellipsis", () => {
    const out = applyTemplate("{{a}}{{a}}", { a: "y".repeat(400) });
    expect(out).toBe(`${"y".repeat(TEMPLATE_MAX_CHARS)}…`);
    expect(applyTemplate("{{a}}", { a: "z".repeat(TEMPLATE_MAX_CHARS) })).toBe(
      "z".repeat(TEMPLATE_MAX_CHARS),
    );
  });
});
