import { describe, expect, test } from "bun:test";
import { deepInterpolate, interpolate } from "../workflows/template";

// ─── interpolate() ──────────────────────────────────────────

describe("interpolate", () => {
  describe("happy paths", () => {
    test("simple top-level path", () => {
      const { result, unresolved } = interpolate("Hello {{name}}", { name: "World" });
      expect(result).toBe("Hello World");
      expect(unresolved).toEqual([]);
    });

    test("nested path", () => {
      const { result, unresolved } = interpolate("Hello {{user.name}}", {
        user: { name: "Taras" },
      });
      expect(result).toBe("Hello Taras");
      expect(unresolved).toEqual([]);
    });

    test("deeply nested path (3+ levels)", () => {
      const { result, unresolved } = interpolate("Val: {{a.b.c.d}}", {
        a: { b: { c: { d: "deep" } } },
      });
      expect(result).toBe("Val: deep");
      expect(unresolved).toEqual([]);
    });

    test("object value is JSON-stringified", () => {
      const { result, unresolved } = interpolate("Data: {{obj}}", {
        obj: { key: "value" },
      });
      expect(result).toBe('Data: {"key":"value"}');
      expect(unresolved).toEqual([]);
    });

    test("array value is JSON-stringified", () => {
      const { result, unresolved } = interpolate("Items: {{arr}}", {
        arr: [1, 2, 3],
      });
      expect(result).toBe("Items: [1,2,3]");
      expect(unresolved).toEqual([]);
    });

    test("number value is stringified", () => {
      const { result, unresolved } = interpolate("Count: {{count}}", { count: 42 });
      expect(result).toBe("Count: 42");
      expect(unresolved).toEqual([]);
    });

    test("boolean value is stringified", () => {
      const { result, unresolved } = interpolate("Active: {{active}}", { active: true });
      expect(result).toBe("Active: true");
      expect(unresolved).toEqual([]);
    });

    test("multiple tokens in one template", () => {
      const { result, unresolved } = interpolate("{{first}} and {{second}}", {
        first: "A",
        second: "B",
      });
      expect(result).toBe("A and B");
      expect(unresolved).toEqual([]);
    });
  });

  describe("unresolved tracking", () => {
    test("missing top-level key", () => {
      const { result, unresolved } = interpolate("Hello {{missing}}", {});
      expect(result).toBe("Hello ");
      expect(unresolved).toEqual(["missing"]);
    });

    test("null midway through path", () => {
      const { result, unresolved } = interpolate("Val: {{a.b.c}}", {
        a: { b: null },
      });
      expect(result).toBe("Val: ");
      expect(unresolved).toEqual(["a.b.c"]);
    });

    test("typo in path", () => {
      const { result, unresolved } = interpolate("Val: {{user.naem}}", {
        user: { name: "Taras" },
      });
      expect(result).toBe("Val: ");
      expect(unresolved).toEqual(["user.naem"]);
    });

    test("final value is null", () => {
      const { result, unresolved } = interpolate("Val: {{key}}", { key: null });
      expect(result).toBe("Val: ");
      expect(unresolved).toEqual(["key"]);
    });

    test("final value is undefined", () => {
      const { result, unresolved } = interpolate("Val: {{key}}", { key: undefined });
      expect(result).toBe("Val: ");
      expect(unresolved).toEqual(["key"]);
    });

    test("traversing through a non-object", () => {
      const { result, unresolved } = interpolate("Val: {{a.b.c}}", {
        a: "string-not-object",
      });
      expect(result).toBe("Val: ");
      expect(unresolved).toEqual(["a.b.c"]);
    });

    test("multiple unresolved tokens tracked", () => {
      const { result, unresolved } = interpolate("{{a}} and {{b}}", {});
      expect(result).toBe(" and ");
      expect(unresolved).toEqual(["a", "b"]);
    });
  });

  describe("circular references", () => {
    test("object with circular ref produces [Circular] instead of crash", () => {
      const obj: Record<string, unknown> = { name: "test" };
      obj.self = obj;
      const { result, unresolved } = interpolate("Data: {{data}}", { data: obj });
      expect(result).toBe("Data: [Circular]");
      expect(unresolved).toEqual([]);
    });
  });

  describe("edge cases", () => {
    test("empty template", () => {
      const { result, unresolved } = interpolate("", { key: "value" });
      expect(result).toBe("");
      expect(unresolved).toEqual([]);
    });

    test("template with no tokens", () => {
      const { result, unresolved } = interpolate("Hello World", {});
      expect(result).toBe("Hello World");
      expect(unresolved).toEqual([]);
    });

    test("empty context", () => {
      const { result, unresolved } = interpolate("{{key}}", {});
      expect(result).toBe("");
      expect(unresolved).toEqual(["key"]);
    });

    test("whitespace in path is trimmed", () => {
      const { result, unresolved } = interpolate("{{ foo.bar }}", {
        foo: { bar: "baz" },
      });
      expect(result).toBe("baz");
      expect(unresolved).toEqual([]);
    });

    test("consecutive tokens with no separator", () => {
      const { result, unresolved } = interpolate("{{a}}{{b}}", { a: "X", b: "Y" });
      expect(result).toBe("XY");
      expect(unresolved).toEqual([]);
    });

    test("empty string value resolves to empty string (not unresolved)", () => {
      const { result, unresolved } = interpolate("Val: {{key}}", { key: "" });
      expect(result).toBe("Val: ");
      expect(unresolved).toEqual([]);
    });

    test("zero value resolves to '0' (not unresolved)", () => {
      const { result, unresolved } = interpolate("Val: {{key}}", { key: 0 });
      expect(result).toBe("Val: 0");
      expect(unresolved).toEqual([]);
    });

    test("false value resolves to 'false' (not unresolved)", () => {
      const { result, unresolved } = interpolate("Val: {{key}}", { key: false });
      expect(result).toBe("Val: false");
      expect(unresolved).toEqual([]);
    });
  });
});

// ─── deepInterpolate() ─────────────────────────────────────

describe("deepInterpolate", () => {
  test("interpolates string value", () => {
    const { value, unresolved } = deepInterpolate("Hello {{name}}", { name: "World" });
    expect(value).toBe("Hello World");
    expect(unresolved).toEqual([]);
  });

  test("interpolates strings in array", () => {
    const { value, unresolved } = deepInterpolate(["{{a}}", "{{b}}", "fixed"], {
      a: "X",
      b: "Y",
    });
    expect(value).toEqual(["X", "Y", "fixed"]);
    expect(unresolved).toEqual([]);
  });

  test("interpolates nested object with templates", () => {
    const { value, unresolved } = deepInterpolate(
      { greeting: "Hello {{name}}", count: 42 },
      { name: "World" },
    );
    expect(value).toEqual({ greeting: "Hello World", count: 42 });
    expect(unresolved).toEqual([]);
  });

  test("mixed array (string + number + boolean)", () => {
    const { value, unresolved } = deepInterpolate(["{{name}}", 42, true, null], {
      name: "Test",
    });
    expect(value).toEqual(["Test", 42, true, null]);
    expect(unresolved).toEqual([]);
  });

  test("deeply nested structure (3+ levels)", () => {
    const input = {
      level1: {
        level2: {
          level3: "{{deep}}",
        },
        arr: ["{{item}}"],
      },
    };
    const { value, unresolved } = deepInterpolate(input, { deep: "found", item: "val" });
    expect(value).toEqual({
      level1: {
        level2: {
          level3: "found",
        },
        arr: ["val"],
      },
    });
    expect(unresolved).toEqual([]);
  });

  test("empty array passes through", () => {
    const { value, unresolved } = deepInterpolate([], {});
    expect(value).toEqual([]);
    expect(unresolved).toEqual([]);
  });

  test("null values in array pass through", () => {
    const { value, unresolved } = deepInterpolate([null, "{{a}}", null], { a: "X" });
    expect(value).toEqual([null, "X", null]);
    expect(unresolved).toEqual([]);
  });

  test("array of objects with templates", () => {
    const input = [{ name: "{{n1}}" }, { name: "{{n2}}" }];
    const { value, unresolved } = deepInterpolate(input, { n1: "Alice", n2: "Bob" });
    expect(value).toEqual([{ name: "Alice" }, { name: "Bob" }]);
    expect(unresolved).toEqual([]);
  });

  test("collects unresolved from nested structures", () => {
    const input = {
      a: "{{found}}",
      b: ["{{missing1}}"],
      c: { d: "{{missing2}}" },
    };
    const { value, unresolved } = deepInterpolate(input, { found: "ok" });
    expect(value).toEqual({
      a: "ok",
      b: [""],
      c: { d: "" },
    });
    expect(unresolved).toEqual(["missing1", "missing2"]);
  });

  test("non-string primitive passes through unchanged", () => {
    const { value, unresolved } = deepInterpolate(42, {});
    expect(value).toBe(42);
    expect(unresolved).toEqual([]);
  });

  test("null passes through unchanged", () => {
    const { value, unresolved } = deepInterpolate(null, {});
    expect(value).toBe(null);
    expect(unresolved).toEqual([]);
  });

  test("boolean passes through unchanged", () => {
    const { value, unresolved } = deepInterpolate(false, {});
    expect(value).toBe(false);
    expect(unresolved).toEqual([]);
  });
});
