import { describe, expect, test } from "bun:test";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

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

/**
 * The jq programs below are extracted verbatim from docker-entrypoint.sh and
 * run against real `jq`, so they track the deployed filter instead of the
 * hand-written mirror above.
 */
const entrypointPath = `${import.meta.dir}/../../docker-entrypoint.sh`;

function extractExportFilter(lineMarker: string): string {
  const script: string = require("node:fs").readFileSync(entrypointPath, "utf8");
  const line = script.split("\n").find((l) => l.includes(lineMarker) && l.includes("jq -r '"));
  if (!line) throw new Error(`Could not locate the jq line containing ${lineMarker}`);
  const start = line.indexOf("jq -r '") + "jq -r '".length;
  const end = line.indexOf("' /tmp/swarm_config.json", start);
  if (end === -1) throw new Error(`Could not locate the end of the jq program for ${lineMarker}`);
  return line.slice(start, end);
}

async function runJq(filter: string, input: unknown): Promise<string[]> {
  const result = await runChild(["jq", "-r", filter], { stdin: JSON.stringify(input) });
  expectChildOk(result, "jq");
  return result.stdout.split("\n").filter(Boolean);
}

const slotValue = JSON.stringify({
  access: "at.value",
  refresh: "rt.secret",
  expires: 1,
  accountId: "acct",
});
const configs = {
  configs: [
    { key: "NORMAL", value: "val" },
    { key: "codex_oauth", value: slotValue },
    { key: "codex_oauth_0", value: slotValue },
    { key: "codex_oauth_12", value: slotValue },
    { key: "codex_oauth_extra", value: "kept" },
    { key: "HARNESS_PROVIDER", value: "codex" },
    { key: "CLAUDE_TRANSPORT", value: "sdk" },
    { key: "CF-Access-Client-Id", value: "id" },
  ],
};

describe("entrypoint config env export: real jq filter", () => {
  test(
    "never exports codex_oauth or codex_oauth_<n>, nor the runner-resolved keys",
    async () => {
      const lines = await runJq(extractExportFilter("> /tmp/swarm_config.env"), configs);
      const keys = lines.map((l) => l.slice(0, l.indexOf("=")));
      expect(keys).toEqual(["NORMAL", "codex_oauth_extra"]);
      expect(lines.join("\n")).not.toContain("rt.secret");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "the non-identifier debug list skips the same denylisted keys",
    async () => {
      const lines = await runJq(extractExportFilter("SKIPPED_NONIDENT=$(jq"), configs);
      expect(lines).toEqual(["CF-Access-Client-Id"]);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
