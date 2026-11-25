import { encodeRunnerFrame } from "../../script-runner/protocol";
import { createCapabilitySession } from "../../script-workflows/capability-session";
import type {
  ScriptExecutionHandle,
  ScriptExecutionResult,
  StartScriptExecutionInput,
} from "../../script-workflows/executor";
import { heldScriptSlots } from "../../scripts-runtime/dispatch/held-reservations";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { getStorage } from "../storage";
import { registerDurableBrokerFence } from "./broker-fence";
import { type RemoteScriptRunner, scriptRunnerSessions } from "./sessions";

export const DURABLE_LEASE_MS = 60000;
const held = new Map<
  string,
  {
    ownerId: string;
    session: ReturnType<typeof createCapabilitySession>;
    finish: (result: ScriptExecutionResult) => void;
  }
>();
const send = (runner: RemoteScriptRunner, message: unknown) =>
  new Promise<void>((resolve, reject) => {
    try {
      runner.socket.send(encodeRunnerFrame(message), (error) =>
        error ? reject(error) : resolve(),
      );
    } catch (error) {
      reject(error);
    }
  });
export function pickDurableRunner(
  options: { lane?: "sync" | "long"; eligible?: (runner: RemoteScriptRunner) => boolean } = {},
): RemoteScriptRunner | undefined {
  const share = Number(process.env.SCRIPT_RUNNER_LONG_LANE_SHARE ?? 0.5);
  return [...scriptRunnerSessions.values()].find(
    (runner) =>
      !runner.draining &&
      runner.socket.readyState === 1 &&
      (options.eligible ? options.eligible(runner) : runner.executors.includes("native")) &&
      runner.pending.size + heldScriptSlots(runner.id) < runner.slots &&
      (options.lane === "sync" ||
        heldScriptSlots(runner.id) < Math.max(1, Math.floor(runner.slots * share))),
  );
}

export async function startRemoteDurable(
  input: StartScriptExecutionInput,
  runner: RemoteScriptRunner,
): Promise<ScriptExecutionHandle> {
  const unregisterFence = registerDurableBrokerFence(input.apiKey, input.run.id, runner.id);
  const token = crypto.randomUUID();
  const session = createCapabilitySession(
    { ...input, ownerId: runner.id, authorizeCapability: () => owns(input.run.id, runner.id) },
    token,
    true,
  );
  session.authenticate(JSON.stringify({ type: "hello", token }));
  let finish!: (result: ScriptExecutionResult) => void;
  const exited = new Promise<ScriptExecutionResult>((resolve) => {
    finish = resolve;
  });
  held.set(input.run.id, { ownerId: runner.id, session, finish });
  try {
    await send(runner, { type: "durable-job", jobId: input.run.id, run: input.run });
  } catch (error) {
    unregisterFence();
    held.delete(input.run.id);
    session.close();
    throw error;
  }
  return {
    pid: null,
    tmpdir: "",
    startedAtMs: Date.now(),
    exited,
    async terminate() {
      session.close();
      const current = scriptRunnerSessions.get(runner.id) ?? runner;
      await send(current, { type: "cancel", jobId: input.run.id }).catch(() => {});
      const deadline = setTimeout(() => {
        (scriptRunnerSessions.get(runner.id) ?? runner).close();
        finish({ exitCode: null, stderr: "", terminated: true });
      }, 5000);
      try {
        await exited;
      } finally {
        clearTimeout(deadline);
      }
    },
    async cleanup() {
      unregisterFence();
      session.close();
      if (held.get(input.run.id)?.session === session) held.delete(input.run.id);
    },
  };
}
async function owns(jobId: string, ownerId: string): Promise<boolean> {
  const row = await getStorage().repos.scripts.findScriptRun(jobId);
  return (
    row?.status === "running" &&
    row.ownerId === ownerId &&
    !!row.leaseExpiresAt &&
    row.leaseExpiresAt > new Date().toISOString()
  );
}
export async function durableHeartbeat(runner: RemoteScriptRunner, jobs: string[]) {
  const renewed: string[] = [];
  const now = new Date().toISOString();
  for (const id of jobs) {
    if (
      !(await getStorage().repos.scripts.renewScriptRunLease(
        id,
        runner.id,
        now,
        new Date(Date.now() + DURABLE_LEASE_MS).toISOString(),
      ))
    )
      await send(runner, { type: "cancel", jobId: id });
    else renewed.push(id);
  }
  return renewed;
}
export async function durableCapability(runner: RemoteScriptRunner, id: string, frame: string) {
  const job = held.get(id);
  if (!job || job.ownerId !== runner.id || !(await owns(id, runner.id))) return;
  const parsed = JSON.parse(frame);
  if (parsed.type === "ack" && typeof parsed.id === "string") {
    job.session.confirmResponse(parsed.id);
    return;
  }
  try {
    await job.session.receive(frame, async (response) => {
      if (await owns(id, runner.id)) {
        const current = scriptRunnerSessions.get(runner.id);
        if (current) await send(current, { type: "cap", jobId: id, frame: response });
      }
    });
  } catch (error) {
    job.session.close();
    await send(runner, { type: "cancel", jobId: id }).catch(() => {});
    await durableResult(runner, id, { exitCode: 1, stderr: scrubSecrets(String(error)) });
  }
}
export async function durableResult(
  runner: RemoteScriptRunner,
  id: string,
  result: ScriptExecutionResult,
) {
  const job = held.get(id);
  if (result.terminated && job?.ownerId === runner.id) {
    await getStorage().repos.scripts.releaseScriptRunOwner(id, runner.id);
    job.finish(result);
    await send(runner, { type: "ack", jobId: id });
    return;
  }
  if (job?.ownerId === runner.id && (await owns(id, runner.id))) {
    const now = new Date().toISOString();
    const changed = await getStorage().transaction(() =>
      getStorage().repos.scripts.settleOwnedScriptRun(
        id,
        runner.id,
        now,
        result.exitCode === 0 ? "completed" : "failed",
        result.exitCode === 0 ? scrubSecrets(JSON.stringify(result.output ?? null)) : null,
        result.exitCode === 0
          ? null
          : scrubSecrets(result.stderr || `Guest exited with ${result.exitCode}`),
      ),
    );
    if (changed) {
      runner.jobsCompleted++;
      job.finish(result);
    }
  }
  // A repeated or stale result must not remain in the runner's retention map.
  await send(runner, { type: "ack", jobId: id });
}
export async function reconnectDurable(runner: RemoteScriptRunner, ids: string[]) {
  for (const id of ids) {
    if (held.get(id)?.ownerId === runner.id && (await owns(id, runner.id))) continue;
    await send(runner, { type: "cancel", jobId: id });
    await getStorage().repos.scripts.releaseScriptRunOwner(id, runner.id);
  }
}
export async function releaseDurableOwner(ownerId: string, runId?: string) {
  for (const run of await getStorage().repos.scripts.listActiveScriptRuns()) {
    if (run.ownerId !== ownerId || (runId && run.id !== runId)) continue;
    await getStorage().repos.scripts.releaseScriptRunOwner(run.id, ownerId);
    const job = held.get(run.id);
    if (job?.ownerId === ownerId) {
      job.session.close();
      job.finish({ exitCode: null, stderr: "", terminated: true });
    }
  }
}

export async function longLaneMetrics() {
  if (!getStorage().capabilities.scriptRunners) return { queued: 0, oldestWaitMs: 0, inFlight: 0 };
  const rows = (await getStorage().repos.scripts.listActiveScriptRuns()).filter(
    (run) => run.status === "running",
  );
  const queued = rows.filter((run) => !run.ownerId);
  return {
    queued: queued.length,
    oldestWaitMs: queued.length
      ? Math.max(...queued.map((run) => Date.now() - Date.parse(run.startedAt)))
      : 0,
    inFlight: rows.length - queued.length,
  };
}
