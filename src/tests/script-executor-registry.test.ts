import { describe, expect, test } from "bun:test";
import { NativeScriptExecutor } from "../scripts-runtime/executors/native";
import { QuickJSScriptExecutor } from "../scripts-runtime/executors/quickjs";
import { getScriptExecutor } from "../scripts-runtime/executors/registry";

describe("getScriptExecutor", () => {
  test("defaults to native", () => {
    expect(getScriptExecutor()).toBeInstanceOf(NativeScriptExecutor);
  });

  test("returns native when requested", () => {
    expect(getScriptExecutor("native")).toBeInstanceOf(NativeScriptExecutor);
  });

  test("returns quickjs when requested", () => {
    expect(getScriptExecutor("quickjs")).toBeInstanceOf(QuickJSScriptExecutor);
  });

  test("throws for unknown executors", () => {
    expect(() => getScriptExecutor("e2b")).toThrow("Available: native, quickjs");
  });
});
