import { describe, expect, jest, test } from "bun:test";
import { executePropertyMatch, type PropertyMatchConfig } from "../workflows/nodes/property-match";

function match(config: PropertyMatchConfig, ctx: Record<string, unknown>): boolean {
  const result = executePropertyMatch(config, ctx);
  return result.nextPort === "true";
}

describe("executePropertyMatch()", () => {
  // ---------------------------------------------------------------------------
  // Operator: eq
  // ---------------------------------------------------------------------------
  describe("op: eq", () => {
    test("matches equal values", () => {
      expect(match({ conditions: [{ field: "a", op: "eq", value: "x" }] }, { a: "x" })).toBe(true);
    });

    test("rejects non-equal values", () => {
      expect(match({ conditions: [{ field: "a", op: "eq", value: "x" }] }, { a: "y" })).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Operator: neq
  // ---------------------------------------------------------------------------
  describe("op: neq", () => {
    test("matches when values differ", () => {
      expect(match({ conditions: [{ field: "a", op: "neq", value: "x" }] }, { a: "y" })).toBe(true);
    });

    test("rejects when values are equal", () => {
      expect(match({ conditions: [{ field: "a", op: "neq", value: "x" }] }, { a: "x" })).toBe(
        false,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Operator: contains
  // ---------------------------------------------------------------------------
  describe("op: contains", () => {
    test("matches when array contains value", () => {
      expect(
        match(
          { conditions: [{ field: "tags", op: "contains", value: "bug" }] },
          { tags: ["bug", "ui"] },
        ),
      ).toBe(true);
    });

    test("rejects when array does not contain value", () => {
      expect(
        match(
          { conditions: [{ field: "tags", op: "contains", value: "bug" }] },
          { tags: ["feature"] },
        ),
      ).toBe(false);
    });

    test("matches when string contains substring", () => {
      expect(
        match(
          { conditions: [{ field: "name", op: "contains", value: "world" }] },
          { name: "hello world" },
        ),
      ).toBe(true);
    });

    test("rejects when string does not contain substring", () => {
      expect(
        match(
          { conditions: [{ field: "name", op: "contains", value: "xyz" }] },
          { name: "hello world" },
        ),
      ).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Operator: not_contains
  // ---------------------------------------------------------------------------
  describe("op: not_contains", () => {
    test("matches when array does NOT contain value", () => {
      expect(
        match(
          { conditions: [{ field: "tags", op: "not_contains", value: "bug" }] },
          { tags: ["feature"] },
        ),
      ).toBe(true);
    });

    test("rejects when array DOES contain value", () => {
      expect(
        match(
          { conditions: [{ field: "tags", op: "not_contains", value: "bug" }] },
          { tags: ["bug", "ui"] },
        ),
      ).toBe(false);
    });

    test("matches when string does NOT contain substring", () => {
      expect(
        match(
          { conditions: [{ field: "name", op: "not_contains", value: "xyz" }] },
          { name: "hello" },
        ),
      ).toBe(true);
    });

    test("rejects when string DOES contain substring", () => {
      expect(
        match(
          { conditions: [{ field: "name", op: "not_contains", value: "hello" }] },
          { name: "hello world" },
        ),
      ).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Operator: gt
  // ---------------------------------------------------------------------------
  describe("op: gt", () => {
    test("matches when value is greater", () => {
      expect(match({ conditions: [{ field: "count", op: "gt", value: 5 }] }, { count: 10 })).toBe(
        true,
      );
    });

    test("rejects when value is equal", () => {
      expect(match({ conditions: [{ field: "count", op: "gt", value: 5 }] }, { count: 5 })).toBe(
        false,
      );
    });

    test("rejects when value is less", () => {
      expect(match({ conditions: [{ field: "count", op: "gt", value: 5 }] }, { count: 3 })).toBe(
        false,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Operator: lt
  // ---------------------------------------------------------------------------
  describe("op: lt", () => {
    test("matches when value is less", () => {
      expect(match({ conditions: [{ field: "count", op: "lt", value: 10 }] }, { count: 3 })).toBe(
        true,
      );
    });

    test("rejects when value is equal", () => {
      expect(match({ conditions: [{ field: "count", op: "lt", value: 10 }] }, { count: 10 })).toBe(
        false,
      );
    });

    test("rejects when value is greater", () => {
      expect(match({ conditions: [{ field: "count", op: "lt", value: 10 }] }, { count: 15 })).toBe(
        false,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Operator: exists
  // ---------------------------------------------------------------------------
  describe("op: exists", () => {
    test("matches when field is present", () => {
      expect(match({ conditions: [{ field: "a", op: "exists" }] }, { a: "something" })).toBe(true);
    });

    test("matches when field is 0 (falsy but not null/undefined)", () => {
      expect(match({ conditions: [{ field: "a", op: "exists" }] }, { a: 0 })).toBe(true);
    });

    test("matches when field is empty string", () => {
      expect(match({ conditions: [{ field: "a", op: "exists" }] }, { a: "" })).toBe(true);
    });

    test("rejects when field is undefined", () => {
      expect(match({ conditions: [{ field: "a", op: "exists" }] }, {})).toBe(false);
    });

    test("rejects when field is null", () => {
      expect(match({ conditions: [{ field: "a", op: "exists" }] }, { a: null })).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Mode: any
  // ---------------------------------------------------------------------------
  describe("mode: any", () => {
    test("passes when at least one condition is true", () => {
      const config: PropertyMatchConfig = {
        conditions: [
          { field: "a", op: "eq", value: "x" },
          { field: "b", op: "eq", value: "y" },
        ],
        mode: "any",
      };
      // Only 'b' matches
      expect(match(config, { a: "nope", b: "y" })).toBe(true);
    });

    test("rejects when no conditions are true", () => {
      const config: PropertyMatchConfig = {
        conditions: [
          { field: "a", op: "eq", value: "x" },
          { field: "b", op: "eq", value: "y" },
        ],
        mode: "any",
      };
      expect(match(config, { a: "nope", b: "nope" })).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Mode: all (default)
  // ---------------------------------------------------------------------------
  describe("mode: all (default)", () => {
    test("passes when ALL conditions are true", () => {
      const config: PropertyMatchConfig = {
        conditions: [
          { field: "a", op: "eq", value: "x" },
          { field: "b", op: "eq", value: "y" },
        ],
      };
      expect(match(config, { a: "x", b: "y" })).toBe(true);
    });

    test("rejects when any condition is false", () => {
      const config: PropertyMatchConfig = {
        conditions: [
          { field: "a", op: "eq", value: "x" },
          { field: "b", op: "eq", value: "y" },
        ],
      };
      expect(match(config, { a: "x", b: "nope" })).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // resolvePath
  // ---------------------------------------------------------------------------
  describe("deep dot-path resolution", () => {
    test("resolves nested paths", () => {
      expect(
        match(
          { conditions: [{ field: "trigger.data.status", op: "eq", value: "open" }] },
          { trigger: { data: { status: "open" } } },
        ),
      ).toBe(true);
    });

    test("returns undefined for null mid-path (exists check fails)", () => {
      expect(
        match(
          { conditions: [{ field: "trigger.data.status", op: "exists" }] },
          { trigger: { data: null } },
        ),
      ).toBe(false);
    });

    test("returns undefined for missing intermediate key", () => {
      expect(match({ conditions: [{ field: "a.b.c", op: "exists" }] }, { a: {} })).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Flat config format (property/operator/value)
  // ---------------------------------------------------------------------------
  describe("flat config format", () => {
    test("matches with flat property/operator/value config", () => {
      expect(
        match(
          { property: "trigger.source", operator: "eq", value: "api" },
          { trigger: { source: "api" } },
        ),
      ).toBe(true);
    });

    test("rejects with flat config when value does not match", () => {
      expect(
        match(
          { property: "trigger.source", operator: "eq", value: "slack" },
          { trigger: { source: "api" } },
        ),
      ).toBe(false);
    });

    test("flat config with exists operator", () => {
      expect(
        match({ property: "trigger.epicId", operator: "exists" }, { trigger: { epicId: "abc" } }),
      ).toBe(true);
    });

    test("flat config with exists operator when missing", () => {
      expect(match({ property: "trigger.epicId", operator: "exists" }, { trigger: {} })).toBe(
        false,
      );
    });

    test("conditions array takes priority over flat config", () => {
      expect(
        match(
          {
            conditions: [{ field: "a", op: "eq", value: "x" }],
            property: "b",
            operator: "eq",
            value: "y",
          },
          { a: "x", b: "nope" },
        ),
      ).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // No conditions (empty/missing)
  // ---------------------------------------------------------------------------
  describe("no conditions", () => {
    test("empty conditions array fails the node", () => {
      expect(match({ conditions: [] }, {})).toBe(false);
    });

    test("no conditions and no flat config fails the node", () => {
      expect(match({} as PropertyMatchConfig, {})).toBe(false);
    });

    test("flat config with property but no operator fails the node and warns", () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      expect(
        match({ property: "trigger.source" } as PropertyMatchConfig, {
          trigger: { source: "api" },
        }),
      ).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('no "operator"');
      warnSpy.mockRestore();
    });

    test("returns error output when no valid conditions", () => {
      const result = executePropertyMatch({} as PropertyMatchConfig, {});
      expect(result.nextPort).toBe("false");
      const output = result.output as { passed: boolean; error: string };
      expect(output.passed).toBe(false);
      expect(output.error).toBe("No valid conditions configured");
    });
  });

  // ---------------------------------------------------------------------------
  // Flat config with mode: "any"
  // ---------------------------------------------------------------------------
  describe("flat config with mode: any", () => {
    test("flat config respects mode setting", () => {
      expect(match({ property: "a", operator: "eq", value: "x", mode: "any" }, { a: "x" })).toBe(
        true,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Output structure
  // ---------------------------------------------------------------------------
  describe("output structure", () => {
    test("returns correct output shape", () => {
      const result = executePropertyMatch(
        { conditions: [{ field: "a", op: "eq", value: 1 }] },
        { a: 1 },
      );
      expect(result.mode).toBe("instant");
      expect(result.nextPort).toBe("true");
      const output = result.output as { passed: boolean; results: boolean[] };
      expect(output.passed).toBe(true);
      expect(output.results).toEqual([true]);
    });

    test("returns per-condition results array", () => {
      const result = executePropertyMatch(
        {
          conditions: [
            { field: "a", op: "eq", value: 1 },
            { field: "b", op: "eq", value: 2 },
          ],
        },
        { a: 1, b: 99 },
      );
      const output = result.output as { passed: boolean; results: boolean[] };
      expect(output.results).toEqual([true, false]);
      expect(output.passed).toBe(false);
    });
  });
});
