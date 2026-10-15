import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_SECRET_ENV_ALLOWLIST } from "../utils/harness-env-secrets";
import { runChild } from "./test-proc";

/**
 * docker-entrypoint.sh decides which secret swarm_config rows the runner
 * process inherits. These tests run the real shell code, extracted between its
 * markers, in bash with the real jq, and check it agrees with the TS allowlist
 * the runner applies per task.
 */

const entrypoint = readFileSync(`${import.meta.dir}/../../docker-entrypoint.sh`, "utf8");

function between(begin: string, end: string): string {
  const start = entrypoint.indexOf(begin);
  if (start === -1) throw new Error(`docker-entrypoint.sh lost its marker: ${begin}`);
  const stop = entrypoint.indexOf(end, start);
  if (stop === -1) throw new Error(`docker-entrypoint.sh lost its marker: ${end}`);
  return entrypoint.slice(start, stop + end.length);
}

const withheldKeysSrc = between(
  "# BEGIN withheld_secret_env_keys",
  "# END withheld_secret_env_keys",
);
const bootstrapUnsetSrc = between(
  "for withheld_key in ",
  "unset AGENT_SWARM_WITHHELD_ENV withheld_key",
);

const dir = mkdtempSync(join(tmpdir(), "harness-env-secrets-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Row = { key: string; value: string; isSecret: boolean };

async function withheldKeys(rows: Row[], env: Record<string, string> = {}): Promise<string[]> {
  const file = join(dir, `${crypto.randomUUID()}.json`);
  writeFileSync(file, JSON.stringify({ configs: rows }));
  const result = await runChild(
    ["bash", "-c", `set -e\n${withheldKeysSrc}\nwithheld_secret_env_keys "$1"`, "bash", file],
    { env: { PATH: process.env.PATH, ...env } },
  );
  expect(result.exitCode).toBe(0);
  return result.stdout.split("\n").filter(Boolean);
}

const rows: Row[] = [
  { key: "SLACK_BOT_TOKEN", value: "s", isSecret: true },
  { key: "VERCEL_TOKEN", value: "v", isSecret: true },
  { key: "GITHUB_TOKEN", value: "g", isSecret: true },
  { key: "CLAUDE_CODE_OAUTH_TOKEN", value: "c", isSecret: true },
  { key: "connection.example.secret", value: "x", isSecret: true },
  { key: "PUBLIC_SETTING", value: "p", isSecret: false },
];

describe("docker-entrypoint.sh secret env", () => {
  test("the shell allowlist matches the runner allowlist", () => {
    const line = withheldKeysSrc.match(/^HARNESS_SECRET_ENV_ALLOWLIST="([^"]*)"$/m);
    expect(line).not.toBeNull();
    const shellKeys = (line?.[1] ?? "").split(" ").filter(Boolean).sort();
    expect(shellKeys).toEqual([...HARNESS_SECRET_ENV_ALLOWLIST].sort());
  });

  test("lists secret rows outside the allowlist, never public or non-identifier keys", async () => {
    expect(await withheldKeys(rows)).toEqual(["SLACK_BOT_TOKEN", "VERCEL_TOKEN"]);
  });

  test("HARNESS_ENV_SECRET_PASSTHROUGH from a row or the env adds keys; * keeps all", async () => {
    const passRow = {
      key: "HARNESS_ENV_SECRET_PASSTHROUGH",
      value: " VERCEL_TOKEN,",
      isSecret: false,
    };
    expect(await withheldKeys([...rows, passRow])).toEqual(["SLACK_BOT_TOKEN"]);
    expect(await withheldKeys(rows, { HARNESS_ENV_SECRET_PASSTHROUGH: "SLACK_BOT_TOKEN" })).toEqual(
      ["VERCEL_TOKEN"],
    );
    expect(await withheldKeys(rows, { HARNESS_ENV_SECRET_PASSTHROUGH: "*" })).toEqual([]);
  });

  test("the bootstrap execs the runner without the withheld keys", async () => {
    const result = await runChild(["bash", "-c", `set -e\n${bootstrapUnsetSrc}\nexec env`], {
      env: {
        PATH: process.env.PATH,
        SLACK_BOT_TOKEN: "s",
        VERCEL_TOKEN: "v",
        GITHUB_TOKEN: "g",
        AGENT_SWARM_WITHHELD_ENV: "SLACK_BOT_TOKEN VERCEL_TOKEN ",
      },
    });
    expect(result.exitCode).toBe(0);
    const names = result.stdout.split("\n").map((line) => line.split("=")[0]);
    expect(names).toContain("GITHUB_TOKEN");
    expect(names).not.toContain("SLACK_BOT_TOKEN");
    expect(names).not.toContain("VERCEL_TOKEN");
    expect(names).not.toContain("AGENT_SWARM_WITHHELD_ENV");
  });
});
