import { describe, expect, test } from "bun:test";
import { resolveHarnessProvider } from "../commands/runner.ts";

describe("resolveHarnessProvider", () => {
  test("defaults to claude when HARNESS_PROVIDER is unset", () => {
    expect(resolveHarnessProvider({})).toBe("claude");
  });

  test("falls back to claude for unknown values", () => {
    expect(resolveHarnessProvider({ HARNESS_PROVIDER: "foo" })).toBe("claude");
  });

  test("selects pi when explicitly configured", () => {
    expect(resolveHarnessProvider({ HARNESS_PROVIDER: "pi" })).toBe("pi");
  });
});
