import {
  getAgentById,
  getRunningScriptRuns,
  getScriptRun,
  getScriptRunExecutionArgs,
  updateScriptRun,
  updateScriptRunIfRunning,
} from "../be/db";
import { DURABLE_LEASE_MS, releaseDurableOwner } from "../be/script-runners/durable-dispatch";

import { startDurableBus, stopDurableBus } from "../be/script-runners/durable-launch-bus";
import { acquireLegacyJournalCredential } from "../be/scripts/legacy-journal-credential";
import {
  acquireScriptApiCredential,
  type ScriptExecutionPrincipal,
} from "../be/scripts/run-credential";
import { getStorage } from "../be/storage";
import { reserveHeldScriptRunner } from "../scripts-runtime/dispatch/held-reservations";
import { isExecutorAllowedByDeployment } from "../scripts-runtime/executors/registry";
import type { ScriptRun } from "../types";
import type { ScriptRunProvenance } from "../utils/request-auth-context";
import { scrubSecrets } from "../utils/secret-scrubber";
import {
  localProcessScriptExecutor,
  type ScriptExecutionHandle,
  type ScriptExecutor,
} from "./executor";
import { scriptRunMaxWallMs } from "./limits";

type ManagedRun = {
  execution: ScriptExecutionHandle;
};

const embeddedOwnerId = `embedded:${crypto.randomUUID()}`;
const starting = new Map<string, Promise<void>>();
const managed = new Map<string, ManagedRun>();
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let scriptExecutor: ScriptExecutor = localProcessScriptExecutor;

function supervisorDisabled(): boolean {
  return process.env.SCRIPT_RUN_SUPERVISOR_DISABLE === "true";
}

export function setScriptRunExecutor(executor: ScriptExecutor): void {
  scriptExecutor = executor;
}

export const DURABLE_RUNS_NATIVE_REFUSED =
  'Durable script runs use the native executor, which is not permitted when deployment SCRIPT_EXECUTOR="quickjs"';

/**
 * Durable runs only have a native harness (a `bun` subprocess), so they follow
 * the same deployment ceiling as an inline run that asks for `native`.
 */
export function durableScriptRunsAllowed(): boolean {
  return isExecutorAllowedByDeployment("native");
}

export async function startScriptRunProcess(run: ScriptRun, baseUrl: string): Promise<void> {
  if (supervisorDisabled()) return;
  const pending = starting.get(run.id);
  if (pending) return pending;
  if (managed.has(run.id)) return;
  const launch = startOwnedScriptRun(run, baseUrl);
  starting.set(run.id, launch);
  try {
    await launch;
  } finally {
    starting.delete(run.id);
  }
}

async function startOwnedScriptRun(run: ScriptRun, baseUrl: string): Promise<void> {
  // Also covers reconcile respawns of runs created before the setting changed.
  if (!durableScriptRunsAllowed()) throw new Error(DURABLE_RUNS_NATIVE_REFUSED);
  const tier = getStorage().capabilities.scriptRunners;
  const stored = await getStorage().repos.scripts.findScriptRun(run.id);
  if (!stored || stored.status !== "running" || (tier && stored.ownerId)) return;
  const reservation = tier ? reserveHeldScriptRunner() : undefined;
  if (tier && !reservation) return;
  const remote = reservation?.runner.kind === "remote";
  const ownerId = remote ? reservation.runner.ownerId : embeddedOwnerId;
  if (!ownerId) {
    reservation?.release();
    throw new Error("Runner owner identity is required");
  }
  if (
    tier &&
    !(await getStorage().repos.scripts.claimScriptRun(
      run.id,
      ownerId,
      remote ? new Date(Date.now() + DURABLE_LEASE_MS).toISOString() : null,
    ))
  ) {
    reservation?.release();
    return;
  }
  try {
    await launchPlacedRun(run, baseUrl, reservation);
  } catch (error) {
    reservation?.release();
    if (tier) await getStorage().repos.scripts.releaseScriptRunOwner(run.id, ownerId);
    throw error;
  }
}

async function launchPlacedRun(
  run: ScriptRun,
  baseUrl: string,
  reservation: ReturnType<typeof reserveHeldScriptRunner>,
): Promise<void> {
  const remote = reservation?.runner.kind === "remote";
  const row = await getStorage().repos.scripts.getScriptRunPrincipal(run.id);
  if (!row) throw new Error("Script run does not exist");
  const ttl = scriptRunMaxWallMs() + 60_000;
  const principal = row.executionPrincipal
    ? (JSON.parse(row.executionPrincipal) as ScriptExecutionPrincipal & ScriptRunProvenance)
    : null;
  if (principal && principal.kind !== "agent" && principal.kind !== "operator") {
    throw new Error("Invalid durable script execution principal");
  }
  if (!principal && !(await getAgentById(run.agentId))) {
    throw new Error("Historical script run has no registered owner");
  }
  const credential = principal
    ? await acquireScriptApiCredential(
        run.agentId,
        { sourceScriptRunId: run.id, depth: principal.depth, objectChain: principal.objectChain },
        principal,
        ttl,
      )
    : acquireLegacyJournalCredential(run.id, run.agentId, ttl);
  const apiKey = credential.apiKey;

  // `run.args` is the redacted view; launch with the exact sealed value.
  let execution: ScriptExecutionHandle;
  try {
    const sealedArgs = await getScriptRunExecutionArgs(run.id);
    const args = sealedArgs === undefined ? run.args : sealedArgs;
    execution = reservation
      ? await reservation.startHeld({ run: { ...run, args }, baseUrl, apiKey })
      : await scriptExecutor.start({ run: { ...run, args }, baseUrl, apiKey });
  } catch (error) {
    await credential.release();
    throw error;
  }
  managed.set(run.id, { execution });
  let cleanup: Promise<void> | undefined;
  const release = () => (cleanup ??= closeExecution());
  async function closeExecution() {
    if (managed.get(run.id)?.execution === execution) managed.delete(run.id);
    try {
      await execution.cleanup();
    } finally {
      await credential.release();
      reservation?.release();
    }
  }
  const persisted = updateScriptRunIfRunning(run.id, {
    status: "running",
    pid: execution.pid,
    lastHeartbeatAt: new Date().toISOString(),
  });
  // An early exit must wait for the initial status write before recording its final status.
  const finished = execution.exited
    .then(async ({ exitCode, stderr, terminated }) => {
      await persisted;
      if (terminated || remote) return;
      const current = await getScriptRun(run.id);
      if (current && current.status === "running") {
        if (exitCode !== 0) {
          // Script stderr can echo whatever the script printed; scrub at the
          // log egress. The `error` column below is scrubbed by the DB writer.
          console.error(
            scrubSecrets(
              `[script-workflows] run ${run.id} subprocess exited ${exitCode}: ${stderr.trim() || "(no stderr)"}`,
            ),
          );
        }
        // Guarded write: the read above is followed by an await, so the
        // harness's own final status POST (or a pause/cancel) can land first.
        await updateScriptRunIfRunning(run.id, {
          status: exitCode === 0 ? "completed" : "failed",
          pid: null,
          finishedAt: new Date().toISOString(),
          error:
            exitCode === 0
              ? null
              : stderr.trim() || `Script workflow subprocess exited ${exitCode}`,
        });
      }
    })
    .finally(release);
  void finished.catch((error) => {
    console.error(scrubSecrets(`[script-workflows] run ${run.id} cleanup: ${String(error)}`));
  });
  try {
    await persisted;
  } catch (error) {
    // Stop any remaining work and revoke immediately if the executor cannot terminate.
    try {
      await execution.terminate("SIGTERM");
    } finally {
      await release();
    }
    throw error;
  }
}

export async function terminateScriptRunProcess(runId: string): Promise<boolean> {
  await starting.get(runId)?.catch(() => {});
  const managedRun = managed.get(runId);
  const run = await getScriptRun(runId);
  if (managedRun) {
    await managedRun.execution.terminate("SIGTERM");
    managed.delete(runId);
    const owner = await getStorage().repos.scripts.findScriptRun(runId);
    if (owner?.ownerId)
      await getStorage().repos.scripts.releaseScriptRunOwner(runId, owner.ownerId);
    return true;
  }
  if (run?.pid && scriptExecutor.isRunning(run.pid)) {
    await scriptExecutor.terminatePid(run.pid, "SIGTERM");
    return true;
  }
  return false;
}

export async function pauseScriptRunProcess(runId: string): Promise<void> {
  await terminateScriptRunProcess(runId);
  await updateScriptRun(runId, { status: "paused", pid: null });
}

export async function abortScriptRunLimit(runId: string, reason: string): Promise<void> {
  await terminateScriptRunProcess(runId);
  await updateScriptRun(runId, {
    status: "aborted_limit",
    pid: null,
    finishedAt: new Date().toISOString(),
    error: reason,
  });
}

export async function reconcileScriptRuns(baseUrl: string): Promise<void> {
  if (supervisorDisabled()) return;
  for (const run of await getRunningScriptRuns()) {
    if (run.status === "paused") continue;
    if (getStorage().capabilities.scriptRunners) {
      const stored = await getStorage().repos.scripts.findScriptRun(run.id);
      if (stored?.ownerId) {
        if (stored.ownerId.startsWith("embedded:") && stored.ownerId !== embeddedOwnerId) {
          await getStorage().repos.scripts.releaseScriptRunOwner(run.id, stored.ownerId);
        } else if (stored.leaseExpiresAt && stored.leaseExpiresAt <= new Date().toISOString()) {
          await releaseDurableOwner(stored.ownerId, run.id);
        } else if (!stored.ownerId.startsWith("embedded:")) {
          const current = managed.get(run.id);
          if (current && Date.now() - current.execution.startedAtMs > scriptRunMaxWallMs())
            await abortScriptRunLimit(
              run.id,
              `SCRIPT_RUN_MAX_WALL_MS exceeded (${scriptRunMaxWallMs()})`,
            );
          continue;
        }
      }
    }
    const current = managed.get(run.id);
    if (current && Date.now() - current.execution.startedAtMs > scriptRunMaxWallMs()) {
      await abortScriptRunLimit(
        run.id,
        `SCRIPT_RUN_MAX_WALL_MS exceeded (${scriptRunMaxWallMs()})`,
      );
      continue;
    }
    if (!current && (!run.pid || !scriptExecutor.isRunning(run.pid))) {
      startScriptRunProcess(run, baseUrl).catch(async (err) => {
        await updateScriptRun(run.id, {
          status: "failed",
          pid: null,
          finishedAt: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }
}

export async function startScriptRunSupervisor(baseUrl: string): Promise<void> {
  if (supervisorDisabled() || reconcileTimer) return;
  startDurableBus((run) => startScriptRunProcess(run, baseUrl));
  if (process.env.NODE_ENV === "test" && process.env.E2E_BUS_RECOVERY_ONLY === "true") return;
  await reconcileScriptRuns(baseUrl);
  reconcileTimer = setInterval(() => {
    void reconcileScriptRuns(baseUrl);
  }, 15_000);
  reconcileTimer.unref?.();
}

export async function stopScriptRunSupervisor(): Promise<void> {
  await stopDurableBus();
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
  await Promise.allSettled(starting.values());
  for (const runId of [...managed.keys()]) await terminateScriptRunProcess(runId);
}
