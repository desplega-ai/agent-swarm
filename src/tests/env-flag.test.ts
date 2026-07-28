import { describe, expect, test } from "bun:test";
import { validateConfigValue } from "../be/swarm-config-guard";
import { isEnvFlagEnabled, parseEnvFlag } from "../utils/env-flag";

describe("parseEnvFlag", () => {
  test("accepts both truthy serializations", () => {
    for (const raw of ["true", "TRUE", " True ", "1", " 1 "]) {
      expect(parseEnvFlag(raw, false)).toBe(true);
    }
  });

  // The dashboard writes "false"; deployment envs historically wrote "0".
  // Consumers that only understood one of them were the original bug.
  test("accepts both falsy serializations", () => {
    for (const raw of ["false", "FALSE", " False ", "0", " 0 "]) {
      expect(parseEnvFlag(raw, true)).toBe(false);
    }
  });

  test("falls back to the default when absent or empty", () => {
    expect(parseEnvFlag(undefined, true)).toBe(true);
    expect(parseEnvFlag(undefined, false)).toBe(false);
    expect(parseEnvFlag(null, true)).toBe(true);
    expect(parseEnvFlag("", true)).toBe(true);
    expect(parseEnvFlag("   ", false)).toBe(false);
  });

  // A typo must not silently disable a default-on safety feature.
  test("falls back to the default on unrecognized values", () => {
    expect(parseEnvFlag("treu", true)).toBe(true);
    expect(parseEnvFlag("yes", false)).toBe(false);
    expect(parseEnvFlag("2", true)).toBe(true);
  });
});

describe("isEnvFlagEnabled", () => {
  test("reads from the supplied env bag", () => {
    expect(isEnvFlagEnabled("SOME_FLAG", false, { SOME_FLAG: "true" })).toBe(true);
    expect(isEnvFlagEnabled("SOME_FLAG", true, { SOME_FLAG: "0" })).toBe(false);
    expect(isEnvFlagEnabled("SOME_FLAG", true, {})).toBe(true);
  });
});

describe("swarm-config-guard: Configuration-page value validation", () => {
  test("boolean keys accept true/false/1/0 and reject anything else", () => {
    for (const key of ["STEERING_ENABLED", "RBAC_ENABLED", "POOL_AFFINITY_ENFORCEMENT"]) {
      for (const ok of ["true", "false", "1", "0", " TRUE "]) {
        expect(validateConfigValue(key, ok)).toBeNull();
      }
      expect(validateConfigValue(key, "yes")).toContain(`Invalid ${key}`);
      expect(validateConfigValue(key, "")).toContain(`Invalid ${key}`);
    }
  });

  test("steering enums are constrained", () => {
    expect(validateConfigValue("SLACK_THREAD_STEERING", "lead")).toBeNull();
    expect(validateConfigValue("SLACK_THREAD_STEERING", "all")).toBeNull();
    expect(validateConfigValue("SLACK_THREAD_STEERING", "everyone")).toContain("must be one of");
    expect(validateConfigValue("SLACK_THREAD_STEERING_MODE", "queue")).toBeNull();
    expect(validateConfigValue("SLACK_THREAD_STEERING_MODE", "steer")).toBeNull();
    expect(validateConfigValue("SLACK_THREAD_STEERING_MODE", "now")).toContain("must be one of");
  });

  test("interval and count keys require positive integers", () => {
    expect(validateConfigValue("HEARTBEAT_INTERVAL_MS", "90000")).toBeNull();
    expect(validateConfigValue("HEARTBEAT_INTERVAL_MS", "0")).toContain("integer >= 1");
    expect(validateConfigValue("HEARTBEAT_INTERVAL_MS", "-5")).toContain("integer >= 1");
    expect(validateConfigValue("WORKFLOW_MAX_ITERATIONS", "abc")).toContain("integer >= 1");
    expect(validateConfigValue("RBAC_AUDIT_RETENTION_DAYS", "30")).toBeNull();
  });

  test("HEARTBEAT_MAX_AUTO_ASSIGN allows 0 (assign nothing)", () => {
    expect(validateConfigValue("HEARTBEAT_MAX_AUTO_ASSIGN", "0")).toBeNull();
    expect(validateConfigValue("HEARTBEAT_MAX_AUTO_ASSIGN", "5")).toBeNull();
    expect(validateConfigValue("HEARTBEAT_MAX_AUTO_ASSIGN", "-1")).toContain("integer >= 0");
  });

  test("memory float ranges are enforced", () => {
    expect(validateConfigValue("MEMORY_MIN_SIMILARITY", "0.1")).toBeNull();
    expect(validateConfigValue("MEMORY_MIN_SIMILARITY", "0")).toBeNull();
    expect(validateConfigValue("MEMORY_MIN_SIMILARITY", "1")).toBeNull();
    expect(validateConfigValue("MEMORY_MIN_SIMILARITY", "1.5")).toContain("between 0 and 1");
    expect(validateConfigValue("MEMORY_MIN_SIMILARITY", "nope")).toContain("between 0 and 1");

    expect(validateConfigValue("MEMORY_ACCESS_BOOST_MAX", "1.5")).toBeNull();
    expect(validateConfigValue("MEMORY_ACCESS_BOOST_MAX", "1")).toBeNull();
    expect(validateConfigValue("MEMORY_ACCESS_BOOST_MAX", "0.5")).toContain(">= 1");
  });

  test("unknown keys stay unvalidated", () => {
    expect(validateConfigValue("SOME_RANDOM_KEY", "whatever")).toBeNull();
  });
});
