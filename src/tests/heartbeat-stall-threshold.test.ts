import { afterEach, describe, expect, test } from "bun:test";
import {
  stallThresholdMinutes,
  stallThresholdNoSessionMin,
  stallThresholdStaleHeartbeatMin,
} from "../heartbeat/heartbeat";

// The stall thresholds are read at call time. A non-positive threshold would
// flag recently updated tasks as stalled immediately (any age clears a negative
// cutoff), so each parser must keep only finite positive values.
describe("heartbeat stall thresholds", () => {
  const ENV_KEYS = [
    "HEARTBEAT_STALL_THRESHOLD_MIN",
    "HEARTBEAT_STALL_NO_SESSION_MIN",
    "HEARTBEAT_STALL_STALE_HB_MIN",
  ] as const;
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("unset values use the defaults", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    expect(stallThresholdMinutes()).toBe(30);
    expect(stallThresholdNoSessionMin()).toBe(5);
    expect(stallThresholdStaleHeartbeatMin()).toBe(15);
  });

  test("negative, zero, and non-numeric values fall back to the defaults", () => {
    for (const value of ["-1", "0", "not-a-number", "Infinity", "NaN"]) {
      process.env.HEARTBEAT_STALL_THRESHOLD_MIN = value;
      process.env.HEARTBEAT_STALL_NO_SESSION_MIN = value;
      process.env.HEARTBEAT_STALL_STALE_HB_MIN = value;
      expect(stallThresholdMinutes()).toBe(30);
      expect(stallThresholdNoSessionMin()).toBe(5);
      expect(stallThresholdStaleHeartbeatMin()).toBe(15);
    }
  });

  test("a positive configured threshold remains effective", () => {
    process.env.HEARTBEAT_STALL_THRESHOLD_MIN = "45";
    process.env.HEARTBEAT_STALL_NO_SESSION_MIN = "7";
    process.env.HEARTBEAT_STALL_STALE_HB_MIN = "20";
    expect(stallThresholdMinutes()).toBe(45);
    expect(stallThresholdNoSessionMin()).toBe(7);
    expect(stallThresholdStaleHeartbeatMin()).toBe(20);
  });
});
