import { afterEach, describe, expect, test } from "bun:test";
import { approvalRequestAutoCancellationDays } from "../be/approval-sweeps";
import { validateConfigValue } from "../be/swarm-config-guard";

const KEY = "APPROVAL_REQUEST_AUTO_CANCELLATION_DAYS";
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

describe("approvalRequestAutoCancellationDays", () => {
  test("defaults to 7 when unset", () => {
    delete process.env[KEY];
    expect(approvalRequestAutoCancellationDays()).toBe(7);
  });

  test("reads a positive integer", () => {
    process.env[KEY] = "3";
    expect(approvalRequestAutoCancellationDays()).toBe(3);
  });

  test("reads 0 as disabled", () => {
    process.env[KEY] = "0";
    expect(approvalRequestAutoCancellationDays()).toBe(0);
  });

  test("falls back to 7 for invalid values", () => {
    process.env[KEY] = "abc";
    expect(approvalRequestAutoCancellationDays()).toBe(7);
    process.env[KEY] = "-1";
    expect(approvalRequestAutoCancellationDays()).toBe(7);
  });
});

describe("APPROVAL_REQUEST_AUTO_CANCELLATION_DAYS validator", () => {
  test("accepts a non-negative integer", () => {
    expect(validateConfigValue(KEY, "7")).toBeNull();
    expect(validateConfigValue(KEY, "0")).toBeNull();
  });

  test("rejects negative and non-numeric values", () => {
    expect(typeof validateConfigValue(KEY, "-1")).toBe("string");
    expect(typeof validateConfigValue(KEY, "x")).toBe("string");
  });
});
