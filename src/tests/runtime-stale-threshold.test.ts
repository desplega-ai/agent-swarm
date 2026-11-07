import { afterEach, describe, expect, test } from "bun:test";

import { runtimeStaleThresholdMinutes } from "../be/multi-runtime";

const KEY = "RUNTIME_STALE_THRESHOLD_MIN";
const original = process.env[KEY];

function set(value: string | undefined): void {
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
}

describe("runtimeStaleThresholdMinutes", () => {
  afterEach(() => set(original));

  test("a negative value falls back to the 5-minute default (#2802)", () => {
    set("-1");
    expect(runtimeStaleThresholdMinutes()).toBe(5);
  });

  test("zero falls back to the default", () => {
    set("0");
    expect(runtimeStaleThresholdMinutes()).toBe(5);
  });

  test("non-numeric junk falls back to the default", () => {
    set("soon");
    expect(runtimeStaleThresholdMinutes()).toBe(5);
  });

  test("unset uses the default", () => {
    set(undefined);
    expect(runtimeStaleThresholdMinutes()).toBe(5);
  });

  test("a positive configured value stays effective", () => {
    set("17");
    expect(runtimeStaleThresholdMinutes()).toBe(17);
  });
});
