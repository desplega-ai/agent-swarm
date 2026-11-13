import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { checkCompletedProcesses, type RunnerState, type RunningTask } from "../commands/runner";
import {
  type ActiveTaskRef,
  resolveWorktreeReaperConfig,
  WorktreeReaper,
  type WorktreeReaperConfig,
} from "../commands/worktree-reaper";

const execFileAsync = promisify(execFile);
const HOUR = 3_600_000;

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return env;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "-C",
      cwd,
      ...args,
    ],
    { env: gitEnv() },
  );
  return stdout.trim();
}

let root = "";
let repo = "";
let config: WorktreeReaperConfig;
let statuses: Map<string, string | null>;
let cwds: string[];
let clock: number;
let logs: Array<Record<string, unknown>>;

function reaper(): WorktreeReaper {
  return new WorktreeReaper({
    ledgerPath: join(root, ".swarm", "worktree-ledger.json"),
    scanRoots: [root],
    getConfig: () => config,
    statusOf: async (taskId) =>
      statuses.has(taskId) ? (statuses.get(taskId) ?? null) : "completed",
    log: (line) => logs.push(JSON.parse(line)),
    now: () => clock,
    processCwds: async () => cwds,
  });
}

async function addWorktree(name: string, args: string[] = ["--detach"]): Promise<string> {
  const path = join(root, "worktrees", name);
  await git(repo, ["worktree", "add", ...args, path, "origin/main"]);
  return path;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function listTree(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).sort();
}

/** A worktree created while `taskId` ran, then the task ended. */
async function worktreeOfEndedTask(
  r: WorktreeReaper,
  name: string,
  taskId: string,
  args?: string[],
) {
  await r.observe([{ taskId }]);
  const path = await addWorktree(name, args);
  await r.observe([{ taskId }]);
  return path;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktree-reaper-"));
  repo = join(root, "repo");
  const origin = join(root, "origin.git");
  await execFileAsync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: gitEnv() });
  await execFileAsync("git", ["clone", "-q", origin, repo], { env: gitEnv() });
  await writeFile(join(repo, ".gitignore"), "/node_modules\n");
  await mkdir(join(repo, "vendor", "node_modules"), { recursive: true });
  await writeFile(join(repo, "vendor", "node_modules", "tracked.js"), "x\n");
  await writeFile(join(repo, "README.md"), "hi\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "init"]);
  await git(repo, ["push", "-q", "-u", "origin", "HEAD:main"]);
  await git(repo, ["remote", "set-head", "origin", "main"]);
  config = { mode: "on", ttlHours: 72, sweepIntervalMinutes: 60, extraRoots: [] };
  statuses = new Map();
  cwds = [];
  clock = Date.now();
  logs = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveWorktreeReaperConfig", () => {
  test("defaults to dry-run, 72h TTL, hourly sweeps", () => {
    expect(resolveWorktreeReaperConfig({})).toEqual({
      mode: "dry-run",
      ttlHours: 72,
      sweepIntervalMinutes: 60,
      extraRoots: [],
    });
  });

  test("parses, clamps and falls back on invalid values", () => {
    const cfg = resolveWorktreeReaperConfig({
      WORKTREE_REAPER_MODE: " ON ",
      WORKTREE_TTL_HOURS: "0",
      WORKTREE_SWEEP_INTERVAL_MINUTES: "nope",
      WORKTREE_REAPER_EXTRA_ROOTS: "/a, ,/b",
    });
    expect(cfg).toEqual({
      mode: "on",
      ttlHours: 1,
      sweepIntervalMinutes: 60,
      extraRoots: ["/a", "/b"],
    });
    expect(resolveWorktreeReaperConfig({ WORKTREE_REAPER_MODE: "yes" }).mode).toBe("dry-run");
  });

  test("a provider with no local filesystem forces off", () => {
    expect(resolveWorktreeReaperConfig({ WORKTREE_REAPER_MODE: "on" }, false).mode).toBe("off");
  });
});

describe("WorktreeReaper decisions", () => {
  test("removes a detached worktree when its only owner ended (rule 9)", async () => {
    const r = reaper();
    const path = await worktreeOfEndedTask(r, "review", "A");
    const { decisions } = await r.onTaskEnded("A", []);
    expect(decisions.map((d) => [d.action, d.reason])).toEqual([["remove", "owners-ended"]]);
    expect(await exists(path)).toBe(false);
    expect(await git(repo, ["worktree", "list"])).not.toContain(path);
  });

  test("never touches the main worktree or a bare repo's worktrees (rule 1)", async () => {
    const bare = join(root, "bare.git");
    await execFileAsync("git", ["clone", "-q", "--bare", join(root, "origin.git"), bare], {
      env: gitEnv(),
    });
    const bareWt = join(root, "bare-wt");
    await git(bare, ["worktree", "add", "--detach", bareWt, "main"]);
    config.extraRoots = [bare];
    const r = reaper();
    await r.sweep([]);
    clock += 1000 * HOUR;
    const { decisions } = await r.sweep([]);
    expect(decisions.map((d) => d.path)).not.toContain(repo);
    expect(await exists(join(repo, ".git"))).toBe(true);
    expect(await exists(bareWt)).toBe(true);
  });

  test("keeps a locked worktree (rule 2)", async () => {
    const r = reaper();
    const path = await worktreeOfEndedTask(r, "keep", "A");
    await git(repo, ["worktree", "lock", "--reason", "keep: PR #1", path]);
    const { decisions } = await r.onTaskEnded("A", []);
    expect(decisions[0]?.reason).toBe("locked");
    expect(await exists(path)).toBe(true);
  });

  test("keeps a worktree an active task or a process uses (rule 3)", async () => {
    const r = reaper();
    const path = await worktreeOfEndedTask(r, "busy", "A");
    const sibling: ActiveTaskRef = { taskId: "B", workingDir: join(path, "sub") };
    expect((await r.onTaskEnded("A", [sibling])).decisions[0]?.reason).toBe("in-use");
    cwds = [path];
    expect((await r.onTaskEnded("A", [])).decisions[0]?.reason).toBe("in-use");
    expect(await exists(path)).toBe(true);
  });

  test("holds tracked changes and unpushed commits (rules 4, 5)", async () => {
    const r = reaper();
    const dirty = await worktreeOfEndedTask(r, "dirty", "A");
    await writeFile(join(dirty, "README.md"), "edited\n");
    const unpushed = await addWorktree("unpushed", ["-b", "local"]);
    await git(unpushed, ["commit", "-q", "--allow-empty", "-m", "wip"]);
    await r.observe([{ taskId: "A" }]);
    const reasons = Object.fromEntries(
      (await r.onTaskEnded("A", [])).decisions.map((d) => [d.path, d.reason]),
    );
    expect(reasons).toEqual({ [dirty]: "dirty", [unpushed]: "unpushed" });
    expect(await exists(dirty)).toBe(true);
    expect(await exists(unpushed)).toBe(true);
  });

  test("keeps a worktree whose owner is still active or unknown (rule 6)", async () => {
    const r = reaper();
    const path = await worktreeOfEndedTask(r, "owned", "A");
    statuses.set("A", "in_progress");
    expect((await r.onTaskEnded("A", [])).decisions[0]?.reason).toBe("owner-active");
    statuses.set("A", null);
    expect((await r.onTaskEnded("A", [])).decisions[0]?.reason).toBe("owner-active");
    expect(await exists(path)).toBe(true);
  });

  test("keeps a pushed feature branch until the TTL (rule 7)", async () => {
    const r = reaper();
    const path = await worktreeOfEndedTask(r, "feat", "A", ["-b", "feat"]);
    await git(path, ["commit", "-q", "--allow-empty", "-m", "feat"]);
    await git(path, ["push", "-q", "-u", "origin", "feat"]);
    expect((await r.onTaskEnded("A", [])).decisions[0]?.reason).toBe("pushed-branch");
    clock += 73 * HOUR;
    const { decisions } = await r.sweep([]);
    expect(decisions.map((d) => [d.action, d.reason])).toEqual([["remove", "owners-ended"]]);
    expect(await exists(path)).toBe(false);
  });

  test("a branch tracking the default branch is not a pushed branch", async () => {
    const r = reaper();
    const path = await worktreeOfEndedTask(r, "fresh", "A", ["-b", "fresh"]);
    expect((await r.onTaskEnded("A", [])).decisions[0]?.action).toBe("remove");
    expect(await exists(path)).toBe(false);
  });

  test("pre-existing worktrees go only to the TTL sweep (rules 8, 9)", async () => {
    const path = await addWorktree("old");
    const r = reaper();
    expect((await r.sweep([])).decisions.map((d) => d.reason)).toEqual(["young"]);
    clock += 73 * HOUR;
    expect((await r.sweep([])).decisions.map((d) => [d.action, d.reason])).toEqual([
      ["remove", "ttl"],
    ]);
    expect(await exists(path)).toBe(false);
  });

  test("waits for every concurrent candidate to end", async () => {
    const r = reaper();
    await r.observe([{ taskId: "A" }, { taskId: "B" }]);
    const path = await addWorktree("shared");
    await r.observe([{ taskId: "A" }, { taskId: "B" }]);
    statuses.set("B", "in_progress");
    expect((await r.onTaskEnded("A", [{ taskId: "B" }])).decisions[0]?.reason).toBe("owner-active");
    statuses.set("B", "completed");
    expect((await r.onTaskEnded("B", [])).decisions[0]?.action).toBe("remove");
    expect(await exists(path)).toBe(false);
  });
});

describe("WorktreeReaper slim, dry-run, ledger", () => {
  test("slims only ignored node_modules of a held worktree past the TTL", async () => {
    const r = reaper();
    const path = await worktreeOfEndedTask(r, "held", "A");
    await writeFile(join(path, "README.md"), "edited\n");
    await mkdir(join(path, "node_modules", "dep"), { recursive: true });
    await writeFile(join(path, "node_modules", "dep", "index.js"), "x\n");
    await r.onTaskEnded("A", []);
    expect(await exists(join(path, "node_modules"))).toBe(true);
    clock += 73 * HOUR;
    const { decisions } = await r.sweep([]);
    expect(decisions.map((d) => [d.action, d.reason])).toEqual([["slim", "held-dirty"]]);
    expect(await exists(join(path, "node_modules"))).toBe(false);
    expect(await exists(join(path, "vendor", "node_modules", "tracked.js"))).toBe(true);
    expect(await exists(join(path, "README.md"))).toBe(true);
  });

  test("dry-run leaves every worktree and node_modules byte-identical", async () => {
    config.mode = "dry-run";
    const r = reaper();
    const removable = await worktreeOfEndedTask(r, "removable", "A");
    const held = await addWorktree("held");
    await r.observe([{ taskId: "A" }]);
    await writeFile(join(held, "README.md"), "edited\n");
    await mkdir(join(held, "node_modules", "dep"), { recursive: true });
    await writeFile(join(held, "node_modules", "dep", "index.js"), "x\n");
    const before = await listTree(join(root, "worktrees"));
    const ended = await r.onTaskEnded("A", []);
    clock += 73 * HOUR;
    const swept = await r.sweep([]);
    expect(await listTree(join(root, "worktrees"))).toEqual(before);
    expect(ended.decisions.find((d) => d.path === removable)?.action).toBe("would-remove");
    expect(swept.decisions.find((d) => d.path === held)?.action).toBe("would-slim");
    expect(logs.some((l) => l.action === "would-remove" && l.path === removable)).toBe(true);
  });

  test("off mode does nothing", async () => {
    config.mode = "off";
    const r = reaper();
    await addWorktree("x");
    await r.observe([{ taskId: "A" }]);
    expect((await r.sweep([])).decisions).toEqual([]);
    expect(await exists(join(root, ".swarm"))).toBe(false);
  });

  test("the ledger survives a restart and a corrupt one is set aside", async () => {
    const path = await worktreeOfEndedTask(reaper(), "persisted", "A");
    // A fresh instance (runner restart) still attributes the worktree to A.
    expect((await reaper().onTaskEnded("A", [])).decisions[0]?.action).toBe("remove");
    expect(await exists(path)).toBe(false);

    const other = await addWorktree("after-corrupt");
    await writeFile(join(root, ".swarm", "worktree-ledger.json"), "{not json");
    const r = reaper();
    expect((await r.onTaskEnded("A", [{ taskId: "A" }])).decisions).toEqual([]);
    expect((await readdir(join(root, ".swarm"))).some((f) => f.includes(".corrupt-"))).toBe(true);
    expect((await r.sweep([])).decisions.map((d) => [d.path, d.reason])).toEqual([
      [other, "young"],
    ]);
  });

  test("finishes an interrupted removal and leaves a damaged worktree alone", async () => {
    const r = reaper();
    const interrupted = await worktreeOfEndedTask(r, "interrupted", "A");
    const damaged = await addWorktree("damaged");
    await r.observe([{ taskId: "A" }]);
    const ledgerPath = join(root, ".swarm", "worktree-ledger.json");
    const ledger = await Bun.file(ledgerPath).json();
    ledger.entries[interrupted].removingAt = new Date(clock).toISOString();
    await Bun.write(ledgerPath, JSON.stringify(ledger));
    await rm(join(interrupted, ".git"));
    await rm(join(damaged, ".git"));

    const { decisions } = await reaper().sweep([]);
    const reasons = Object.fromEntries(decisions.map((d) => [d.path, [d.action, d.reason]]));
    expect(reasons[interrupted]).toEqual(["finish-remove", "interrupted-remove"]);
    expect(reasons[damaged]).toEqual(["skip", "broken"]);
    expect(await exists(interrupted)).toBe(false);
    expect(await exists(damaged)).toBe(true);
  });
});

test("checkCompletedProcesses hands the ended task to the reaper with the sibling's dir protected", async () => {
  const onTaskEnded = mock(async () => ({ decisions: [] }));
  const runner: RunnerState = {
    activeTasks: new Map(),
    maxConcurrent: 2,
    startedAt: Date.now(),
    tasksProcessed: 0,
    harnessProvider: "claude",
    codexCreditsExhaustedCooldownMs: 0,
    modelWindowBlocks: new Map(),
    worktreeReaper: { onTaskEnded } as unknown as WorktreeReaper,
  };
  const ended = crypto.randomUUID();
  const sibling = crypto.randomUUID();
  runner.activeTasks.set(ended, {
    taskId: ended,
    result: { exitCode: 0 },
    triggerType: "task_assigned",
    startTime: new Date(),
    harnessProvider: "claude",
    hasLocalEnvironment: false,
    serverTerminalStatus: "completed",
    workingDir: "/workspace/personal/worktrees/ended",
  } as RunningTask);
  runner.activeTasks.set(sibling, {
    taskId: sibling,
    result: null,
    workingDir: "/workspace/personal/worktrees/sibling",
  } as RunningTask);
  await checkCompletedProcesses(runner, "worker");
  expect(onTaskEnded).toHaveBeenCalledTimes(1);
  expect(onTaskEnded).toHaveBeenCalledWith(ended, [
    { taskId: sibling, workingDir: "/workspace/personal/worktrees/sibling" },
  ]);
});
