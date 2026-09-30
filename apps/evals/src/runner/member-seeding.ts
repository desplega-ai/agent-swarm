/**
 * Per-member seeding (swarm-evals plan v2, Phase 8): declared profiles for
 * capability-routing and per-worker files for implement-review. Both are strict:
 * a failure throws, and the runner records the attempt as an infra error, since
 * a teammate without its profile or its files makes the scenario unfair.
 */

import type { ScenarioSeed, WorkerProfile } from "../types.ts";

export interface SeedMember {
  index: number;
  role: "lead" | "worker";
  agentId: string;
  sandboxId: string;
  profile?: WorkerProfile;
}

/** Write each member's declared profile. Returns the members it wrote, for the log. */
export async function applyMemberProfiles(
  members: SeedMember[],
  update: (agentId: string, profile: WorkerProfile) => Promise<void>,
  log: (msg: string) => void = () => {},
): Promise<number[]> {
  const written: number[] = [];
  for (const m of members) {
    if (!m.profile) continue;
    try {
      await update(m.agentId, m.profile);
    } catch (err) {
      throw new Error(
        `profile for ${m.role} ${m.index} failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    log(
      `[seed] profile ${m.role} ${m.index}: role=${m.profile.role ?? "-"} capabilities=[${(m.profile.capabilities ?? []).join(", ")}]`,
    );
    written.push(m.index);
  }
  return written;
}

export interface WorkerExecOutput {
  worker: number;
  cmd: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `seed.workerExec` in order. Each entry targets a worker-role member by
 * index. `outputs` is filled as it goes so the caller can persist it even when
 * a command fails.
 */
export async function runWorkerExec(opts: {
  entries: NonNullable<ScenarioSeed["workerExec"]>;
  members: SeedMember[];
  exec: (
    sandboxId: string,
    cmd: string,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  outputs: WorkerExecOutput[];
  clip?: number;
  log?: (msg: string) => void;
}): Promise<void> {
  const clip = opts.clip ?? 4_000;
  const log = opts.log ?? (() => {});
  for (const entry of opts.entries) {
    const member = opts.members.find((m) => m.role === "worker" && m.index === entry.worker);
    if (!member) throw new Error(`seed.workerExec targets worker ${entry.worker}, not booted`);
    for (const cmd of entry.commands) {
      log(`[seed] (worker ${entry.worker}) ${cmd.slice(0, 200)}`);
      const t0 = Date.now();
      const res = await opts.exec(member.sandboxId, cmd);
      opts.outputs.push({
        worker: entry.worker,
        cmd,
        exitCode: res.exitCode,
        durationMs: Date.now() - t0,
        stdout: res.stdout.slice(0, clip),
        stderr: res.stderr.slice(0, clip),
      });
      if (res.exitCode !== 0) {
        throw new Error(
          `seed.workerExec command failed on worker ${entry.worker} (${res.exitCode}): ${cmd.slice(0, 200)}\n${res.stderr.slice(0, 500)}`,
        );
      }
    }
  }
}
