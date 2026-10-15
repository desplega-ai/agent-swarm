import { describe, expect, test } from "bun:test";
import { ConfigRefError, isConfigRef, resolveConfigRefs } from "../be/config-refs";

const values: Record<string, string> = { A: "alpha", B: "bravo" };
const lookup = (key: string) => values[key];

describe("resolveConfigRefs", () => {
  test("resolves nested refs and refs inside arrays", () => {
    const resolved = resolveConfigRefs<Record<string, unknown>>(
      {
        top: { $config: "A" },
        nested: { deep: { value: { $config: "B" } } },
        list: [{ $config: "A" }, "plain", { inner: { $config: "B" } }],
      },
      lookup,
    );
    expect(resolved).toEqual({
      top: "alpha",
      nested: { deep: { value: "bravo" } },
      list: ["alpha", "plain", { inner: "bravo" }],
    });
  });

  test("aggregates every missing key into one error", () => {
    let error: unknown;
    try {
      resolveConfigRefs({ a: { $config: "MISSING_2" }, b: [{ $config: "MISSING_1" }] }, lookup);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigRefError);
    expect((error as ConfigRefError).missingKeys).toEqual(["MISSING_1", "MISSING_2"]);
    expect((error as Error).message).toContain("MISSING_1, MISSING_2");
  });

  test("leaves non-ref objects and scalars untouched", () => {
    const input = {
      notRef: { $config: "A", extra: true },
      emptyRef: { $config: "" },
      numberRef: { $config: 7 },
      n: 1,
      b: false,
      nil: null,
    };
    expect(resolveConfigRefs(input, lookup)).toEqual(input);
  });

  test("propagates a lookup that throws", () => {
    expect(() =>
      resolveConfigRefs({ k: { $config: "FORBIDDEN" } }, () => {
        throw new Error("forbidden key");
      }),
    ).toThrow("forbidden key");
  });
});

describe("isConfigRef", () => {
  test("accepts only a single non-empty $config string key", () => {
    expect(isConfigRef({ $config: "X" })).toBe(true);
    expect(isConfigRef({ $config: "X", other: 1 })).toBe(false);
    expect(isConfigRef({ $config: "" })).toBe(false);
    expect(isConfigRef([{ $config: "X" }])).toBe(false);
    expect(isConfigRef("X")).toBe(false);
    expect(isConfigRef(null)).toBe(false);
  });
});
