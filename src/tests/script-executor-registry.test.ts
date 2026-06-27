import { describe, expect, test } from "bun:test";
import { getScriptExecutor, NativeScriptExecutor } from "@swarm/scripts";

describe("getScriptExecutor", () => {
  test("defaults to native", () => {
    expect(getScriptExecutor()).toBeInstanceOf(NativeScriptExecutor);
  });

  test("returns native when requested", () => {
    expect(getScriptExecutor("native")).toBeInstanceOf(NativeScriptExecutor);
  });

  test("throws for unknown executors", () => {
    expect(() => getScriptExecutor("e2b")).toThrow("Available: native");
  });
});
