import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRepoForTask } from "../commands/runner";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

let tempRoot = "";

function gitEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return env;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runChild(["git", "-C", cwd, ...args], { env: gitEnv() });
  return expectChildOk(result, `git ${args.join(" ")}`).stdout;
}

async function makeUpstream(withFiles: Record<string, string>): Promise<string> {
  const upstream = join(tempRoot, "upstream");
  await mkdir(upstream, { recursive: true });
  await git(upstream, ["init", "-b", "main"]);
  await git(upstream, ["config", "user.email", "test@example.com"]);
  await git(upstream, ["config", "user.name", "Test User"]);
  for (const [name, content] of Object.entries(withFiles)) {
    await mkdir(join(upstream, name, ".."), { recursive: true });
    await writeFile(join(upstream, name), content);
  }
  await git(upstream, ["add", "."]);
  await git(upstream, ["commit", "-m", "initial"]);
  return upstream;
}

describe("repo clone arguments and hook install", () => {
  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "swarm-runner-clone-args-"));
  });

  afterEach(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  test(
    "refuses a url or clonePath that starts with a dash and still clones a normal repo",
    async () => {
      const upstream = await makeUpstream({ "README.md": "hello\n" });

      const badUrl = await ensureRepoForTask(
        {
          url: "--upload-pack=touch",
          name: "bad",
          clonePath: join(tempRoot, "bad"),
          defaultBranch: "main",
        },
        "test",
      );
      expect(badUrl.warning).toContain('must not start with "-"');
      expect(badUrl.clonePath).toBe("");

      const badPath = await ensureRepoForTask(
        { url: upstream, name: "bad", clonePath: "--template=x", defaultBranch: "main" },
        "test",
      );
      expect(badPath.warning).toContain('must not start with "-"');

      const clonePath = join(tempRoot, "clone");
      const ok = await ensureRepoForTask(
        { url: upstream, name: "ok", clonePath, defaultBranch: "main" },
        "test",
      );
      expect(ok.warning).toBeNull();
      expect(ok.clonePath).toBe(clonePath);
      expect(existsSync(join(clonePath, "README.md"))).toBe(true);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test.each([
    ["8.0.3", ".husky"],
    ["9.1.7", ".husky/_"],
  ])(
    "installs Husky %s hooks without running lifecycle scripts",
    async (version, hooksPath) => {
      const marker = join(tempRoot, "lifecycle-ran");
      const upstream = await makeUpstream({
        ".husky/pre-commit": "echo pre-commit\n",
        "fake-husky/package.json": JSON.stringify({
          name: "husky",
          version,
          bin: { husky: "bin.sh" },
          scripts: { install: `touch ${marker}` },
        }),
        "fake-husky/bin.sh": `#!/bin/sh
case "$#:$*" in
  0:) git config core.hooksPath .husky/_ ;;
  1:install) git config core.hooksPath .husky ;;
  *) exit 1 ;;
esac
`,
        "package.json": JSON.stringify({
          name: "fixture",
          version: "1.0.0",
          scripts: { prepare: `touch ${marker}`, postinstall: `touch ${marker}` },
          devDependencies: { husky: "file:./fake-husky" },
        }),
      });
      await runChild(["chmod", "+x", join(upstream, "fake-husky/bin.sh")]);

      const result = await runChild(
        ["bash", join(process.cwd(), "scripts/install-repo-hooks.sh"), upstream, "fixture"],
        { env: { ...gitEnv(), npm_config_offline: "true", npm_config_audit: "false" } },
      );
      expectChildOk(result, "install-repo-hooks.sh");

      expect(existsSync(marker)).toBe(false);
      expect((await git(upstream, ["config", "--get", "core.hooksPath"])).trim()).toBe(hooksPath);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
