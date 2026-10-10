import { describe, expect, test } from "bun:test";
import { validateConfigValue } from "../be/swarm-config-guard";
import { NativeScriptExecutor } from "../scripts-runtime/executors/native";
import { QuickJSScriptExecutor } from "../scripts-runtime/executors/quickjs";
import { resolveQuickJSPoolSize } from "../scripts-runtime/executors/quickjs-pool-config";
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

describe("SCRIPT_QUICKJS_POOL_SIZE configuration", () => {
  test("defaults to four and accepts bounded whole numbers", () => {
    expect(resolveQuickJSPoolSize(undefined)).toBe(4);
    for (const value of ["1", "4", "32", " 2 ", 1, 32]) {
      expect(validateConfigValue("SCRIPT_QUICKJS_POOL_SIZE", value)).toBeNull();
      expect(resolveQuickJSPoolSize(String(value))).toBe(Number(value));
    }
  });

  test("config writes and deployment env reject invalid sizes", () => {
    for (const value of [
      0,
      33,
      1.5,
      "0",
      "33",
      "1.5",
      "1e1",
      "0x10",
      "NaN",
      "",
      " ",
      "99999999999999999",
    ]) {
      expect(validateConfigValue("SCRIPT_QUICKJS_POOL_SIZE", value)).toContain(
        "integer between 1 and 32",
      );
      expect(() => resolveQuickJSPoolSize(String(value))).toThrow("integer between 1 and 32");
    }
    for (const value of [null, undefined, true, [2], {}, { toString: null }]) {
      expect(validateConfigValue("SCRIPT_QUICKJS_POOL_SIZE", value)).toContain(
        "integer between 1 and 32",
      );
    }
  });
});
