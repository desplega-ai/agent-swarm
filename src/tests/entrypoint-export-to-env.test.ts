import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

/**
 * Runs the real swarm_config_env block from docker-entrypoint.sh (extracted
 * between its BEGIN/END markers) against a /api/config/resolved fixture, the
 * same way the entrypoint sources it, and reads the resulting env.
 */

const entrypoint = readFileSync("docker-entrypoint.sh", "utf8");
const block = entrypoint.slice(
  entrypoint.indexOf("# BEGIN swarm_config_env"),
  entrypoint.indexOf("# END swarm_config_env"),
);

let dir = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "entrypoint-export-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function exportedEnv(configs: unknown[], containerEnv: Record<string, string> = {}) {
  const fixture = join(dir, `${crypto.randomUUID()}.json`);
  writeFileSync(fixture, JSON.stringify({ configs }));
  const script = `${block}
swarm_config_env_lines "$1" > "$1.env"
set -a; . "$1.env"; set +a
for withheld_key in $(swarm_config_withheld_keys "$1"); do unset "$withheld_key"; done
env
`;
  const result = await runChild(["bash", "-c", script, "bash", fixture], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...containerEnv },
    timeoutMs: CHILD_PROCESS_TEST_BUDGET_MS,
  });
  expectChildOk(result, "entrypoint export block");
  return Object.fromEntries(
    result.stdout
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

describe("docker-entrypoint.sh swarm_config_env", () => {
  test("markers are present", () => {
    expect(block).toContain("swarm_config_env_lines()");
    expect(block).toContain("swarm_config_withheld_keys()");
  });

  test("exports exportToEnv rows and drops withheld ones, including container copies", async () => {
    const env = await exportedEnv(
      [
        { key: "GITHUB_TOKEN", value: "row-github", isSecret: true, exportToEnv: true },
        { key: "VERCEL_TOKEN", value: "row-vercel", isSecret: true, exportToEnv: false },
        { key: "QUOTED", value: "it's $HOME", isSecret: false, exportToEnv: true },
        // A pre-215 API sends no flag: the row keeps exporting.
        { key: "LEGACY", value: "row-legacy", isSecret: true },
        { key: "CF-Access-Client-Id", value: "x", isSecret: true, exportToEnv: true },
        { key: "codex_oauth_1", value: "x", isSecret: true, exportToEnv: true },
        { key: "HARNESS_PROVIDER", value: "pi", isSecret: false, exportToEnv: true },
      ],
      { VERCEL_TOKEN: "container-vercel" },
    );
    expect(env.GITHUB_TOKEN).toBe("row-github");
    expect(env.QUOTED).toBe("it's $HOME");
    expect(env.LEGACY).toBe("row-legacy");
    expect(env.VERCEL_TOKEN).toBeUndefined();
    expect(env.codex_oauth_1).toBeUndefined();
    expect(env.HARNESS_PROVIDER).toBeUndefined();
    expect(Object.values(env)).not.toContain("row-vercel");
  });
});
