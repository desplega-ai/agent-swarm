import { describe, expect, test } from "bun:test";
import { NativeScriptExecutor } from "../scripts-runtime/executors/native";
import { getScriptExecutor } from "../scripts-runtime/executors/registry";

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
