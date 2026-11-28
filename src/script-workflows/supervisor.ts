import {
  getRunningScriptRuns,
  getScriptRun,
  getScriptRunExecutionArgs,
  updateScriptRun,
  updateScriptRunIfRunning,
} from "../be/db";
import { acquireScriptApiCredential } from "../be/scripts/run-credential";
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

/** Token lifetime past the wall-clock cap, so the reconcile abort lands before expiry. */
const SCRIPT_RUN_TOKEN_GRACE_MS = 15 * 60 * 1000;

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

export async function startScriptRunProcess(
  run: ScriptRun,
  baseUrl: string,
  launcherProvenance: ScriptRunProvenance = {},
): Promise<void> {
  if (supervisorDisabled()) return;
  if (managed.has(run.id)) return;
  // Also covers reconcile respawns of runs created before the setting changed.
  if (!durableScriptRunsAllowed()) throw new Error(DURABLE_RUNS_NATIVE_REFUSED);
  // The broker acts as the run's agent on a token bound to this process and
  // revoked when it ends, never the launcher's bearer or the swarm API key. A
  // reconcile respawn mints a fresh one, so a deleted agent's run stops here.
  const credential = await acquireScriptApiCredential(
    run.agentId,
    { ...launcherProvenance, sourceScriptRunId: run.id },
    scriptRunMaxWallMs() + SCRIPT_RUN_TOKEN_GRACE_MS,
  );
  const apiKey = credential.apiKey;
  if (!apiKey) throw new Error(`Script run agent ${run.agentId} no longer exists`);

  let execution: ScriptExecutionHandle;
  try {
    // `run.args` is the redacted view; launch with the exact sealed value.
    const sealedArgs = await getScriptRunExecutionArgs(run.id);
    const args = sealedArgs === undefined ? run.args : sealedArgs;
    execution = await scriptExecutor.start({ run: { ...run, args }, baseUrl, apiKey });
  } catch (err) {
    await credential.release();
    throw err;
  }
  managed.set(run.id, { execution });
  await updateScriptRun(run.id, {
    status: "running",
    pid: execution.pid,
    lastHeartbeatAt: new Date().toISOString(),
  });

  execution.exited
    .then(async ({ exitCode, stderr, terminated }) => {
      if (terminated) return;
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
    .finally(async () => {
      managed.delete(run.id);
      try {
        await credential.release();
      } finally {
        await execution.cleanup();
      }
    });
}

export async function terminateScriptRunProcess(runId: string): Promise<boolean> {
  const managedRun = managed.get(runId);
  const run = await getScriptRun(runId);
  if (managedRun) {
    await managedRun.execution.terminate("SIGTERM");
    managed.delete(runId);
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
  await reconcileScriptRuns(baseUrl);
  reconcileTimer = setInterval(() => {
    void reconcileScriptRuns(baseUrl);
  }, 15_000);
  reconcileTimer.unref?.();
}

export async function stopScriptRunSupervisor(): Promise<void> {
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
  for (const runId of [...managed.keys()]) await terminateScriptRunProcess(runId);
}
