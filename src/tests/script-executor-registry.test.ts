import { describe, expect, test } from "bun:test";
import { validateConfigValue } from "../be/swarm-config-guard";
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

describe("SCRIPT_EXECUTOR configuration", () => {
  test("every accepted value resolves to its executor", () => {
    for (const value of ["native", "quickjs", " native ", " quickjs "]) {
      expect(validateConfigValue("SCRIPT_EXECUTOR", value)).toBeNull();
      expect(getScriptExecutor(value).name).toBe(value.trim());
    }
  });

  test("rejects unsupported names, blank values and non-string values", () => {
    for (const value of ["e2b", "Native", "QUICKJS", "", " ", null, undefined, 1, true]) {
      expect(validateConfigValue("SCRIPT_EXECUTOR", value)).toBe(
        "Invalid SCRIPT_EXECUTOR value (must be one of: native, quickjs)",
      );
    }
  });
});
