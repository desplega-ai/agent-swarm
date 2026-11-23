import { describe, expect, test } from "bun:test";
import { toCodexOutputSchema } from "../providers/codex-output-schema";

describe("toCodexOutputSchema", () => {
  test("closes every object and makes optional properties nullable", () => {
    expect(
      toCodexOutputSchema({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: ["findings"],
        properties: {
          findings: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["file"],
              properties: {
                file: { type: "string", description: "path" },
                severity: { type: "string", enum: ["nit", "bug"] },
              },
            },
          },
        },
      }),
    ).toEqual({
      type: "object",
      required: ["findings"],
      additionalProperties: false,
      properties: {
        findings: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["file", "severity"],
            additionalProperties: false,
            properties: {
              file: { type: "string", description: "path" },
              severity: { anyOf: [{ type: "string", enum: ["nit", "bug"] }, { type: "null" }] },
            },
          },
        },
      },
    });
  });

  test.each([
    ["an open object", { type: "object", properties: { meta: { type: "object" } } }],
    ["an array without items", { type: "object", properties: { list: { type: "array" } } }],
    ["additionalProperties: true", { type: "object", properties: {}, additionalProperties: true }],
    ["oneOf", { type: "object", properties: { v: { oneOf: [{ type: "string" }] } } }],
    ["a property with no type", { type: "object", properties: { v: {} } }],
    ["a required name with no property", { type: "object", required: ["v"], properties: {} }],
    ["a non-object root", { type: "array", items: { type: "string" } }],
  ])("returns undefined for %s", (_, schema) => {
    expect(toCodexOutputSchema(schema)).toBeUndefined();
  });
});
