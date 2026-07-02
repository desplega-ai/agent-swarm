import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import { Redacted } from "../scripts-runtime/redacted";

describe("Redacted", () => {
  test("stringification surfaces are redacted", () => {
    const secret = Redacted.make("hunter2", { type: "user", isSecret: true });
    expect(String(secret)).toBe("<redacted>");
    expect(JSON.stringify({ secret })).toBe('{"secret":"<redacted>"}');
    expect(inspect(secret)).toContain("<redacted>");
    expect(inspect(secret)).not.toContain("hunter2");
  });

  test("value round-trips the original value", () => {
    const value = { nested: true };
    const wrapped = Redacted.make(value);
    expect(Redacted.value(wrapped)).toBe(value);
  });

  test("meta returns the stored metadata", () => {
    const wrapped = Redacted.make("abc", { type: "system", isSecret: false });
    expect(Redacted.meta(wrapped)).toEqual({ type: "system", isSecret: false });
    expect(Redacted.isSecret(wrapped)).toBe(false);
  });

  test("unregistered objects throw", () => {
    expect(() => Redacted.value({} as never)).toThrow("Redacted value was not in registry");
  });
});
