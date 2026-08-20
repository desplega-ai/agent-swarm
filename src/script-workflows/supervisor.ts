import {
  getRunningScriptRuns,
  getScriptRun,
  updateScriptRun,
  updateScriptRunIfRunning,
} from "../be/db";
import type { ScriptRun } from "../types";
import { getApiKey } from "../utils/api-key";
import {
  localProcessScriptExecutor,
  type ScriptExecutionHandle,
  type ScriptExecutor,
} from "./executor";
import { scriptRunMaxWallMs } from "./limits";

type ManagedRun = {
  execution: ScriptExecutionHandle;
};

const managed = new Map<string, ManagedRun>();
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let scriptExecutor: ScriptExecutor = localProcessScriptExecutor;

function supervisorDisabled(): boolean {
  return process.env.SCRIPT_RUN_SUPERVISOR_DISABLE === "true";
}

export function setScriptRunExecutor(executor: ScriptExecutor): void {
  scriptExecutor = executor;
}

export async function startScriptRunProcess(
  run: ScriptRun,
  baseUrl: string,
  apiKeyOverride?: string,
): Promise<void> {
  if (supervisorDisabled()) return;
  if (managed.has(run.id)) return;
  const apiKey = apiKeyOverride ?? getApiKey();
  if (!apiKey) throw new Error("AGENT_SWARM_API_KEY is required to spawn script runs");
  if (process.env.SCRIPT_WORKFLOW_DEBUG === "true") {
    console.error(
      `[script-workflows] spawning ${run.id} auth override=${apiKeyOverride ? "yes" : "no"} len=${apiKey.length}`,
    );
  }

  const execution = await scriptExecutor.start({ run, baseUrl, apiKey });
  managed.set(run.id, { execution });
  await updateScriptRun(run.id, {
    status: "running",
    pid: execution.pid,
    lastHeartbeatAt: new Date().toISOString(),
  });

  execution.exited
    .then(async ({ exitCode, stderr }) => {
      const current = await getScriptRun(run.id);
      if (current && current.status === "running") {
        if (exitCode !== 0) {
          console.error(
            `[script-workflows] run ${run.id} subprocess exited ${exitCode}: ${stderr.trim() || "(no stderr)"}`,
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
      await execution.cleanup();
    });
}

export async function terminateScriptRunProcess(runId: string): Promise<boolean> {
  const managedRun = managed.get(runId);
  const run = await getScriptRun(runId);
  if (managedRun) {
    managedRun.execution.terminate("SIGTERM");
    managed.delete(runId);
    return true;
  }
  if (run?.pid && scriptExecutor.isRunning(run.pid)) {
    scriptExecutor.terminatePid(run.pid, "SIGTERM");
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
