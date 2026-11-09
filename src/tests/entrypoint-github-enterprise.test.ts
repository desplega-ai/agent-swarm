import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

/**
 * GitHub auth block of docker-entrypoint.sh under GITHUB_URL (GHES).
 *
 * The block is extracted verbatim and run under bash with real `git`, an
 * isolated HOME and a stub `gh` on PATH that records its argv. Nothing hits
 * the network.
 */

const entrypointPath = `${import.meta.dir}/../../docker-entrypoint.sh`;
const TOKEN = "ghp_syntheticGhesTestToken000000000000"; // gitleaks:allow (synthetic test fixture)
const SECRET = "urlSecretMustNotBeLogged0000"; // gitleaks:allow (synthetic: a PAT pasted into GITHUB_URL)

function extractGitHubAuthBlock(): string {
  const script = readFileSync(entrypointPath, "utf8");
  const start = script.indexOf('echo "=== GitHub Authentication ==="');
  const end = script.indexOf('echo "=============================="', start);
  if (start === -1 || end === -1)
    throw new Error("GitHub auth block not found in docker-entrypoint.sh");
  return script.slice(start, end);
}

const block = extractGitHubAuthBlock();
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function runBlock(githubUrl?: string, ghVersion = "2.103.3") {
  const home = mkdtempSync(join(tmpdir(), "ghes-entrypoint-"));
  tempDirs.push(home);
  const bin = join(home, "bin");
  mkdirSync(bin);
  const ghLog = join(home, "gh.log");
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\nif [ "$1" = --version ]; then echo "gh version ${ghVersion} (2026-01-01)"; exit 0; fi\necho "$*" >> "${ghLog}"\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);

  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
    GITHUB_TOKEN: TOKEN,
  };
  if (githubUrl !== undefined) env.GITHUB_URL = githubUrl;
  const script = `set -e\n${block}\necho "GH_HOST=\${GH_HOST:-} GH_ENTERPRISE_TOKEN=\${GH_ENTERPRISE_TOKEN:-}"\nbash -c 'echo "child GITHUB_TOKEN=\${GITHUB_TOKEN:-} GH_TOKEN=\${GH_TOKEN:-}"'\n`;
  const result = await runChild(["bash", "-c", script], { env });
  const ghCalls = existsSync(ghLog) ? readFileSync(ghLog, "utf8").trim().split("\n") : [];
  const gitconfig = existsSync(env.GIT_CONFIG_GLOBAL!)
    ? readFileSync(env.GIT_CONFIG_GLOBAL!, "utf8")
    : "";
  // The worker env after the block: the PAT only in GH_ENTERPRISE_TOKEN on GHES.
  const { GITHUB_TOKEN: _dropped, ...workerEnv } = env;
  const credentialFill = (url: string) =>
    runChild(["git", "credential", "fill"], {
      env: { ...workerEnv, GH_ENTERPRISE_TOKEN: TOKEN },
      stdin: `url=${url}\n\n`,
    });
  return { result, ghCalls, gitconfig, credentialFill };
}

describe("docker-entrypoint.sh: GitHub auth with GITHUB_URL", () => {
  test(
    "GHES: exports GH_HOST + GH_ENTERPRISE_TOKEN and writes an env-reading git helper",
    async () => {
      const run = await runBlock("https://GHE.test/");
      expectChildOk(run.result, "auth block");
      expect(run.result.stdout).toContain(`GH_HOST=ghe.test GH_ENTERPRISE_TOKEN=${TOKEN}`);
      expect(run.result.stdout).toContain("GitHub Enterprise auth configured (host: ghe.test)");
      // gh sends GITHUB_TOKEN / GH_TOKEN to github.com: the GHES PAT leaves both.
      expect(run.result.stdout).toContain("child GITHUB_TOKEN= GH_TOKEN=");
      expect(run.ghCalls).toEqual([]);
      expect(run.gitconfig).toContain('[credential "https://ghe.test"]');
      expect(run.gitconfig).not.toContain(TOKEN);

      const fill = await run.credentialFill("https://ghe.test/o/r.git");
      expectChildOk(fill, "git credential fill");
      expect(fill.stdout).toContain("username=x-access-token");
      expect(fill.stdout).toContain(`password=${TOKEN}`);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "default (unset or github.com): gh auth setup-git as today, no helper, no GH_HOST",
    async () => {
      for (const url of [undefined, "https://github.com"]) {
        const run = await runBlock(url);
        expectChildOk(run.result, `auth block (${url ?? "unset"})`);
        expect(run.ghCalls).toEqual(["auth setup-git"]);
        expect(run.gitconfig).not.toContain("credential");
        expect(run.result.stdout).toContain("GH_HOST= GH_ENTERPRISE_TOKEN=");
        expect(run.result.stdout).toContain(`child GITHUB_TOKEN=${TOKEN}`);
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test.each([
    ["credentials", `https://x-access-token:${SECRET}@ghe.test`],
    ["invalid URL", `ftp://${SECRET}@ghe.test/x`],
    ["path", `https://ghe.test/${SECRET}`],
    ["no scheme", `${SECRET}.ghe.test`],
  ])(
    "%s: the rejected GITHUB_URL never reaches stdout or stderr",
    async (_label, url) => {
      const run = await runBlock(url);
      expect(run.result.exitCode).not.toBe(0);
      expect(run.result.stdout).toContain("ERROR: GITHUB_URL");
      expect(run.result.stdout).not.toContain(SECRET);
      expect(run.result.stderr).not.toContain(SECRET);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test.each(["2.92.9", "1.0.0"])(
    "GHES with gh %s (before the 2.93.0 token fix) exits non-zero",
    async (version) => {
      const run = await runBlock("https://ghe.test", version);
      expect(run.result.exitCode).not.toBe(0);
      expect(run.result.stdout).toContain("ERROR: GitHub Enterprise needs gh >= 2.93.0");
      expect(run.gitconfig).not.toContain("credential");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test.each(["ftp://ghe.test", "https://ghe.test/sub/path", "https://user@ghe.test", "ghe.test"])(
    "invalid GITHUB_URL %s exits non-zero",
    async (url) => {
      const run = await runBlock(url);
      expect(run.result.exitCode).not.toBe(0);
      expect(run.result.stdout).toContain("ERROR: GITHUB_URL");
      expect(run.ghCalls).toEqual([]);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
