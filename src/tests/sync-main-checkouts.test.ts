import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const script = join(import.meta.dir, "../../scripts/sync-main-checkouts.sh");
let root = "";

async function run(command: string, args: string[], cwd?: string) {
  return exec(command, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}
async function git(cwd: string, ...args: string[]) {
  return (await run("git", ["-C", cwd, ...args])).stdout.trim();
}
async function commit(cwd: string, message: string) {
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", message);
}

async function setup() {
  const remote = join(root, "remote.git");
  const upstream = join(root, "upstream");
  const checkouts = join(root, "checkouts");
  await run("git", ["init", "--bare", remote]);
  await mkdir(upstream);
  await git(upstream, "init", "-b", "main");
  await git(upstream, "config", "user.email", "test@example.com");
  await git(upstream, "config", "user.name", "Test");
  await writeFile(join(upstream, "README"), "one\n");
  await commit(upstream, "initial");
  await git(upstream, "remote", "add", "origin", remote);
  await git(upstream, "push", "-u", "origin", "main");
  await mkdir(checkouts);
  return { remote, upstream, checkouts };
}
async function clone(remote: string, checkouts: string, name: string) {
  const path = join(checkouts, name);
  await run("git", ["clone", "--branch", "main", remote, path]);
  return path;
}
async function advance(upstream: string) {
  await writeFile(join(upstream, "next"), "next\n");
  await commit(upstream, "next");
  await git(upstream, "push", "origin", "main");
  return git(upstream, "rev-parse", "HEAD");
}
async function sync(checkouts: string) {
  try {
    const result = await run(script, [checkouts]);
    return { code: 0, stdout: result.stdout };
  } catch (error: any) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "" };
  }
}

describe("sync-main-checkouts", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "swarm-main-sync-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("fast-forwards a clean checked-out main and emits a green receipt", async () => {
    const { remote, upstream, checkouts } = await setup();
    const checkout = await clone(remote, checkouts, "main");
    const expected = await advance(upstream);
    const result = await sync(checkouts);
    expect(result.code).toBe(0);
    expect(await git(checkout, "rev-parse", "HEAD")).toBe(expected);
    expect(JSON.parse(result.stdout).status).toBe("green");
  });

  test("only advances main when a feature branch has dirty work", async () => {
    const { remote, upstream, checkouts } = await setup();
    const checkout = await clone(remote, checkouts, "feature");
    await git(checkout, "checkout", "-b", "feature");
    await writeFile(join(checkout, "README"), "dirty feature\n");
    const beforeHead = await git(checkout, "rev-parse", "HEAD");
    const beforeStatus = await git(checkout, "status", "--porcelain");
    const expected = await advance(upstream);
    const result = await sync(checkouts);
    expect(result.code).toBe(0);
    expect(await git(checkout, "rev-parse", "HEAD")).toBe(beforeHead);
    expect(await git(checkout, "rev-parse", "main")).toBe(expected);
    expect(await git(checkout, "status", "--porcelain")).toBe(beforeStatus);
    expect(await readFile(join(checkout, "README"), "utf8")).toBe("dirty feature\n");
  });

  test("fails closed for dirty checked-out main, symlinks, and non-git entries", async () => {
    const { remote, upstream, checkouts } = await setup();
    const checkout = await clone(remote, checkouts, "dirty-main");
    const outside = await clone(remote, root, "outside");
    await advance(upstream);
    await writeFile(join(checkout, "README"), "dirty main\n");
    await mkdir(join(checkouts, "not-git"));
    await symlink(outside, join(checkouts, "linked"));
    const result = await sync(checkouts);
    expect(result.code).toBe(1);
    expect(await git(checkout, "rev-parse", "HEAD")).not.toBe(
      await git(upstream, "rev-parse", "HEAD"),
    );
    expect(result.stdout).toContain("checked-out-main-dirty");
    expect(result.stdout).toContain("symlink-not-followed");
    expect(result.stdout).toContain("not-a-git-worktree");
  });

  test("rejects a divergent local main without changing it", async () => {
    const { remote, upstream, checkouts } = await setup();
    const checkout = await clone(remote, checkouts, "diverged");
    await git(checkout, "config", "user.email", "test@example.com");
    await git(checkout, "config", "user.name", "Test");
    await writeFile(join(checkout, "local"), "local\n");
    await commit(checkout, "local");
    const before = await git(checkout, "rev-parse", "main");
    await advance(upstream);
    const result = await sync(checkouts);
    expect(result.code).toBe(1);
    expect(await git(checkout, "rev-parse", "main")).toBe(before);
    expect(result.stdout).toContain("local-main-diverged");
  });
});
