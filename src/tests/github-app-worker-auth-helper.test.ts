/**
 * Worker side of GitHub App auth: scripts/swarm-github-token.sh (git credential
 * helper + token source), scripts/gh-app-auth-wrapper.sh, and the GitHub auth
 * block of docker-entrypoint.sh that picks App mode or the PAT path.
 *
 * A `Bun.serve` on port 0 stands in for the swarm API. Real bash, curl, jq and
 * git run against it; `gh` and `gosu` are stubs. Nothing leaves loopback.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

const HELPER = `${import.meta.dir}/../../scripts/swarm-github-token.sh`;
const WRAPPER = `${import.meta.dir}/../../scripts/gh-app-auth-wrapper.sh`;
const ENTRYPOINT = `${import.meta.dir}/../../docker-entrypoint.sh`;
const API_KEY = "example-worker-api-key";
const AGENT_ID = "0b0b0b0b-0000-4000-8000-000000000001";
const APP_TOKEN = "ghs_fixtureAppToken0000000000000000"; // gitleaks:allow (synthetic)
const PAT = "ghp_fixtureStaticPat000000000000000000"; // gitleaks:allow (synthetic)

let mode: "ok" | "unconfigured" | "short" = "ok";
let calls = 0;
let server: ReturnType<typeof Bun.serve>;
const tempDirs: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== "/api/github/installation-token") {
        return new Response("not found", { status: 404 });
      }
      calls++;
      if (
        req.headers.get("authorization") !== `Bearer ${API_KEY}` ||
        req.headers.get("x-agent-id") !== AGENT_ID
      ) {
        return Response.json({ error: "denied" }, { status: 403 });
      }
      if (mode === "unconfigured") return Response.json({ error: "no app" }, { status: 404 });
      const ttl = mode === "short" ? 4 * 60_000 : 60 * 60_000;
      return Response.json({
        token: APP_TOKEN,
        expiresAt: new Date(Date.now() + ttl).toISOString(),
      });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

afterEach(() => {
  mode = "ok";
  calls = 0;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "gh-app-auth-"));
  tempDirs.push(home);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
    MCP_BASE_URL: `http://127.0.0.1:${server.port}`,
    API_KEY,
    AGENT_ID,
    SWARM_GITHUB_TOKEN_CACHE_DIR: join(home, "cache"),
  };
  return { home, env };
}

const helper = (env: Record<string, string>, args: string[] = [], stdin?: string) =>
  runChild(["bash", HELPER, ...args], { env, stdin });

describe("swarm-github-token", () => {
  test(
    "prints the App token and serves repeat calls from a private cache",
    async () => {
      const { env } = sandbox();
      const first = expectChildOk(await helper(env), "first");
      expect(first.stdout.trim()).toBe(APP_TOKEN);
      expect(expectChildOk(await helper(env), "second").stdout.trim()).toBe(APP_TOKEN);
      expect(calls).toBe(1);
      const cacheDir = env.SWARM_GITHUB_TOKEN_CACHE_DIR!;
      expect(statSync(cacheDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(cacheDir, "token")).mode & 0o777).toBe(0o600);
      expect(first.stderr).not.toContain(APP_TOKEN);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "refetches a token inside the 5-minute refresh window",
    async () => {
      mode = "short";
      const { env } = sandbox();
      expectChildOk(await helper(env), "first");
      expectChildOk(await helper(env), "second");
      expect(calls).toBe(2);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "falls back to the static PAT when the API has no App (404) or is down",
    async () => {
      mode = "unconfigured";
      const { env } = sandbox();
      expect(expectChildOk(await helper({ ...env, GITHUB_TOKEN: PAT }), "404").stdout.trim()).toBe(
        PAT,
      );
      // --app-only is the boot probe: no App token means the PAT path.
      expect((await helper({ ...env, GITHUB_TOKEN: PAT }, ["--app-only"])).exitCode).toBe(1);
      // No PAT either: nothing to print.
      expect((await helper(env)).exitCode).toBe(1);
      // GHES: the runner moved the PAT to GH_ENTERPRISE_TOKEN.
      expect(
        expectChildOk(await helper({ ...env, GH_ENTERPRISE_TOKEN: PAT }), "ghes").stdout.trim(),
      ).toBe(PAT);
      const down = { ...env, MCP_BASE_URL: "http://127.0.0.1:9", GITHUB_TOKEN: PAT };
      expect(expectChildOk(await helper(down), "api down").stdout.trim()).toBe(PAT);
      // An unauthenticated worker is refused by the API and keeps its PAT.
      mode = "ok";
      const noKey = { ...env, API_KEY: "wrong", GITHUB_TOKEN: PAT };
      expect(expectChildOk(await helper(noKey), "denied").stdout.trim()).toBe(PAT);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "git credential protocol: get returns the App token, erase drops the cache",
    async () => {
      const { env } = sandbox();
      const get = expectChildOk(
        await helper(env, ["git-credential", "get"], "protocol=https\nhost=github.com\n\n"),
        "get",
      );
      expect(get.stdout).toBe(`username=x-access-token\npassword=${APP_TOKEN}\n`);
      expectChildOk(await helper(env, ["git-credential", "store"], "x\n"), "store");
      expect(existsSync(join(env.SWARM_GITHUB_TOKEN_CACHE_DIR!, "token"))).toBe(true);
      expectChildOk(await helper(env, ["git-credential", "erase"], "x\n"), "erase");
      expect(existsSync(join(env.SWARM_GITHUB_TOKEN_CACHE_DIR!, "token"))).toBe(false);
      mode = "unconfigured";
      const fallback = expectChildOk(
        await helper({ ...env, GITHUB_TOKEN: PAT }, ["git-credential", "get"], "\n"),
        "fallback get",
      );
      expect(fallback.stdout).toBe(`username=x-access-token\npassword=${PAT}\n`);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});

describe("gh-app-auth-wrapper", () => {
  test(
    "hands gh the App token as GH_TOKEN, or GH_ENTERPRISE_TOKEN on GHES",
    async () => {
      const { home, env } = sandbox();
      const realGh = join(home, "real-gh");
      writeFileSync(
        realGh,
        `#!/bin/sh\necho "args=$* GH_TOKEN=\${GH_TOKEN:-} GH_ENTERPRISE_TOKEN=\${GH_ENTERPRISE_TOKEN:-}"\n`,
      );
      chmodSync(realGh, 0o755);
      const tokenBin = join(home, "swarm-github-token");
      writeFileSync(tokenBin, `#!/bin/sh\nexec bash ${HELPER} "$@"\n`);
      chmodSync(tokenBin, 0o755);
      const wrapperEnv = { ...env, SWARM_REAL_GH: realGh, SWARM_GITHUB_TOKEN_BIN: tokenBin };

      const dotCom = expectChildOk(
        await runChild(["bash", WRAPPER, "pr", "view"], { env: wrapperEnv }),
        "github.com",
      );
      expect(dotCom.stdout.trim()).toBe(`args=pr view GH_TOKEN=${APP_TOKEN} GH_ENTERPRISE_TOKEN=`);
      const ghes = expectChildOk(
        await runChild(["bash", WRAPPER, "api", "user"], {
          env: { ...wrapperEnv, GH_HOST: "ghe.test" },
        }),
        "ghes",
      );
      expect(ghes.stdout.trim()).toBe(`args=api user GH_TOKEN= GH_ENTERPRISE_TOKEN=${APP_TOKEN}`);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});

function extractGitHubAuthBlock(): string {
  const script = readFileSync(ENTRYPOINT, "utf8");
  const start = script.indexOf('echo "=== GitHub Authentication ==="');
  const end = script.indexOf('echo "=============================="', start);
  if (start === -1 || end === -1) throw new Error("GitHub auth block not found");
  return script.slice(start, end);
}

describe("docker-entrypoint.sh: GitHub App worker auth", () => {
  const block = extractGitHubAuthBlock();

  async function runBlock(extraEnv: Record<string, string>, staleLink = false) {
    const { home, env } = sandbox();
    const bin = join(home, "bin");
    mkdirSync(bin);
    const ghLog = join(home, "gh.log");
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\nif [ "$1" = --version ]; then echo "gh version 2.103.3 (2026-01-01)"; exit 0; fi\necho "$*" >> "${ghLog}"\n`,
    );
    // gosu stub: drop the user argument and run the rest as this user.
    writeFileSync(join(bin, "gosu"), `#!/bin/sh\nshift\nexec "$@"\n`);
    const tokenBin = join(home, "swarm-github-token");
    writeFileSync(tokenBin, `#!/bin/sh\nexec bash ${HELPER} "$@"\n`);
    for (const file of [join(bin, "gh"), join(bin, "gosu"), tokenBin]) chmodSync(file, 0o755);
    const link = join(home, "gh-link");
    if (staleLink) symlinkSync("/nonexistent/gh-app-auth-wrapper", link);
    const blockEnv: Record<string, string> = {
      ...env,
      PATH: `${bin}:${env.PATH}`,
      MCP_URL: env.MCP_BASE_URL!,
      SWARM_GITHUB_TOKEN_BIN: tokenBin,
      GH_WRAPPER_LINK: link,
      ...extraEnv,
    };
    delete blockEnv.MCP_BASE_URL;
    const script = `set -e\n${block}\necho "GH_HOST=\${GH_HOST:-} GH_ENTERPRISE_TOKEN=\${GH_ENTERPRISE_TOKEN:-}"\n`;
    const result = await runChild(["bash", "-c", script], { env: blockEnv });
    const ghCalls = existsSync(ghLog) ? readFileSync(ghLog, "utf8").trim().split("\n") : [];
    const gitconfig = existsSync(env.GIT_CONFIG_GLOBAL!)
      ? readFileSync(env.GIT_CONFIG_GLOBAL!, "utf8")
      : "";
    const linked = (() => {
      try {
        return lstatSync(link).isSymbolicLink() ? readlinkSync(link) : null;
      } catch {
        return null;
      }
    })();
    const credentialFill = (url: string, fillEnv: Record<string, string> = {}) =>
      runChild(["git", "credential", "fill"], {
        env: { ...env, ...fillEnv },
        stdin: `url=${url}\n\n`,
      });
    return { result, ghCalls, gitconfig, linked, tokenBin, credentialFill };
  }

  test(
    "github.com App mode: helper and gh wrapper, no PAT needed, no gh auth setup-git",
    async () => {
      const run = await runBlock({});
      expectChildOk(run.result, "auth block");
      expect(run.result.stdout).toContain("GitHub App worker auth configured");
      expect(run.ghCalls).toEqual([]);
      expect(run.gitconfig).toContain('[credential "https://github.com"]');
      expect(run.gitconfig).toContain(`helper = !${run.tokenBin} git-credential`);
      expect(run.gitconfig).not.toContain(APP_TOKEN);
      expect(run.linked).toBe("/usr/local/lib/agent-swarm/gh-app-auth-wrapper");
      expect(run.result.stdout).not.toContain(APP_TOKEN);
      const fill = expectChildOk(
        await run.credentialFill("https://github.com/o/r.git"),
        "credential fill",
      );
      expect(fill.stdout).toContain(`password=${APP_TOKEN}`);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "GHES App mode keeps the PAT as GH_ENTERPRISE_TOKEN fallback and scopes the helper to the host",
    async () => {
      const run = await runBlock({ GITHUB_URL: "https://ghe.test", GITHUB_TOKEN: PAT });
      expectChildOk(run.result, "auth block");
      expect(run.result.stdout).toContain(`GH_HOST=ghe.test GH_ENTERPRISE_TOKEN=${PAT}`);
      expect(run.gitconfig).toContain('[credential "https://ghe.test"]');
      expect(run.gitconfig).toContain(`helper = !${run.tokenBin} git-credential`);
      expect(run.gitconfig).not.toContain(PAT);
      expect(run.linked).not.toBeNull();
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "no App on the API: the PAT path is unchanged and a stale wrapper link is removed",
    async () => {
      mode = "unconfigured";
      const run = await runBlock({ GITHUB_TOKEN: PAT }, true);
      expectChildOk(run.result, "auth block");
      expect(run.ghCalls).toEqual(["auth setup-git"]);
      expect(run.gitconfig).not.toContain("credential");
      expect(run.linked).toBeNull();
      expect(run.result.stdout).not.toContain("GitHub App worker auth");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "no AGENT_ID: no probe, PAT path",
    async () => {
      const run = await runBlock({ GITHUB_TOKEN: PAT, AGENT_ID: "" });
      expectChildOk(run.result, "auth block");
      expect(calls).toBe(0);
      expect(run.ghCalls).toEqual(["auth setup-git"]);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
