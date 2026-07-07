import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ensureRepoForTask, isFirstKickoffTask } from "../commands/runner";

const execFileAsync = promisify(execFile);

let tempRoot = "";

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "GIT_CONFIG_NOSYSTEM" || key.startsWith("GIT_TRACE")) continue;
    if (key.startsWith("GIT_")) delete env[key];
  }
  return env;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { env: gitEnv() });
  return stdout;
}

async function gitRaw(args: string[]): Promise<void> {
  await execFileAsync("git", args, { env: gitEnv() });
}

async function withCleanGitEnv<T>(fn: () => Promise<T>): Promise<T> {
  const removed = new Map<string, string>();
  for (const key of Object.keys(process.env)) {
    if (key === "GIT_CONFIG_NOSYSTEM" || key.startsWith("GIT_TRACE")) continue;
    if (!key.startsWith("GIT_")) continue;
    const value = process.env[key];
    if (value !== undefined) removed.set(key, value);
    delete process.env[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of removed) {
      process.env[key] = value;
    }
  }
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-m", message]);
}

async function configureIdentity(cwd: string): Promise<void> {
  await git(cwd, ["config", "user.email", "test@example.com"]);
  await git(cwd, ["config", "user.name", "Test User"]);
}

describe("ensureRepoForTask auto-stash refresh", () => {
  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "swarm-runner-autostash-"));
  });

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("stashes dirty work with a swarm-autostash name before refreshing from origin", async () => {
    const remotePath = join(tempRoot, "remote.git");
    const upstreamPath = join(tempRoot, "upstream");
    const clonePath = join(tempRoot, "clone");

    await gitRaw(["init", "--bare", remotePath]);
    await mkdir(upstreamPath);
    await git(upstreamPath, ["init", "-b", "main"]);
    await configureIdentity(upstreamPath);
    await writeFile(join(upstreamPath, "README.md"), "initial\n");
    await commitAll(upstreamPath, "initial commit");
    await git(upstreamPath, ["remote", "add", "origin", remotePath]);
    await git(upstreamPath, ["push", "-u", "origin", "main"]);

    await gitRaw(["clone", "--branch", "main", remotePath, clonePath]);
    await configureIdentity(clonePath);
    await writeFile(join(clonePath, "README.md"), "local dirty change\n");
    await writeFile(join(clonePath, "untracked.txt"), "local untracked\n");

    await writeFile(join(upstreamPath, "remote.txt"), "remote change\n");
    await commitAll(upstreamPath, "remote update");
    await git(upstreamPath, ["push", "origin", "main"]);

    const result = await withCleanGitEnv(() =>
      ensureRepoForTask(
        { url: remotePath, name: "repo", clonePath, defaultBranch: "main" },
        "test",
      ),
    );

    expect(result.warning).toBeNull();
    expect(result.autoStashes).toHaveLength(1);
    expect(result.autoStashes[0]?.ref).toMatch(/^stash@\{\d+\}$/);
    expect(result.autoStashes[0]?.message).toContain("swarm-autostash main ");
    expect(await readFile(join(clonePath, "remote.txt"), "utf8")).toBe("remote change\n");
    expect((await git(clonePath, ["status", "--porcelain"])).trim()).toBe("");

    const stashList = await git(clonePath, ["stash", "list"]);
    expect(stashList).toContain("swarm-autostash main ");
    expect(stashList).toContain("On main:");
  });

  test("merges a clean divergent checkout with origin without hard reset", async () => {
    const remotePath = join(tempRoot, "remote.git");
    const upstreamPath = join(tempRoot, "upstream");
    const clonePath = join(tempRoot, "clone");

    await gitRaw(["init", "--bare", remotePath]);
    await mkdir(upstreamPath);
    await git(upstreamPath, ["init", "-b", "main"]);
    await configureIdentity(upstreamPath);
    await writeFile(join(upstreamPath, "README.md"), "initial\n");
    await commitAll(upstreamPath, "initial commit");
    await git(upstreamPath, ["remote", "add", "origin", remotePath]);
    await git(upstreamPath, ["push", "-u", "origin", "main"]);

    await gitRaw(["clone", "--branch", "main", remotePath, clonePath]);
    await configureIdentity(clonePath);
    await writeFile(join(clonePath, "local.txt"), "local commit\n");
    await commitAll(clonePath, "local commit");

    await writeFile(join(upstreamPath, "remote.txt"), "remote commit\n");
    await commitAll(upstreamPath, "remote commit");
    await git(upstreamPath, ["push", "origin", "main"]);

    const result = await withCleanGitEnv(() =>
      ensureRepoForTask(
        { url: remotePath, name: "repo", clonePath, defaultBranch: "main" },
        "test",
      ),
    );

    expect(result.warning).toBeNull();
    expect(result.autoStashes).toEqual([]);
    expect(await readFile(join(clonePath, "local.txt"), "utf8")).toBe("local commit\n");
    expect(await readFile(join(clonePath, "remote.txt"), "utf8")).toBe("remote commit\n");
    expect((await git(clonePath, ["status", "--porcelain"])).trim()).toBe("");
  });

  test("first kickoff hard-resets a leftover feature branch back to origin/default", async () => {
    const remotePath = join(tempRoot, "remote.git");
    const upstreamPath = join(tempRoot, "upstream");
    const clonePath = join(tempRoot, "clone");

    await gitRaw(["init", "--bare", remotePath]);
    await mkdir(upstreamPath);
    await git(upstreamPath, ["init", "-b", "main"]);
    await configureIdentity(upstreamPath);
    await writeFile(join(upstreamPath, "README.md"), "initial\n");
    await commitAll(upstreamPath, "initial commit");
    await git(upstreamPath, ["remote", "add", "origin", remotePath]);
    await git(upstreamPath, ["push", "-u", "origin", "main"]);

    await gitRaw(["clone", "--branch", "main", remotePath, clonePath]);
    await configureIdentity(clonePath);

    // Simulate a prior task leaving a diverged feature branch checked out —
    // this is the scenario that used to abort the merge and strand the repo.
    await git(clonePath, ["checkout", "-b", "leftover-feature"]);
    await writeFile(join(clonePath, "feature.txt"), "leftover work\n");
    await commitAll(clonePath, "leftover feature commit");

    await writeFile(join(upstreamPath, "remote.txt"), "remote commit\n");
    await commitAll(upstreamPath, "remote commit");
    await git(upstreamPath, ["push", "origin", "main"]);

    const result = await withCleanGitEnv(() =>
      ensureRepoForTask(
        { url: remotePath, name: "repo", clonePath, defaultBranch: "main" },
        "test",
        true,
      ),
    );

    expect(result.warning).toBeNull();
    expect((await git(clonePath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("main");
    expect((await git(clonePath, ["rev-parse", "HEAD"])).trim()).toBe(
      (await git(upstreamPath, ["rev-parse", "HEAD"])).trim(),
    );
    expect(await readFile(join(clonePath, "remote.txt"), "utf8")).toBe("remote commit\n");
    expect((await git(clonePath, ["status", "--porcelain"])).trim()).toBe("");
  });

  test("resume/continuation (isFirstKickoff=false) leaves a leftover feature branch checked out", async () => {
    const remotePath = join(tempRoot, "remote.git");
    const upstreamPath = join(tempRoot, "upstream");
    const clonePath = join(tempRoot, "clone");

    await gitRaw(["init", "--bare", remotePath]);
    await mkdir(upstreamPath);
    await git(upstreamPath, ["init", "-b", "main"]);
    await configureIdentity(upstreamPath);
    await writeFile(join(upstreamPath, "README.md"), "initial\n");
    await commitAll(upstreamPath, "initial commit");
    await git(upstreamPath, ["remote", "add", "origin", remotePath]);
    await git(upstreamPath, ["push", "-u", "origin", "main"]);

    await gitRaw(["clone", "--branch", "main", remotePath, clonePath]);
    await configureIdentity(clonePath);

    await git(clonePath, ["checkout", "-b", "in-progress-feature"]);
    await writeFile(join(clonePath, "feature.txt"), "in-progress work\n");
    await commitAll(clonePath, "in-progress feature commit");

    const result = await withCleanGitEnv(() =>
      ensureRepoForTask(
        { url: remotePath, name: "repo", clonePath, defaultBranch: "main" },
        "test",
        false,
      ),
    );

    expect(result.warning).toBeNull();
    expect((await git(clonePath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe(
      "in-progress-feature",
    );
    expect(await readFile(join(clonePath, "feature.txt"), "utf8")).toBe("in-progress work\n");
  });
});

describe("isFirstKickoffTask", () => {
  test("a feature task with a parentTaskId but an inactive/unknown parent is still a first kickoff", async () => {
    expect(
      await isFirstKickoffTask({ parentTaskId: "parent-1", taskType: "feature" }, async () => null),
    ).toBe(true);
  });

  test("a pr-fix task with a parentTaskId but an inactive/unknown parent is still a first kickoff", async () => {
    expect(
      await isFirstKickoffTask({ parentTaskId: "parent-1", taskType: "pr-fix" }, async () => null),
    ).toBe(true);
  });

  test("a parentTaskId with no status-checker at all is still a first kickoff (taskType alone decides)", async () => {
    expect(await isFirstKickoffTask({ parentTaskId: "parent-1", taskType: "feature" })).toBe(true);
  });

  test("an explicit resume task is never a first kickoff", async () => {
    expect(await isFirstKickoffTask({ taskType: "resume" })).toBe(false);
  });

  test("a brand-new top-level task with no fields at all is a first kickoff", async () => {
    expect(await isFirstKickoffTask({})).toBe(true);
  });

  test("undefined/null task is a first kickoff (safe default)", async () => {
    expect(await isFirstKickoffTask(undefined)).toBe(true);
    expect(await isFirstKickoffTask(null)).toBe(true);
  });

  test("known continuation task types are never a first kickoff, regardless of parent status", async () => {
    const continuationTypes = [
      "follow-up",
      "reroute-decision",
      "agentmail-reply",
      "github-comment",
      "github-review",
      "gitlab-comment",
      "gitlab-ci",
    ];
    for (const taskType of continuationTypes) {
      expect(
        await isFirstKickoffTask({ parentTaskId: "parent-1", taskType }, async () => null),
      ).toBe(false);
    }
  });

  test("a genuinely new root task type (e.g. agentmail-message, no reserved taskType) stays a first kickoff", async () => {
    expect(await isFirstKickoffTask({ taskType: "agentmail-message" }, async () => null)).toBe(
      true,
    );
  });

  // Regression: a parent-linked NON-resume follow-up (Slack follow-ups and
  // sibling-awareness both wire parentTaskId with no reserved taskType at
  // all) must NOT take the hard-reset path when the parent it's continuing
  // is still active — e.g. an in-progress sibling on the same worker with
  // maxTasks > 1, or a paused task that may resume onto the same clone.
  test("a Slack-style follow-up (no distinguishing taskType) with an in-progress parent is NOT a first kickoff", async () => {
    const fetchParentTaskStatus = async (parentTaskId: string) => {
      expect(parentTaskId).toBe("active-parent-1");
      return "in_progress";
    };
    expect(
      await isFirstKickoffTask({ parentTaskId: "active-parent-1" }, fetchParentTaskStatus),
    ).toBe(false);
  });

  test("a sibling-awareness-linked task with a paused parent is NOT a first kickoff", async () => {
    expect(
      await isFirstKickoffTask(
        { parentTaskId: "paused-parent-1", taskType: "github-pr" },
        async () => "paused",
      ),
    ).toBe(false);
  });

  test("a parent-linked task whose parent already completed IS a first kickoff", async () => {
    expect(
      await isFirstKickoffTask(
        { parentTaskId: "done-parent-1", taskType: "feature" },
        async () => "completed",
      ),
    ).toBe(true);
  });
});
