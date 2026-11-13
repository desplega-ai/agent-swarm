/**
 * Worktree reaper: removes the linked git worktrees that agents create during
 * tasks once every task that could own them has ended, and sweeps the rest on
 * a TTL. Agents create worktrees themselves (skills tell them to), so the
 * runner cannot record creation at the source; it diffs
 * `git worktree list --porcelain` across the known repo roots instead.
 *
 * Never removed: the main worktree, a locked worktree (the agent's explicit
 * keep), one in use by an active task or any process, one with tracked
 * changes or commits on no remote ref. Held worktrees past the TTL lose their
 * gitignored `node_modules` instead ("slim").
 *
 * Worker-side only: no DB imports. The runner is the ledger's only writer.
 */

import { mkdir, readdir, readlink, realpath, rename, rm, stat, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isTerminalTaskStatus } from "../types";

export type WorktreeReaperMode = "off" | "dry-run" | "on";

export interface WorktreeReaperConfig {
  mode: WorktreeReaperMode;
  ttlHours: number;
  sweepIntervalMinutes: number;
  extraRoots: string[];
}

export const DEFAULT_WORKTREE_TTL_HOURS = 72;
export const DEFAULT_WORKTREE_SWEEP_INTERVAL_MINUTES = 60;

function clampedNumber(raw: string | undefined, fallback: number, min: number, max: number) {
  const value = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Reaper config from the `WORKTREE_*` env keys. A provider with no local
 * filesystem (claude-managed, devin) forces `off`: its worktrees live remotely.
 */
export function resolveWorktreeReaperConfig(
  env: Record<string, string | undefined> = process.env,
  hasLocalEnvironment = true,
): WorktreeReaperConfig {
  const rawMode = env.WORKTREE_REAPER_MODE?.trim().toLowerCase();
  const mode: WorktreeReaperMode =
    rawMode === "off" || rawMode === "on" || rawMode === "dry-run" ? rawMode : "dry-run";
  return {
    mode: hasLocalEnvironment ? mode : "off",
    ttlHours: clampedNumber(env.WORKTREE_TTL_HOURS, DEFAULT_WORKTREE_TTL_HOURS, 1, 24 * 90),
    sweepIntervalMinutes: clampedNumber(
      env.WORKTREE_SWEEP_INTERVAL_MINUTES,
      DEFAULT_WORKTREE_SWEEP_INTERVAL_MINUTES,
      5,
      24 * 60,
    ),
    extraRoots: (env.WORKTREE_REAPER_EXTRA_ROOTS ?? "")
      .split(",")
      .map((root) => root.trim())
      .filter(Boolean),
  };
}

export interface LedgerEntry {
  /** Worktree path as `git worktree list` prints it. */
  path: string;
  /** Main worktree of the repo it belongs to. */
  repoRoot: string;
  firstSeenAt: string;
  /** Tasks active when it was first seen. Empty: pre-existing or unattributed. */
  candidateTaskIds: string[];
  lastTaskEndAt?: string;
  /** Set before `worktree remove` runs, so a later sweep can finish an interrupted delete. */
  removingAt?: string;
}

interface Ledger {
  /** False until the first scan: worktrees found then predate the reaper. */
  initialized: boolean;
  roots: string[];
  entries: Record<string, LedgerEntry>;
}

export interface ActiveTaskRef {
  taskId: string;
  workingDir?: string;
}

export type ReapAction =
  | "remove"
  | "would-remove"
  | "slim"
  | "would-slim"
  | "finish-remove"
  | "would-finish-remove"
  | "skip"
  | "keep"
  | "error";

export interface ReapDecision {
  path: string;
  repoRoot: string;
  action: ReapAction;
  reason: string;
  taskIds: string[];
  ageHours: number | null;
}

export interface ReapResult {
  decisions: ReapDecision[];
}

interface WorktreeInfo {
  path: string;
  /** Short branch name; unset when detached. */
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface WorktreeReaperOptions {
  ledgerPath: string;
  /** Directories scanned (depth 3) for `.git` directories, i.e. main worktrees. */
  scanRoots: string[];
  /** Read on every call so mode and TTL changes apply without a restart. */
  getConfig: () => WorktreeReaperConfig;
  /** Server-side task status, or null when unknown (treated as active). */
  statusOf: (taskId: string) => Promise<string | null>;
  log?: (line: string) => void;
  now?: () => number;
  /** Process cwds checked by rule 3; defaults to reading `/proc/<pid>/cwd`. */
  processCwds?: () => Promise<string[]>;
}

const HOUR_MS = 3_600_000;

async function git(
  dir: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result =
    await Bun.$`env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_PREFIX git -C ${dir} ${args}`
      .quiet()
      .nothrow();
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

export function parseWorktreeList(porcelain: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block.split("\n").filter(Boolean);
    const head = lines[0];
    if (!head?.startsWith("worktree ")) continue;
    const info: WorktreeInfo = {
      path: head.slice("worktree ".length),
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
    };
    for (const line of lines.slice(1)) {
      if (line.startsWith("branch ")) info.branch = line.slice("branch refs/heads/".length);
      else if (line === "detached") info.detached = true;
      else if (line === "bare") info.bare = true;
      else if (line === "locked" || line.startsWith("locked ")) info.locked = true;
      else if (line === "prunable" || line.startsWith("prunable ")) info.prunable = true;
    }
    worktrees.push(info);
  }
  return worktrees;
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function procCwds(): Promise<string[]> {
  const pids = await readdir("/proc").catch(() => [] as string[]);
  const cwds = await Promise.all(
    pids
      .filter((pid) => /^\d+$/.test(pid))
      .map((pid) => readlink(`/proc/${pid}/cwd`).catch(() => null)),
  );
  return cwds.filter((cwd): cwd is string => cwd !== null);
}

export class WorktreeReaper {
  private readonly opts: WorktreeReaperOptions;
  private ledger: Ledger | null = null;
  private discoveredRoots: string[] = [];
  /** Serializes every operation: one ledger writer, one removal at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private sweepQueued = false;

  constructor(opts: WorktreeReaperOptions) {
    this.opts = opts;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private log(fields: Record<string, unknown>): void {
    (this.opts.log ?? console.log)(JSON.stringify({ event: "worktree-reaper", ...fields }));
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const run = this.queue.then(fn).finally(() => {
      this.pending -= 1;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Record worktrees that appeared since the last scan. Skipped while other work is queued. */
  observe(active: ActiveTaskRef[]): Promise<void> {
    if (this.opts.getConfig().mode === "off" || this.pending > 0) return Promise.resolve();
    return this.enqueue(async () => {
      await this.scan(active, false);
    });
  }

  /** Decide on every worktree attributed to `taskId`, which has just ended on this worker. */
  onTaskEnded(taskId: string, active: ActiveTaskRef[]): Promise<ReapResult> {
    if (this.opts.getConfig().mode === "off") return Promise.resolve({ decisions: [] });
    return this.enqueue(async () => {
      const worktrees = await this.scan([...active, { taskId }], false);
      const ledger = await this.loadLedger();
      const endedAt = new Date(this.now()).toISOString();
      for (const entry of Object.values(ledger.entries)) {
        if (entry.candidateTaskIds.includes(taskId)) entry.lastTaskEndAt = endedAt;
      }
      await this.saveLedger();
      const decisions: ReapDecision[] = [];
      for (const entry of Object.values(ledger.entries)) {
        if (!entry.candidateTaskIds.includes(taskId)) continue;
        const info = worktrees.get(entry.path);
        if (info) decisions.push(await this.decideAndAct(entry, info, active, false));
      }
      return { decisions };
    });
  }

  /** TTL and orphan pass over every known worktree. Skipped when a sweep is already queued. */
  sweep(active: ActiveTaskRef[]): Promise<ReapResult> {
    if (this.opts.getConfig().mode === "off" || this.sweepQueued) {
      return Promise.resolve({ decisions: [] });
    }
    this.sweepQueued = true;
    return this.enqueue(async () => {
      this.sweepQueued = false;
      const freeBefore = await this.freeBytes();
      const worktrees = await this.scan(active, true);
      const ledger = await this.loadLedger();
      const decisions: ReapDecision[] = [];
      for (const entry of Object.values(ledger.entries)) {
        const info = worktrees.get(entry.path);
        if (info) decisions.push(await this.decideAndAct(entry, info, active, true));
      }
      const count = (...actions: ReapAction[]) =>
        decisions.filter((d) => actions.includes(d.action)).length;
      this.log({
        action: "sweep-summary",
        mode: this.opts.getConfig().mode,
        worktrees: decisions.length,
        removed: count("remove", "would-remove", "finish-remove", "would-finish-remove"),
        slimmed: count("slim", "would-slim"),
        errors: count("error"),
        held: decisions
          .filter((d) => d.action === "skip" || d.action.endsWith("slim"))
          .map((d) => `${d.path} (${d.reason})`),
        freeBytesBefore: freeBefore,
        freeBytesAfter: await this.freeBytes(),
      });
      return { decisions };
    });
  }

  private async freeBytes(): Promise<number | null> {
    try {
      const fs = await statfs(dirname(this.opts.ledgerPath));
      return fs.bavail * fs.bsize;
    } catch {
      return null;
    }
  }

  private async loadLedger(): Promise<Ledger> {
    if (this.ledger) return this.ledger;
    const file = Bun.file(this.opts.ledgerPath);
    const empty: Ledger = { initialized: false, roots: [], entries: {} };
    if (!(await file.exists())) {
      this.ledger = empty;
      return empty;
    }
    try {
      const parsed = (await file.json()) as Partial<Ledger>;
      if (typeof parsed !== "object" || parsed === null || typeof parsed.entries !== "object") {
        throw new Error("ledger has no entries map");
      }
      this.ledger = {
        initialized: parsed.initialized === true,
        roots: Array.isArray(parsed.roots) ? parsed.roots : [],
        entries: parsed.entries ?? {},
      };
    } catch (err) {
      // A corrupt ledger is set aside, not lost. Starting uninitialized means
      // every listed worktree counts as unattributed: TTL sweep only.
      const aside = `${this.opts.ledgerPath}.corrupt-${this.now()}`;
      await rename(this.opts.ledgerPath, aside).catch(() => undefined);
      this.log({ action: "ledger-reset", reason: String(err), path: aside });
      this.ledger = { initialized: false, roots: [], entries: {} };
    }
    return this.ledger;
  }

  private async saveLedger(): Promise<void> {
    if (!this.ledger) return;
    await mkdir(dirname(this.opts.ledgerPath), { recursive: true });
    const tmp = `${this.opts.ledgerPath}.tmp`;
    await Bun.write(tmp, JSON.stringify(this.ledger, null, 2));
    await rename(tmp, this.opts.ledgerPath);
  }

  private async mainWorktreeOf(dir: string): Promise<string | null> {
    const common = await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (!common.ok || !common.stdout.endsWith("/.git")) return null;
    return dirname(common.stdout);
  }

  private async discoverRoots(): Promise<string[]> {
    const roots: string[] = [];
    for (const scanRoot of this.opts.scanRoots) {
      if (!(await exists(scanRoot))) continue;
      const found =
        await Bun.$`find ${scanRoot} -maxdepth 3 -name node_modules -prune -o -name .git -type d -print`
          .quiet()
          .nothrow();
      for (const line of found.stdout.toString().split("\n")) {
        if (line.trim()) roots.push(dirname(line.trim()));
      }
    }
    return roots;
  }

  /**
   * List every linked worktree of every known repo, add the new ones to the
   * ledger, and drop entries git no longer lists. Returns path -> info.
   */
  private async scan(
    active: ActiveTaskRef[],
    refreshRoots: boolean,
  ): Promise<Map<string, WorktreeInfo>> {
    const ledger = await this.loadLedger();
    if (refreshRoots || this.discoveredRoots.length === 0) {
      this.discoveredRoots = await this.discoverRoots();
    }
    const taskRoots = await Promise.all(
      active.flatMap((t) => (t.workingDir ? [this.mainWorktreeOf(t.workingDir)] : [])),
    );
    const candidates = new Set([
      ...this.discoveredRoots,
      ...ledger.roots,
      ...this.opts.getConfig().extraRoots,
      ...taskRoots.filter((root): root is string => root !== null),
    ]);
    const roots = new Set<string>();
    for (const candidate of candidates) {
      const root = await this.mainWorktreeOf(candidate);
      if (root) roots.add(root);
    }

    const seen = new Map<string, WorktreeInfo>();
    const firstScan = !ledger.initialized;
    const nowIso = new Date(this.now()).toISOString();
    const activeIds = [...new Set(active.map((t) => t.taskId))];
    for (const root of roots) {
      const listed = await git(root, ["worktree", "list", "--porcelain"]);
      if (!listed.ok) continue;
      const [main, ...linked] = parseWorktreeList(listed.stdout);
      if (!main || main.bare) continue; // Rule 1: a bare repo's worktrees stay out of scope.
      for (const info of linked) {
        seen.set(info.path, info);
        if (ledger.entries[info.path]) continue;
        ledger.entries[info.path] = {
          path: info.path,
          repoRoot: root,
          firstSeenAt: nowIso,
          candidateTaskIds: firstScan ? [] : activeIds,
        };
      }
    }
    for (const path of Object.keys(ledger.entries)) {
      const entry = ledger.entries[path];
      // Keep entries of a root that failed to list this time; drop the rest.
      if (!seen.has(path) && entry && roots.has(entry.repoRoot)) delete ledger.entries[path];
    }
    ledger.roots = [...roots];
    ledger.initialized = true;
    await this.saveLedger();
    return seen;
  }

  private async ageHours(entry: LedgerEntry): Promise<number | null> {
    const stamps: number[] = [];
    if (entry.lastTaskEndAt) stamps.push(Date.parse(entry.lastTaskEndAt));
    const gitDir = await git(entry.path, ["rev-parse", "--absolute-git-dir"]);
    if (gitDir.ok) {
      for (const name of ["HEAD", "index", "logs/HEAD"]) {
        const info = await stat(join(gitDir.stdout, name)).catch(() => null);
        if (info) stamps.push(info.mtimeMs);
      }
    }
    // Directory mtime is deliberately ignored: a refreshed parent pins old worktrees.
    if (stamps.length === 0) return null;
    return (this.now() - Math.max(...stamps)) / HOUR_MS;
  }

  private async inUse(path: string, active: ActiveTaskRef[]): Promise<boolean> {
    for (const task of active) {
      if (!task.workingDir) continue;
      const dir = await realpath(task.workingDir).catch(() => task.workingDir as string);
      if (isInside(dir, path) || isInside(path, dir)) return true;
    }
    const cwds = await (this.opts.processCwds ?? procCwds)();
    return cwds.some((cwd) => isInside(cwd, path));
  }

  private async isDefaultUpstream(repoRoot: string, upstream: string): Promise<boolean> {
    const originHead = await git(repoRoot, [
      "symbolic-ref",
      "-q",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    const defaults = new Set(["origin/main", "origin/master"]);
    if (originHead.ok && originHead.stdout) defaults.add(originHead.stdout);
    return defaults.has(upstream);
  }

  private async ownerActive(entry: LedgerEntry, active: ActiveTaskRef[]): Promise<boolean> {
    const activeIds = new Set(active.map((t) => t.taskId));
    for (const taskId of entry.candidateTaskIds) {
      if (activeIds.has(taskId)) return true;
      const status = await this.opts.statusOf(taskId);
      // Unknown status (API down, not found) keeps the worktree.
      if (!status || !isTerminalTaskStatus(status)) return true;
    }
    return false;
  }

  private async decide(
    entry: LedgerEntry,
    info: WorktreeInfo,
    active: ActiveTaskRef[],
    ttlHours: number,
    ageHours: number | null,
  ): Promise<{ verdict: "remove" | "finish-remove" | "held" | "skip" | "keep"; reason: string }> {
    if (info.locked) return { verdict: "skip", reason: "locked" };
    const real = await realpath(entry.path).catch(() => null);
    if (await this.inUse(real ?? entry.path, active)) return { verdict: "skip", reason: "in-use" };
    // `.git` file gone: either our own interrupted delete, or a damaged worktree
    // we cannot inspect (git would walk up to an enclosing repo).
    const top = await git(entry.path, ["rev-parse", "--show-toplevel"]);
    if (info.prunable || real === null || top.stdout !== real) {
      if (real === null) return { verdict: "finish-remove", reason: "missing" };
      if (entry.removingAt && !isInside(entry.repoRoot, real)) {
        return { verdict: "finish-remove", reason: "interrupted-remove" };
      }
      return { verdict: "skip", reason: "broken" };
    }
    const dirty = await git(entry.path, ["status", "--porcelain", "--untracked-files=no"]);
    if (!dirty.ok) return { verdict: "skip", reason: "status-failed" };
    if (dirty.stdout) return { verdict: "held", reason: "dirty" };
    const unpushed = await git(entry.path, ["rev-list", "-1", "HEAD", "--not", "--remotes"]);
    if (!unpushed.ok) return { verdict: "skip", reason: "rev-list-failed" };
    if (unpushed.stdout) return { verdict: "held", reason: "unpushed" };
    if (await this.ownerActive(entry, active)) return { verdict: "skip", reason: "owner-active" };
    const young = ageHours === null || ageHours < ttlHours;
    if (info.branch && young) {
      const upstream = await git(entry.path, [
        "rev-parse",
        "--abbrev-ref",
        `${info.branch}@{upstream}`,
      ]);
      if (upstream.ok && !(await this.isDefaultUpstream(entry.repoRoot, upstream.stdout))) {
        return { verdict: "keep", reason: "pushed-branch" };
      }
    }
    if (entry.candidateTaskIds.length === 0 && young) return { verdict: "keep", reason: "young" };
    return { verdict: "remove", reason: entry.candidateTaskIds.length ? "owners-ended" : "ttl" };
  }

  private async decideAndAct(
    entry: LedgerEntry,
    info: WorktreeInfo,
    active: ActiveTaskRef[],
    isSweep: boolean,
  ): Promise<ReapDecision> {
    const { mode, ttlHours } = this.opts.getConfig();
    const ageHours = await this.ageHours(entry);
    const { verdict, reason } = await this.decide(entry, info, active, ttlHours, ageHours);
    const decision: ReapDecision = {
      path: entry.path,
      repoRoot: entry.repoRoot,
      action: verdict === "held" ? "skip" : verdict === "keep" ? "keep" : "skip",
      reason,
      taskIds: entry.candidateTaskIds,
      ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
    };
    const dryRun = mode !== "on";

    if (verdict === "held" && isSweep && ageHours !== null && ageHours >= ttlHours) {
      const slimmed = await this.slim(entry.path, dryRun);
      if (slimmed.length > 0) {
        decision.action = dryRun ? "would-slim" : "slim";
        decision.reason = `held-${reason}`;
        this.log({ ...decision, nodeModules: slimmed });
      }
      return decision;
    }

    if (verdict === "remove" || verdict === "finish-remove") {
      decision.action = verdict === "remove" ? "remove" : "finish-remove";
      if (dryRun) {
        decision.action = verdict === "remove" ? "would-remove" : "would-finish-remove";
        this.log({ ...decision });
        return decision;
      }
      // Rule 3 again, right before the destructive step.
      if (await this.inUse(await realpath(entry.path).catch(() => entry.path), active)) {
        decision.action = "skip";
        decision.reason = "in-use";
        return decision;
      }
      const error = await this.remove(entry, verdict === "finish-remove");
      if (error) {
        decision.action = "error";
        decision.reason = error;
      }
      this.log({ ...decision });
      return decision;
    }

    if (!isSweep) this.log({ ...decision });
    return decision;
  }

  /** Remove (or list, in dry-run) the gitignored `node_modules` directories under a worktree. */
  private async slim(path: string, dryRun: boolean): Promise<string[]> {
    const found = await Bun.$`find ${path} -name node_modules -type d -prune -print`
      .quiet()
      .nothrow();
    const slimmed: string[] = [];
    for (const dir of found.stdout.toString().split("\n").filter(Boolean)) {
      if (!(await git(path, ["check-ignore", "-q", dir])).ok) continue;
      if (!dryRun) await rm(dir, { recursive: true, force: true });
      slimmed.push(dir);
    }
    return slimmed;
  }

  /** Returns an error string, or null on success. */
  private async remove(entry: LedgerEntry, finishInterrupted: boolean): Promise<string | null> {
    const ledger = await this.loadLedger();
    entry.removingAt = new Date(this.now()).toISOString();
    await this.saveLedger();
    if (finishInterrupted) {
      // Git still lists this path as a worktree of repoRoot and we started its
      // removal, but its `.git` file is gone, so `worktree remove` refuses it.
      await rm(entry.path, { recursive: true, force: true }).catch(() => undefined);
    } else {
      const removed = await git(entry.repoRoot, ["worktree", "remove", "--force", entry.path]);
      if (!removed.ok) return `error:${removed.stderr.split("\n")[0] || "worktree remove failed"}`;
    }
    await git(entry.repoRoot, ["worktree", "prune"]);
    if (await exists(entry.path)) return "error:path still present after remove";
    delete ledger.entries[entry.path];
    await this.saveLedger();
    return null;
  }
}
