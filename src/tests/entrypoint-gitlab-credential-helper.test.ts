import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

/**
 * Regression test for the GitLab git credential helper setup in
 * docker-entrypoint.sh.
 *
 * The GITLAB_HOST assignment and the `git config --global ... helper` command
 * are extracted verbatim from docker-entrypoint.sh and run under bash against
 * real `git`, so this tracks the deployed snippet instead of a copy of it.
 *
 * Regression: the helper was set with a plain `git config --global KEY VALUE`.
 * When the origin already had several helper values (a startup hook's
 * `helper = ""` reset plus its own helper, or a second boot on a persisted
 * HOME), git refused with "cannot overwrite multiple values with a single
 * value" and `set -e` killed the entrypoint. `--replace-all` makes the step
 * idempotent for that one origin.
 *
 * Every git call runs with an isolated HOME / global config, no system config,
 * terminal prompts off, and synthetic hosts and tokens. Nothing hits the network.
 */

const entrypointPath = `${import.meta.dir}/../../docker-entrypoint.sh`;

// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal shell expansion in the entrypoint
const HELPER_KEY_EXPR = '"credential.${GITLAB_HOST%/}.helper"';
const SYNTHETIC_TOKEN = "glpat-synthetic-test-token"; // gitleaks:allow (synthetic test fixture)
const HOOK_HELPER = "!synthetic-hook-helper";

function extractGitlabHelperSnippet(): string {
  const script = readFileSync(entrypointPath, "utf8");

  const hostLineStart = script.indexOf('GITLAB_HOST="${GITLAB_URL:-');
  if (hostLineStart === -1) {
    throw new Error("Could not locate the GITLAB_HOST assignment in docker-entrypoint.sh.");
  }
  const hostLine = script.slice(hostLineStart, script.indexOf("\n", hostLineStart));

  const keyIndex = script.indexOf(HELPER_KEY_EXPR, hostLineStart);
  if (keyIndex === -1) {
    throw new Error(
      `Could not locate ${HELPER_KEY_EXPR} in the GitLab block of docker-entrypoint.sh.`,
    );
  }
  const commandStart = script.lastIndexOf("git config --global", keyIndex);
  const closingMarker = "; f'";
  const closingIndex = script.indexOf(closingMarker, keyIndex);
  if (commandStart === -1 || closingIndex === -1) {
    throw new Error("Could not locate the bounds of the GitLab helper `git config` command.");
  }
  const command = script.slice(commandStart, closingIndex + closingMarker.length);

  return `set -e\n${hostLine}\n${command}\n`;
}

const snippet = extractGitlabHelperSnippet();
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "gitlab-helper-"));
  tempDirs.push(home);
  return home;
}

function isolatedEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
    ...extra,
  };
}

async function git(home: string, args: string[], stdin?: string, extra?: Record<string, string>) {
  return runChild(["git", ...args], { env: isolatedEnv(home, extra), stdin });
}

async function addHelper(home: string, origin: string, value: string) {
  expectChildOk(
    await git(home, ["config", "--global", "--add", `credential.${origin}.helper`, value]),
    "git config --add",
  );
}

/** The startup-hook pattern: reset inherited helpers, then add its own. */
async function addHookPair(home: string, origin: string) {
  await addHelper(home, origin, "");
  await addHelper(home, origin, HOOK_HELPER);
}

async function getHelpers(home: string, origin: string): Promise<string[]> {
  const result = await git(home, [
    "config",
    "--global",
    "--get-all",
    `credential.${origin}.helper`,
  ]);
  if (result.exitCode === 1) return [];
  expectChildOk(result, "git config --get-all");
  return result.stdout.replace(/\n$/, "").split("\n");
}

async function runSnippet(home: string, gitlabUrl?: string) {
  const extra: Record<string, string> = { GITLAB_TOKEN: SYNTHETIC_TOKEN };
  if (gitlabUrl !== undefined) extra.GITLAB_URL = gitlabUrl;
  return runChild(["bash", "-c", snippet], { env: isolatedEnv(home, extra) });
}

function expectOnlyEntrypointHelper(helpers: string[]) {
  expect(helpers).toHaveLength(1);
  expect(helpers[0]).toStartWith("!f() {");
  expect(helpers[0]).toContain("username=oauth2");
}

const ORIGIN = "https://gitlab.example.test";

describe("docker-entrypoint.sh: GitLab git credential helper", () => {
  test(
    "sets the helper when none exists (default gitlab.com origin)",
    async () => {
      const home = makeHome();
      expectChildOk(await runSnippet(home), "snippet");
      expectOnlyEntrypointHelper(await getHelpers(home, "https://gitlab.com"));
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "replaces a single existing value",
    async () => {
      const home = makeHome();
      await addHelper(home, ORIGIN, "!old-helper");
      expectChildOk(await runSnippet(home, ORIGIN), "snippet");
      expectOnlyEntrypointHelper(await getHelpers(home, ORIGIN));
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "succeeds over an empty reset value plus a custom helper",
    async () => {
      const home = makeHome();
      await addHookPair(home, ORIGIN);
      expectChildOk(await runSnippet(home, ORIGIN), "snippet");
      expectOnlyEntrypointHelper(await getHelpers(home, ORIGIN));
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "succeeds over several non-empty values",
    async () => {
      const home = makeHome();
      await addHelper(home, ORIGIN, "!helper-one");
      await addHelper(home, ORIGIN, "!helper-two");
      expectChildOk(await runSnippet(home, ORIGIN), "snippet");
      expectOnlyEntrypointHelper(await getHelpers(home, ORIGIN));
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "repeated runs do not accumulate values",
    async () => {
      const home = makeHome();
      for (let i = 0; i < 3; i++) expectChildOk(await runSnippet(home, ORIGIN), `snippet run ${i}`);
      expectOnlyEntrypointHelper(await getHelpers(home, ORIGIN));
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "leaves another origin's helpers untouched",
    async () => {
      const home = makeHome();
      const other = "https://other.example.test";
      await addHookPair(home, other);
      await addHookPair(home, ORIGIN);
      expectChildOk(await runSnippet(home, ORIGIN), "snippet");
      expect(await getHelpers(home, other)).toEqual(["", HOOK_HELPER]);
      expectOnlyEntrypointHelper(await getHelpers(home, ORIGIN));
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "keeps the port and strips one trailing slash from GITLAB_URL",
    async () => {
      const home = makeHome();
      const origin = "https://gitlab.example.test:8443";
      await addHookPair(home, origin);
      expectChildOk(await runSnippet(home, `${origin}/`), "snippet");
      expectOnlyEntrypointHelper(await getHelpers(home, origin));
      expect(await getHelpers(home, `${origin}/`)).toEqual([]);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "stores a reference to GITLAB_TOKEN, never the token value",
    async () => {
      const home = makeHome();
      expectChildOk(await runSnippet(home, ORIGIN), "snippet");
      const gitconfig = readFileSync(join(home, ".gitconfig"), "utf8");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the helper must keep the shell reference
      expect(gitconfig).toContain("${GITLAB_TOKEN}");
      expect(gitconfig).not.toContain(SYNTHETIC_TOKEN);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "answers get from the environment and ignores store / erase",
    async () => {
      const home = makeHome();
      expectChildOk(await runSnippet(home, ORIGIN), "snippet");
      const tokenEnv = { GITLAB_TOKEN: SYNTHETIC_TOKEN };

      const fill = expectChildOk(
        await git(
          home,
          ["credential", "fill"],
          "protocol=https\nhost=gitlab.example.test\n\n",
          tokenEnv,
        ),
        "git credential fill",
      );
      expect(fill.stdout).toContain("username=oauth2\n");
      expect(fill.stdout).toContain(`password=${SYNTHETIC_TOKEN}\n`);

      const cred = `protocol=https\nhost=gitlab.example.test\nusername=oauth2\npassword=${SYNTHETIC_TOKEN}\n\n`;
      for (const action of ["approve", "reject"]) {
        const result = expectChildOk(
          await git(home, ["credential", action], cred, tokenEnv),
          `git credential ${action}`,
        );
        expect(result.stdout).toBe("");
      }
      expect(readFileSync(join(home, ".gitconfig"), "utf8")).not.toContain(SYNTHETIC_TOKEN);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "a startup hook can re-add its reset + helper pair across restarts",
    async () => {
      const home = makeHome();
      for (let boot = 0; boot < 2; boot++) {
        expectChildOk(await runSnippet(home, ORIGIN), `snippet boot ${boot}`);
        await addHookPair(home, ORIGIN);
        // The hook's "" resets the entrypoint helper before it in the chain,
        // and the next boot's --replace-all collapses all three again.
        const helpers = await getHelpers(home, ORIGIN);
        expect(helpers).toHaveLength(3);
        expectOnlyEntrypointHelper(helpers.slice(0, 1));
        expect(helpers.slice(1)).toEqual(["", HOOK_HELPER]);
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
