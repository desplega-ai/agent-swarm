import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ensureRepoForTask } from "../commands/runner";

const execFileAsync = promisify(execFile);

let tempRoot = "";

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout;
}

async function gitRaw(args: string[]): Promise<void> {
  await execFileAsync("git", args);
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

    const result = await ensureRepoForTask(
      { url: remotePath, name: "repo", clonePath, defaultBranch: "main" },
      "test",
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

    const result = await ensureRepoForTask(
      { url: remotePath, name: "repo", clonePath, defaultBranch: "main" },
      "test",
    );

    expect(result.warning).toBeNull();
    expect(result.autoStashes).toEqual([]);
    expect(await readFile(join(clonePath, "local.txt"), "utf8")).toBe("local commit\n");
    expect(await readFile(join(clonePath, "remote.txt"), "utf8")).toBe("remote commit\n");
    expect((await git(clonePath, ["status", "--porcelain"])).trim()).toBe("");
  });
});
