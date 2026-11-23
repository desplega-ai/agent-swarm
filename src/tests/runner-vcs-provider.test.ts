import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

const BRANCH = "feature/vcs-link";
let repoDir: string;
let binDir: string;

async function git(...args: string[]): Promise<void> {
  expectChildOk(await runChild(["git", "-C", repoDir, ...args]), `git ${args.join(" ")}`);
}

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "runner-vcs-provider-"));
  binDir = join(repoDir, "bin");
  await mkdir(binDir);
  await git("init", "--quiet", "--initial-branch", BRANCH);
  await git("remote", "add", "origin", "https://example.invalid/acme/repo.git");

  for (const cli of ["gh", "glab"]) {
    await writeFile(
      join(binDir, cli),
      `#!/bin/sh\nprintf '%s %s\\n' '${cli}' "$*" >> "$VCS_CALL_LOG"\nprintf '%s\\n' '[]'\n`,
      { mode: 0o755 },
    );
  }
}, CHILD_PROCESS_TEST_BUDGET_MS);

afterAll(async () => {
  if (repoDir) await rm(repoDir, { recursive: true, force: true });
});

test.each([
  ["https://gitlab.com/acme/github-sync.git", "glab mr list --source-branch", ""],
  ["https://github.com/acme/gitlab-tools.git", "gh pr list --head", ""],
  ["https://gitlab.example.com/acme/repo.git", "gh pr list --head", "https://gitlab.example.com"],
] as const)(
  "task PR lookup for %s uses %s",
  async (remoteUrl, command, githubUrl) => {
    await git("remote", "set-url", "origin", remoteUrl);
    const callLog = join(repoDir, crypto.randomUUID());
    expectChildOk(
      await runChild(
        [
          process.execPath,
          "-e",
          `import { detectVcsForTask } from "./src/commands/runner.ts";
           await detectVcsForTask("http://swarm.invalid", "", "test-task", process.argv[1]);`,
          repoDir,
        ],
        {
          cwd: join(import.meta.dir, "../.."),
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
            GITHUB_URL: githubUrl,
            GITHUB_API_URL: "",
            VCS_CALL_LOG: callLog,
          },
        },
      ),
      "task PR lookup",
    );
    const calls = (await Bun.file(callLog).text()).trimEnd().split("\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toStartWith(`${command} ${BRANCH} `);
  },
  CHILD_PROCESS_TEST_BUDGET_MS,
);
