import { getApiKey } from "../../utils/api-key";
import type { ExecutorOutput } from "../executors/types";
import { syncQueueWaitMs } from "./capacity-config";
import { assertSerializableJob, embeddedScriptRunner } from "./embedded-runner";
import type { ScriptJob, ScriptRunnerHandle } from "./types";

let pickRemote: ((job: ScriptJob) => ScriptRunnerHandle | undefined) | undefined;
let remoteSlots: () => number = () => 0;
let embeddedInFlight = 0;
let inFlight = 0;
type Waiter = {
  job: ScriptJob;
  since: number;
  finish(output: ExecutorOutput): void;
  start(runner: ScriptRunnerHandle): void;
};
const queue: Waiter[] = [];

export function setRemoteScriptRunnerPicker(picker: typeof pickRemote, slots = () => 0) {
  pickRemote = picker;
  remoteSlots = slots;
  drainScriptQueue();
}

export function syncLaneMetrics() {
  const slots = process.env.SCRIPT_EMBEDDED_RUNNER_SLOTS;
  return {
    queued: queue.length,
    oldestWaitMs: queue.length ? Date.now() - queue[0]!.since : 0,
    inFlight,
    slots: slots === undefined ? null : Number(slots) + remoteSlots(),
  };
}

function failure(error: "killed" | "capacity_exceeded"): ExecutorOutput {
  return {
    result: undefined,
    stdout: "",
    stderr: "",
    truncated: { stdout: false, stderr: false },
    durationMs: 0,
    exitCode: 1,
    error,
    ...(error === "capacity_exceeded"
      ? {
          runtimeError: {
            name: "CapacityError",
            message: "The sync script queue wait limit expired.",
            stack: "",
            userFrames: [],
          },
        }
      : {}),
  };
}

function available(job: ScriptJob) {
  const remote = pickRemote?.(job);
  if (remote) return remote;
  const slots = process.env.SCRIPT_EMBEDDED_RUNNER_SLOTS;
  return slots === undefined || embeddedInFlight < Number(slots) ? embeddedScriptRunner : undefined;
}

export function drainScriptQueue() {
  // Preserve arrival order among jobs that a free runner can execute.
  for (let index = 0; index < queue.length; ) {
    const waiter = queue[index]!;
    const runner = available(waiter.job);
    if (runner) waiter.start(runner);
    else index++;
  }
}

export function dispatchScriptJob(
  job: ScriptJob,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ExecutorOutput> {
  if (signal?.aborted) return Promise.resolve(failure("killed"));
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const remove = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const index = queue.indexOf(waiter);
      if (index >= 0) queue.splice(index, 1);
    };
    const abort = () => {
      waiter.finish(failure("killed"));
      drainScriptQueue();
    };
    const waiter: Waiter = {
      job,
      since: Date.now(),
      finish(output) {
        remove();
        resolve(output);
      },
      start(runner) {
        remove();
        inFlight++;
        if (runner.kind === "embedded") embeddedInFlight++;
        void (async () => {
          try {
            if (runner.kind === "remote") {
              assertSerializableJob(job);
              if (job.input.configPayload.system.apiKey.value === getApiKey())
                throw new Error("Script job cannot send the operator key to a runner");
            }
            resolve(await runner.run(job, signal));
          } catch (error) {
            reject(error);
          } finally {
            inFlight--;
            if (runner.kind === "embedded") embeddedInFlight--;
            drainScriptQueue();
          }
        })();
      },
    };
    queue.push(waiter);
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      waiter.finish(failure("capacity_exceeded"));
      drainScriptQueue();
    }, syncQueueWaitMs());
    drainScriptQueue();
  });
}
