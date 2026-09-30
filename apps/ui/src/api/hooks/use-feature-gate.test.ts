import { beforeEach, describe, expect, mock, test } from "bun:test";

let version: string | undefined;
let devMode: boolean | undefined;
let healthError: Error | null;
let statsError: boolean;

mock.module("@/lib/semver", () => require("../../lib/semver"));
mock.module("./use-stats", () => ({
  useApiVersion: () => ({ data: version, isError: !!healthError, error: healthError }),
  useStats: () => ({ data: { devMode }, isError: statsError }),
}));

const { useFeatureGate } = await import("./use-feature-gate");

beforeEach(() => {
  version = "1.0.0";
  devMode = undefined;
  healthError = null;
  statsError = false;
});

describe("useFeatureGate", () => {
  test.each([undefined, false])("keeps version checks when dev mode is %s", (flag) => {
    devMode = flag;
    expect(useFeatureGate("2.0.0").supported).toBe(false);
    expect(useFeatureGate("1.0.0").supported).toBe(true);
  });

  test("dev mode bypasses version comparisons and keeps the reported version", () => {
    devMode = true;
    expect(useFeatureGate("2.0.0")).toMatchObject({
      supported: true,
      currentVersion: "1.0.0",
      requiredVersion: "2.0.0",
    });
    devMode = false;
    expect(useFeatureGate("2.0.0").supported).toBe(false);
  });

  test("dev mode requires a resolved health response", () => {
    devMode = true;
    version = undefined;
    expect(useFeatureGate("2.0.0").supported).toBe(false);
  });

  test("a failed health refresh cannot bypass the gate with cached data", () => {
    devMode = true;
    healthError = new Error("API unavailable");
    expect(useFeatureGate("2.0.0")).toMatchObject({
      supported: false,
      isError: true,
      error: healthError,
    });
  });

  test("a failed stats refresh falls back to version checks", () => {
    devMode = true;
    statsError = true;
    expect(useFeatureGate("2.0.0").supported).toBe(false);
    expect(useFeatureGate("1.0.0").supported).toBe(true);
  });
});
