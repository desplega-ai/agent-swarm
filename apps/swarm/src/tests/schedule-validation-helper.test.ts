import { describe, expect, test } from "bun:test";
import { mergeScheduleTiming, validateRecurringTiming } from "../be/schedules/validate";

describe("mergeScheduleTiming", () => {
  test("explicit null overrides existing", () => {
    const result = mergeScheduleTiming(
      { cronExpression: "0 * * * *", intervalMs: null },
      { cronExpression: null },
    );
    expect(result).toEqual({ mergedCron: null, mergedInterval: null });
  });

  test("undefined preserves existing", () => {
    const result = mergeScheduleTiming({ cronExpression: "0 * * * *", intervalMs: null }, {});
    expect(result).toEqual({ mergedCron: "0 * * * *", mergedInterval: null });
  });

  test("explicit value overrides existing", () => {
    const result = mergeScheduleTiming(
      { cronExpression: "0 * * * *", intervalMs: null },
      { cronExpression: "0 2 * * *" },
    );
    expect(result).toEqual({ mergedCron: "0 2 * * *", mergedInterval: null });
  });
});

describe("validateRecurringTiming", () => {
  test("cron-only existing + { cronExpression: null } patch → both-null error", () => {
    const merged = mergeScheduleTiming(
      { cronExpression: "0 * * * *", intervalMs: null },
      { cronExpression: null },
    );
    expect(validateRecurringTiming(merged)).toEqual({ kind: "both-null" });
  });

  test("cron-only existing + { cronExpression: null, intervalMs: 60000 } → valid", () => {
    const merged = mergeScheduleTiming(
      { cronExpression: "0 * * * *", intervalMs: null },
      { cronExpression: null, intervalMs: 60000 },
    );
    expect(validateRecurringTiming(merged)).toBeNull();
  });

  test("both existing populated, patch nulls both → both-null error", () => {
    const merged = mergeScheduleTiming(
      { cronExpression: "0 * * * *", intervalMs: 60000 },
      { cronExpression: null, intervalMs: null },
    );
    expect(validateRecurringTiming(merged)).toEqual({ kind: "both-null" });
  });
});
