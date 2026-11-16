import { afterEach, describe, expect, test } from "bun:test";
import {
  stallThresholdNoSessionMin,
  stallThresholdStaleHeartbeatMin,
} from "../heartbeat/heartbeat";

// The no-session and stale-heartbeat stall thresholds are read at call time.
// A non-positive threshold would flag recently updated tasks as stalled
// immediately (any age clears a negative cutoff), so each parser must keep
// only positive integers, matching the primary threshold guard from #2838.
describe("heartbeat stall thresholds", () => {
  const ENV_KEYS = ["HEARTBEAT_STALL_NO_SESSION_MIN", "HEARTBEAT_STALL_STALE_HB_MIN"] as const;
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("unset values use the defaults", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    expect(stallThresholdNoSessionMin()).toBe(5);
    expect(stallThresholdStaleHeartbeatMin()).toBe(15);
  });

  test("negative, zero, non-numeric, and non-integer values fall back to the defaults", () => {
    for (const value of ["-1", "0", "not-a-number", "Infinity", "NaN", "2.5"]) {
      process.env.HEARTBEAT_STALL_NO_SESSION_MIN = value;
      process.env.HEARTBEAT_STALL_STALE_HB_MIN = value;
      expect(stallThresholdNoSessionMin()).toBe(5);
      expect(stallThresholdStaleHeartbeatMin()).toBe(15);
    }
  });

  test("a positive configured threshold remains effective", () => {
    process.env.HEARTBEAT_STALL_NO_SESSION_MIN = "7";
    process.env.HEARTBEAT_STALL_STALE_HB_MIN = "20";
    expect(stallThresholdNoSessionMin()).toBe(7);
    expect(stallThresholdStaleHeartbeatMin()).toBe(20);
  });
});
