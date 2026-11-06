import { afterEach, describe, expect, test } from "bun:test";
import { runtimeStaleThresholdMinutes } from "../be/multi-runtime";

describe("runtimeStaleThresholdMinutes", () => {
  const saved = process.env.RUNTIME_STALE_THRESHOLD_MIN;

  afterEach(() => {
    if (saved === undefined) delete process.env.RUNTIME_STALE_THRESHOLD_MIN;
    else process.env.RUNTIME_STALE_THRESHOLD_MIN = saved;
  });

  test("defaults to 5 when the variable is unset", () => {
    delete process.env.RUNTIME_STALE_THRESHOLD_MIN;
    expect(runtimeStaleThresholdMinutes()).toBe(5);
  });

  test("keeps a positive value", () => {
    process.env.RUNTIME_STALE_THRESHOLD_MIN = "10";
    expect(runtimeStaleThresholdMinutes()).toBe(10);
  });

  test("keeps a fractional positive value", () => {
    process.env.RUNTIME_STALE_THRESHOLD_MIN = "0.5";
    expect(runtimeStaleThresholdMinutes()).toBe(0.5);
  });


  test("zero falls back to the default", () => {
    process.env.RUNTIME_STALE_THRESHOLD_MIN = "0";
    expect(runtimeStaleThresholdMinutes()).toBe(5);
  });

  test("a non-numeric value falls back to the default", () => {
    process.env.RUNTIME_STALE_THRESHOLD_MIN = "soon";
    expect(runtimeStaleThresholdMinutes()).toBe(5);
  });

});
