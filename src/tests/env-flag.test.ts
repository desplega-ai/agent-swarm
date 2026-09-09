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

  test("Slack reaction shortcode keys accept bare and colon-wrapped names", () => {
    const keys = [
      "SLACK_REACTION_ACCEPTED",
      "SLACK_REACTION_BUFFERED",
      "SLACK_REACTION_NOW",
      "SLACK_REACTION_STEERED",
      "SLACK_REACTION_COMPLETED",
      "SLACK_REACTION_FAILED",
    ];
    for (const key of keys) {
      expect(validateConfigValue(key, "thumbsup")).toBeNull();
      expect(validateConfigValue(key, ":thumbsup:")).toBeNull();
      expect(validateConfigValue(key, "+1")).toBeNull();
    }
  });

  test("Slack reaction shortcode keys accept a skin-tone suffix, bare or colon-wrapped", () => {
    expect(validateConfigValue("SLACK_REACTION_ACCEPTED", "thumbsup::skin-tone-6")).toBeNull();
    expect(validateConfigValue("SLACK_REACTION_ACCEPTED", ":thumbsup::skin-tone-6:")).toBeNull();
    expect(validateConfigValue("SLACK_REACTION_ACCEPTED", "+1::skin-tone-2")).toBeNull();
  });

  test("Slack reaction shortcode keys reject an out-of-range or malformed skin-tone suffix", () => {
    for (const value of [
      "thumbsup::skin-tone-1",
      "thumbsup::skin-tone-7",
      "thumbsup:::skin-tone-6",
      "thumbsup::skin-tone-6::skin-tone-6",
    ]) {
      expect(validateConfigValue("SLACK_REACTION_ACCEPTED", value)).toContain(
        "Invalid SLACK_REACTION_ACCEPTED",
      );
    }
  });

  test("Slack reaction shortcode keys reject spaces, upper case, unicode and empty", () => {
    // "Heavy Check" (not "Heavy" alone): normalisation lowercases before the format
    // check (section 2.3), so a bare case difference alone is not rejected — only
    // the space is. Matches T4's own acceptance check value.
    for (const value of ["heavy check", "Heavy Check", "✅", "", ":"]) {
      expect(validateConfigValue("SLACK_REACTION_COMPLETED", value)).toContain(
        "Invalid SLACK_REACTION_COMPLETED",
      );
    }
  });

  test("interval and count keys require positive integers", () => {
    expect(validateConfigValue("HEARTBEAT_INTERVAL_MS", "90000")).toBeNull();
    expect(validateConfigValue("HEARTBEAT_INTERVAL_MS", "0")).toContain("integer >= 1");
    expect(validateConfigValue("HEARTBEAT_INTERVAL_MS", "-5")).toContain("integer >= 1");
    expect(validateConfigValue("WORKFLOW_MAX_ITERATIONS", "abc")).toContain("integer >= 1");
    expect(validateConfigValue("RBAC_AUDIT_RETENTION_DAYS", "30")).toBeNull();
  });

  test("OPENROUTER_BASE_URL accepts any http(s) gateway and blank, rejects broken URLs", () => {
    // Vendor-neutral: the swarm redirects its OpenRouter provider at whatever
    // OpenAI-compatible gateway the operator names.
    expect(validateConfigValue("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")).toBeNull();
    expect(validateConfigValue("OPENROUTER_BASE_URL", "https://api.orcarouter.ai/v1")).toBeNull();
    expect(
      validateConfigValue("OPENROUTER_BASE_URL", "http://gateway.internal:8080/v1"),
    ).toBeNull();
    expect(validateConfigValue("OPENROUTER_BASE_URL", "  https://gw.example.com/v1  ")).toBeNull();
    // Blank is how an operator reverts to openrouter.ai without deleting the row.
    expect(validateConfigValue("OPENROUTER_BASE_URL", "")).toBeNull();

    // Call sites append `/models` and `/chat/completions`, so a query string or
    // fragment would build a nonsense URL.
    expect(validateConfigValue("OPENROUTER_BASE_URL", "https://gw.example.com/v1?key=x")).toContain(
      "Invalid OPENROUTER_BASE_URL",
    );
    expect(validateConfigValue("OPENROUTER_BASE_URL", "https://gw.example.com/v1#a")).toContain(
      "Invalid OPENROUTER_BASE_URL",
    );
    expect(validateConfigValue("OPENROUTER_BASE_URL", "openrouter.ai/api/v1")).toContain(
      "Invalid OPENROUTER_BASE_URL",
    );
    expect(validateConfigValue("OPENROUTER_BASE_URL", "ftp://gw.example.com/v1")).toContain(
      "Invalid OPENROUTER_BASE_URL",
    );
    expect(validateConfigValue("OPENROUTER_BASE_URL", 42)).toContain("Invalid OPENROUTER_BASE_URL");
  });

  test("WORKER_API_READY_TIMEOUT_SECONDS requires a positive integer", () => {
    expect(validateConfigValue("WORKER_API_READY_TIMEOUT_SECONDS", "90")).toBeNull();
    expect(validateConfigValue("WORKER_API_READY_TIMEOUT_SECONDS", "1")).toBeNull();
    expect(validateConfigValue("WORKER_API_READY_TIMEOUT_SECONDS", "0")).toContain("integer >= 1");
    expect(validateConfigValue("WORKER_API_READY_TIMEOUT_SECONDS", "-30")).toContain(
      "integer >= 1",
    );
    expect(validateConfigValue("WORKER_API_READY_TIMEOUT_SECONDS", "abc")).toContain(
      "integer >= 1",
    );
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

  test("feedback endpoints require HTTPS except on loopback hosts", () => {
    expect(validateConfigValue("feedback_endpoint", "https://feedback.example.com/v1")).toBeNull();
    expect(validateConfigValue("feedback_endpoint", "http://localhost:3013/v1")).toBeNull();
    expect(validateConfigValue("feedback_endpoint", "http://127.0.0.1:3013/v1")).toBeNull();
    expect(validateConfigValue("feedback_endpoint", "http://[::1]:3013/v1")).toBeNull();
    expect(validateConfigValue("feedback_endpoint", "http://evil.example/v1")).toContain(
      "Invalid FEEDBACK_ENDPOINT",
    );
    expect(validateConfigValue("feedback_endpoint", "not a URL")).toContain(
      "Invalid FEEDBACK_ENDPOINT",
    );
  });

  test("unknown keys stay unvalidated", () => {
    expect(validateConfigValue("SOME_RANDOM_KEY", "whatever")).toBeNull();
  });
});
