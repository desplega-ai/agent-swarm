import { describe, expect, test } from "bun:test";
import {
  computeModelLimits,
  rateLimitWindowSchema,
  sanitizeReportedWindowResets,
} from "../http/api-keys";
import { MAX_RATE_LIMIT_RESET_MS } from "../utils/error-tracker";

/**
 * T7 acceptance: for Aslo's row (task fe35598c-8973-4728-a691-6d039d983101 /
 * FIXTURE_FABLE_REJECTED) before 2026-09-27T00:00:00Z, modelLimits[0] is
 * active. After that time it's inactive. Verified with a mocked clock on
 * both sides of resetsAt=1790467200 (2026-09-27T00:00:00Z).
 */
describe("computeModelLimits", () => {
  const windows = {
    five_hour: { status: "allowed", utilization: 0.05, resetsAt: 1790217000 },
    seven_day: { status: "allowed", utilization: 0.77, resetsAt: 1790467200 },
    seven_day_overage_included: { status: "rejected", resetsAt: 1790467200 },
  };

  test("before resetsAt: active Fable entry", () => {
    const beforeMs = new Date("2026-09-24T02:05:41.040Z").getTime();
    const limits = computeModelLimits(windows, beforeMs);
    expect(limits).toEqual([
      {
        model: "fable",
        window: "seven_day_overage_included",
        resetsAt: 1790467200,
        resetsAtIso: "2026-09-27T00:00:00.000Z",
        active: true,
      },
    ]);
  });

  test("after resetsAt: inactive Fable entry", () => {
    const afterMs = new Date("2026-09-28T00:00:00.000Z").getTime();
    const limits = computeModelLimits(windows, afterMs);
    expect(limits).toEqual([
      {
        model: "fable",
        window: "seven_day_overage_included",
        resetsAt: 1790467200,
        resetsAtIso: "2026-09-27T00:00:00.000Z",
        active: false,
      },
    ]);
  });

  test("no rejected model-scoped window: empty array", () => {
    expect(
      computeModelLimits({ five_hour: { status: "allowed", resetsAt: 1790217000 } }, Date.now()),
    ).toEqual([]);
  });

  test("allowed_warning status on a model window is not a limit", () => {
    expect(
      computeModelLimits(
        { seven_day_opus: { status: "allowed_warning", resetsAt: 1790467200 } },
        Date.now(),
      ),
    ).toEqual([]);
  });

  test("multiple rejected model-scoped windows all appear", () => {
    const nowMs = new Date("2026-09-24T00:00:00.000Z").getTime();
    const limits = computeModelLimits(
      {
        seven_day_overage_included: { status: "rejected", resetsAt: 1790467200 },
        seven_day_opus: { status: "rejected", resetsAt: 1790000000 },
      },
      nowMs,
    );
    expect(limits.map((l) => l.model).sort()).toEqual(["fable", "opus"]);
  });

  test("a reported negative out-of-Date-range resetsAt never reaches computeModelLimits unsanitized (GET /api/keys/status stays 200)", () => {
    const nowMs = Date.now();
    const reported = {
      seven_day_overage_included: {
        status: "rejected",
        resetsAt: -1e20,
        lastSeenAt: new Date().toISOString(),
      },
    };
    const stored = sanitizeReportedWindowResets(reported);
    expect(() => computeModelLimits(stored, nowMs)).not.toThrow();
    const limits = computeModelLimits(stored, nowMs);
    expect(limits).toHaveLength(1);
    expect(() => new Date(limits[0]!.resetsAtIso)).not.toThrow();
  });

  test("a reported positive out-of-Date-range resetsAt never reaches computeModelLimits unsanitized", () => {
    const nowMs = Date.now();
    const reported = {
      seven_day_opus: { status: "rejected", resetsAt: 1e20, lastSeenAt: new Date().toISOString() },
    };
    const stored = sanitizeReportedWindowResets(reported);
    expect(() => computeModelLimits(stored, nowMs)).not.toThrow();
  });
});

describe("rateLimitWindowSchema — malformed resetsAt at the report boundary", () => {
  test.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])("rejects non-finite resetsAt: %p", (resetsAt) => {
    const result = rateLimitWindowSchema.safeParse({
      status: "rejected",
      resetsAt,
      lastSeenAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  test("accepts a normal finite resetsAt", () => {
    const result = rateLimitWindowSchema.safeParse({
      status: "rejected",
      resetsAt: Math.floor(Date.now() / 1000) + 3600,
      lastSeenAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });
});

describe("sanitizeReportedWindowResets", () => {
  test("passes through a window without resetsAt unchanged", () => {
    const windows = { seven_day: { status: "allowed", lastSeenAt: new Date().toISOString() } };
    expect(sanitizeReportedWindowResets(windows)).toEqual(windows);
  });

  test("clamps an out-of-Date-range finite resetsAt so rendering it never throws", () => {
    const windows = {
      seven_day_overage_included: {
        status: "rejected",
        resetsAt: 1e20,
        lastSeenAt: new Date().toISOString(),
      },
    };
    const sanitized = sanitizeReportedWindowResets(windows);
    const resetsAt = sanitized.seven_day_overage_included?.resetsAt;
    expect(resetsAt).toBeDefined();
    expect(() => new Date(resetsAt! * 1000).toISOString()).not.toThrow();
    expect(resetsAt).toBeLessThanOrEqual(Math.floor((Date.now() + MAX_RATE_LIMIT_RESET_MS) / 1000));
  });

  test("clamps a representable but implausibly far-future resetsAt to the 7-day ceiling", () => {
    const farFutureSec = Math.floor(new Date("3000-01-01T00:00:00Z").getTime() / 1000);
    const windows = {
      seven_day_opus: {
        status: "rejected",
        resetsAt: farFutureSec,
        lastSeenAt: new Date().toISOString(),
      },
    };
    const sanitized = sanitizeReportedWindowResets(windows);
    expect(sanitized.seven_day_opus?.resetsAt).toBeLessThan(farFutureSec);
    expect(sanitized.seven_day_opus?.resetsAt).toBeLessThanOrEqual(
      Math.floor((Date.now() + MAX_RATE_LIMIT_RESET_MS) / 1000),
    );
  });

  test("leaves a legitimate near-future resetsAt untouched", () => {
    const soonSec = Math.floor(Date.now() / 1000) + 3600;
    const windows = {
      seven_day_sonnet: {
        status: "rejected",
        resetsAt: soonSec,
        lastSeenAt: new Date().toISOString(),
      },
    };
    expect(sanitizeReportedWindowResets(windows).seven_day_sonnet?.resetsAt).toBe(soonSec);
  });

  test("clamps a finite negative out-of-Date-range resetsAt so rendering it never throws", () => {
    const windows = {
      seven_day_overage_included: {
        status: "rejected",
        resetsAt: -1e20,
        lastSeenAt: new Date().toISOString(),
      },
    };
    const sanitized = sanitizeReportedWindowResets(windows);
    const resetsAt = sanitized.seven_day_overage_included?.resetsAt;
    expect(resetsAt).toBeDefined();
    expect(() => new Date(resetsAt! * 1000).toISOString()).not.toThrow();
    expect(resetsAt).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000));
  });

  test("clamps a representable but implausibly far-past resetsAt to now", () => {
    const farPastSec = Math.floor(new Date("1000-01-01T00:00:00Z").getTime() / 1000);
    const windows = {
      seven_day_opus: {
        status: "rejected",
        resetsAt: farPastSec,
        lastSeenAt: new Date().toISOString(),
      },
    };
    const sanitized = sanitizeReportedWindowResets(windows);
    expect(sanitized.seven_day_opus?.resetsAt).toBeGreaterThan(farPastSec);
    expect(sanitized.seven_day_opus?.resetsAt).toBeGreaterThanOrEqual(
      Math.floor(Date.now() / 1000),
    );
  });
});
