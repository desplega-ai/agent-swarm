import { describe, expect, test } from "bun:test";

/**
 * Tests for the config→env-var export filter in docker-entrypoint.sh.
 *
 * The entrypoint fetches swarm config and writes valid POSIX identifier keys
 * to /tmp/swarm_config.env for sourcing. Keys containing hyphens or other
 * non-identifier characters must be skipped — otherwise `source` interprets
 * them as commands:
 *
 *   CF-Access-Client-Id=84853443... → "command not found"
 *
 * This filter mirrors the jq expression in docker-entrypoint.sh so the
 * logic can be verified without a Docker environment.
 */

const POSIX_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DYNAMIC_KEYS = new Set(["codex_oauth", "HARNESS_PROVIDER"]);

/** Mirrors the jq filter in docker-entrypoint.sh. */
function filterForEnvExport(
  configs: Array<{ key: string; value: string }>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const { key, value } of configs) {
    if (DYNAMIC_KEYS.has(key)) continue;
    if (!POSIX_IDENTIFIER.test(key)) continue;
    result[key] = value;
  }
  return result;
}

describe("entrypoint config env export: POSIX identifier filter", () => {
  test("includes valid POSIX identifier keys", () => {
    const result = filterForEnvExport([
      { key: "FOO", value: "bar" },
      { key: "MY_VAR_123", value: "val" },
      { key: "_UNDERSCORE_START", value: "ok" },
    ]);
    expect(result.FOO).toBe("bar");
    expect(result.MY_VAR_123).toBe("val");
    expect(result._UNDERSCORE_START).toBe("ok");
  });

  test("excludes hyphenated keys (CF-Access-Client-Id pattern)", () => {
    const result = filterForEnvExport([
      { key: "FOO", value: "keep" },
      { key: "CF-Access-Client-Id", value: "secret1" },
      { key: "CF-Access-Client-Secret", value: "secret2" },
      { key: "BAR", value: "keep" },
    ]);
    expect(result.FOO).toBe("keep");
    expect(result.BAR).toBe("keep");
    expect("CF-Access-Client-Id" in result).toBe(false);
    expect("CF-Access-Client-Secret" in result).toBe(false);
  });

  test("excludes keys starting with a digit", () => {
    const result = filterForEnvExport([
      { key: "VALID", value: "yes" },
      { key: "123_INVALID", value: "no" },
    ]);
    expect(result.VALID).toBe("yes");
    expect("123_INVALID" in result).toBe(false);
  });

  test("excludes codex_oauth and HARNESS_PROVIDER (existing behaviour)", () => {
    const result = filterForEnvExport([
      { key: "NORMAL", value: "val" },
      { key: "codex_oauth", value: "secret" },
      { key: "HARNESS_PROVIDER", value: "claude" },
    ]);
    expect(result.NORMAL).toBe("val");
    expect("codex_oauth" in result).toBe(false);
    expect("HARNESS_PROVIDER" in result).toBe(false);
  });

  test("returns empty object for empty configs array", () => {
    expect(filterForEnvExport([])).toEqual({});
  });
});
