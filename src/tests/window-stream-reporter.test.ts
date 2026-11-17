/**
 * P2: mid-session window snapshots go out when a window moved 5 points or
 * more, or 60 s passed since the last report. A failed report never throws.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { createWindowStreamReporter } from "../commands/credential-outcome-report";
import type { RateLimitWindowTelemetry } from "../utils/error-tracker";

function windows(fiveHour: number, sevenDay = 0.1): RateLimitWindowTelemetry {
  const lastSeenAt = new Date().toISOString();
  return {
    five_hour: { status: "allowed", utilization: fiveHour, resetsAt: 1_900_000_000, lastSeenAt },
    seven_day: { status: "allowed", utilization: sevenDay, resetsAt: 1_900_500_000, lastSeenAt },
  };
}

function harness(post?: (w: RateLimitWindowTelemetry) => Promise<void>) {
  let clock = 1_000_000;
  const sent: RateLimitWindowTelemetry[] = [];
  const report = createWindowStreamReporter({
    post:
      post ??
      (async (w) => {
        sent.push(w);
      }),
    now: () => clock,
  });
  return {
    report,
    sent,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("createWindowStreamReporter", () => {
  test("the first snapshot is sent", () => {
    const h = harness();
    h.report(windows(0.2));
    expect(h.sent).toHaveLength(1);
  });

  test("a move under 5 points within 60 s is skipped", () => {
    const h = harness();
    h.report(windows(0.2));
    h.advance(10_000);
    h.report(windows(0.24));
    h.advance(10_000);
    h.report(windows(0.2, 0.14));
    expect(h.sent).toHaveLength(1);
  });

  test("a move of 5 points or more is sent at once", () => {
    const h = harness();
    h.report(windows(0.2));
    h.advance(1_000);
    h.report(windows(0.25));
    h.advance(1_000);
    h.report(windows(0.25, 0.2));
    expect(h.sent).toHaveLength(3);
  });

  test("the delta compares with the last sent snapshot, not the last seen one", () => {
    const h = harness();
    h.report(windows(0.2));
    h.report(windows(0.23));
    h.report(windows(0.26));
    expect(h.sent.map((w) => w.five_hour?.utilization)).toEqual([0.2, 0.26]);
  });

  test("an unchanged snapshot is sent again after 60 s", () => {
    const h = harness();
    h.report(windows(0.2));
    h.advance(59_999);
    h.report(windows(0.2));
    expect(h.sent).toHaveLength(1);
    h.advance(1);
    h.report(windows(0.2));
    expect(h.sent).toHaveLength(2);
  });

  test("a window the last report did not carry is sent at once", () => {
    const h = harness();
    h.report({ five_hour: windows(0.2).five_hour! });
    h.advance(1_000);
    h.report(windows(0.2));
    expect(h.sent).toHaveLength(2);
  });

  test("an empty snapshot is never sent", () => {
    const h = harness();
    h.report({});
    expect(h.sent).toHaveLength(0);
  });

  test("a rejected or throwing post never throws and the next event retries", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      let calls = 0;
      const h = harness(async () => {
        calls++;
        throw new Error("HTTP 503");
      });
      expect(() => h.report(windows(0.2))).not.toThrow();
      await Bun.sleep(0);
      h.advance(1_000);
      h.report(windows(0.2));
      await Bun.sleep(0);
      expect(calls).toBe(2);
      expect(warn).toHaveBeenCalled();

      const sync = harness(() => {
        throw new Error("boom");
      });
      expect(() => sync.report(windows(0.2))).not.toThrow();
      await Bun.sleep(0);
    } finally {
      warn.mockRestore();
    }
  });
});
