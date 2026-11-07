/**
 * Regression test for scripts/deploy-guard.sh, the "guard" step of
 * .github/workflows/docker-and-deploy.yml.
 *
 * The guard used to skip deploy whenever main had moved past the running
 * commit. A newer docs-only commit starts no docker-and-deploy run, so that
 * stranded prod on an older deploy. Now the guard skips only when the newer
 * commits touch on.push.paths, read from the real workflow file.
 *
 * Each case builds a bare "origin", a shallow runner clone (like
 * actions/checkout), then pushes newer main commits from a second clone and
 * runs the guard in the runner clone.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const GUARD_SCRIPT = join(REPO_ROOT, "scripts/deploy-guard.sh");
const WORKFLOW = ".github/workflows/docker-and-deploy.yml";

// GitHub runners ship yq. Locally, skip without it; in CI a missing yq must fail.
const hasYq = Bun.which("yq") !== null;

const tmpRoots: string[] = [];
afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

const gitEnv: Record<string, string | undefined> = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = expectChildOk(
    await runChild(["git", ...args], { cwd, env: gitEnv }),
    `git ${args.join(" ")}`,
  );
  return r.stdout.trim();
}

function write(dir: string, path: string, content: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

/** Origin with one main commit, a shallow runner checkout of it, and a pusher clone. */
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "deploy-guard-"));
  tmpRoots.push(root);
  const origin = join(root, "origin.git");
  const pusher = join(root, "pusher");
  const runner = join(root, "runner");

  await git(root, "init", "--bare", "-q", "-b", "main", origin);
  await git(root, "clone", "-q", origin, pusher);
  await git(pusher, "checkout", "-q", "-B", "main");
  mkdirSync(join(pusher, ".github/workflows"), { recursive: true });
  copyFileSync(join(REPO_ROOT, WORKFLOW), join(pusher, WORKFLOW));
  write(pusher, "src/index.ts", "export {};\n");
  write(pusher, "README.md", "# repo\n");
  await git(pusher, "add", "-A");
  await git(pusher, "commit", "-q", "-m", "initial");
  await git(pusher, "push", "-q", "origin", "main");

  await git(root, "clone", "-q", "--depth", "1", `file://${origin}`, runner);
  const runningSha = await git(runner, "rev-parse", "HEAD");

  const pushCommit = async (path: string, content: string) => {
    write(pusher, path, content);
    await git(pusher, "add", "-A");
    await git(pusher, "commit", "-q", "-m", `change ${path}`);
    await git(pusher, "push", "-q", "origin", "main");
  };

  const runGuard = async () => {
    const outFile = join(root, `github-output-${Date.now()}`);
    writeFileSync(outFile, "");
    const r = await runChild(["bash", GUARD_SCRIPT], {
      cwd: runner,
      env: { ...gitEnv, GITHUB_SHA: runningSha, GITHUB_OUTPUT: outFile },
    });
    expectChildOk(r, "deploy-guard.sh");
    const match = readFileSync(outFile, "utf8").match(/^is_tip=(true|false)$/m);
    return { isTip: match?.[1], log: r.stdout };
  };

  return { pushCommit, runGuard };
}

describe.skipIf(!hasYq && !process.env.CI)("deploy guard (scripts/deploy-guard.sh)", () => {
  test(
    "deploys when the running commit is still main tip",
    async () => {
      const { runGuard } = await setup();
      expect((await runGuard()).isTip).toBe("true");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "deploys when newer main commits are docs-only",
    async () => {
      const { pushCommit, runGuard } = await setup();
      await pushCommit("README.md", "# repo\n\nmore docs\n");
      await pushCommit("docs-site/content/docs/page.mdx", "docs\n");
      const result = await runGuard();
      expect(result.isTip).toBe("true");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "skips when a newer main commit changes src",
    async () => {
      const { pushCommit, runGuard } = await setup();
      await pushCommit("src/index.ts", "export const x = 1;\n");
      const result = await runGuard();
      expect(result.isTip).toBe("false");
      expect(result.log).toContain("src/index.ts");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "skips when a src change is followed by a docs-only tip",
    async () => {
      const { pushCommit, runGuard } = await setup();
      await pushCommit("src/index.ts", "export const x = 1;\n");
      await pushCommit("README.md", "# repo\n\nmore docs\n");
      expect((await runGuard()).isTip).toBe("false");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "skips on a nested file under a ** trigger path (apps/ui/**)",
    async () => {
      const { pushCommit, runGuard } = await setup();
      await pushCommit("apps/ui/src/components/deep/thing.tsx", "export {};\n");
      expect((await runGuard()).isTip).toBe("false");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
